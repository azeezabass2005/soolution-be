import crypto from "crypto";
import { Types } from "mongoose";
import PaymentLink from "../models/payment-link.model";
import Transaction from "../models/transaction.model";
import TransactionDetail from "../models/transaction-details.model";
import User from "../models/user.model";
import { IPaymentLink, IUser } from "../models/interface";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { DETAIL_TYPE, TRANSACTION_STATUS } from "../common/constant";
import { USER_TIER } from "../common/tier.constants";
import {
    COUNTRY_DIAL_CODE,
    CURRENCY_COUNTRY,
    MAX_ACTIVE_PAYMENT_LINKS,
    MAX_PENDING_PAYMENTS_PER_LINK,
    PAYMENT_LINK_MOMO_ONLY,
    PAYMENT_LINK_SLUG_LENGTH,
    PAYMENT_LINK_TO_CURRENCY,
    PAYMENT_LINK_USAGE,
    PENDING_PAYMENT_WINDOW_MS,
} from "../common/payment-link.constants";
import { PayPaymentLinkInput, ZCreatePaymentLink, ZPayPaymentLink, ZUpdatePaymentLink } from "../validators/z-payment-link";
import TransactionService from "./transaction.service";
import transactionLimitService from "./transaction-limit.service";
import logger from "../utils/logger.utils";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const IN_FLIGHT = [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.PROCESSING];
const FINAL = [TRANSACTION_STATUS.COMPLETED, TRANSACTION_STATUS.FAILED, TRANSACTION_STATUS.CANCELLED];

/** Shown to payers for anything about the owner's account they shouldn't see */
const UNAVAILABLE = "This payment link can't take payments right now. Please contact the person who sent it.";

const badRequest = (message: string, details?: unknown) =>
    errorResponseMessage.createError(400, message, ErrorSeverity.LOW, details);

const parse = <T>(schema: { safeParse: (v: unknown) => any }, body: unknown): T => {
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue: any) => ({ path: issue.path.join("."), message: issue.message }));
        throw badRequest(issues[0].message, { issues });
    }
    return parsed.data as T;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Rejection-sampled base62, so every character is equally likely */
const generateSlug = () => {
    let out = "";
    while (out.length < PAYMENT_LINK_SLUG_LENGTH) {
        for (const byte of crypto.randomBytes(PAYMENT_LINK_SLUG_LENGTH)) {
            if (byte < 248) out += BASE62[byte % 62];
            if (out.length === PAYMENT_LINK_SLUG_LENGTH) break;
        }
    }
    return out;
};

/** "+254712345678" for YellowCard */
const toIntl = (phone: string, country: string) => {
    if (!phone) return phone;
    const p = phone.trim().replace(/\s+/g, "");
    if (p.startsWith("+")) return p;
    const dial = COUNTRY_DIAL_CODE[country] || "";
    const digits = dial.replace("+", "");
    if (digits && p.startsWith(digits) && p.length > digits.length + 6) return `+${p}`;
    return dial ? `${dial}${p.startsWith("0") ? p.slice(1) : p}` : p;
};

/** "0241234567" for OGateway */
const toLocal = (phone: string, country: string) => {
    const digits = (COUNTRY_DIAL_CODE[country] || "").replace("+", "");
    let p = phone.trim().replace(/\s+/g, "");
    if (p.startsWith("+")) p = p.slice(1);
    if (digits && p.startsWith(digits)) p = p.slice(digits.length);
    return p.startsWith("0") ? p : `0${p}`;
};

/** OGateway takes network codes, the form sends provider names */
const toOgatewayNetwork = (provider: string) => {
    const p = (provider || "").toLowerCase();
    if (p.includes("mtn")) return "MTN";
    if (p.includes("telecel") || p.includes("vodafone") || p.includes("vod")) return "VOD";
    if (p.includes("airteltigo") || p.includes("tigo") || p.includes("airtel") || p.includes("atm")) return "ATM";
    return (provider || "").toUpperCase();
};

const ownerName = (user: Pick<IUser, "firstName" | "lastName">) => `${user.firstName || ""} ${user.lastName || ""}`.trim();

class PaymentLinkService {
    private transactionService = new TransactionService(["details", "user"]);

    // ─────────────── Owner ───────────────

    async create(userId: string, body: unknown) {
        // Same rule as receiving directly: verify your BVN first
        await transactionLimitService.assertCanTransact(userId);
        const data = parse<{ currency: string; amount?: number; title?: string; description?: string; usage: "single" | "reusable" }>(ZCreatePaymentLink, body);

        const active = await PaymentLink.countDocuments({ user: new Types.ObjectId(userId), active: true });
        if (active >= MAX_ACTIVE_PAYMENT_LINKS) {
            throw badRequest(`You can have up to ${MAX_ACTIVE_PAYMENT_LINKS} active payment links. Turn off one you no longer use first.`);
        }

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const link = await PaymentLink.create({
                    user: userId,
                    slug: generateSlug(),
                    currency: data.currency,
                    toCurrency: PAYMENT_LINK_TO_CURRENCY,
                    amount: data.amount !== undefined ? round2(data.amount) : undefined,
                    // Older clients send the note as "description"; it becomes the title
                    title: data.title || data.description,
                    usage: data.usage,
                });
                return this.toOwnerView(link.toObject(), { paid: 0, totalPaid: 0 });
            } catch (error: any) {
                // A slug collision is astronomically unlikely; retry rather than fail
                if (error?.code !== 11000) throw error;
            }
        }
        throw errorResponseMessage.createError(500, "Couldn't create the link. Please try again.", ErrorSeverity.MEDIUM);
    }

    async list(userId: string) {
        const links = await PaymentLink.find({ user: new Types.ObjectId(userId) }).sort({ createdAt: -1 }).limit(100).lean();
        if (links.length === 0) return [];
        const stats = await Transaction.aggregate([
            { $match: { paymentLink: { $in: links.map((l) => l._id) }, status: TRANSACTION_STATUS.COMPLETED } },
            { $group: { _id: "$paymentLink", paid: { $sum: 1 }, totalPaid: { $sum: "$amount" } } },
        ]);
        const byLink = new Map(stats.map((s) => [String(s._id), s]));
        return links.map((link) => {
            const s = byLink.get(String(link._id));
            return this.toOwnerView(link, { paid: s?.paid || 0, totalPaid: round2(s?.totalPaid || 0) });
        });
    }

    async update(userId: string, id: string, body: unknown) {
        if (!Types.ObjectId.isValid(id)) throw errorResponseMessage.resourceNotFound("Payment link");
        const { active } = parse<{ active: boolean }>(ZUpdatePaymentLink, body);
        if (active) {
            await transactionLimitService.assertCanTransact(userId);
            const existing = await PaymentLink.findOne({ _id: id, user: new Types.ObjectId(userId) }).lean();
            if (existing && (await this.isUsedUp(existing))) {
                throw errorResponseMessage.createError(409, "This single-use link has already been paid. Create a new link instead.", ErrorSeverity.LOW);
            }
        }
        const link = await PaymentLink.findOneAndUpdate(
            { _id: id, user: new Types.ObjectId(userId) },
            { $set: { active } },
            { new: true },
        ).lean();
        if (!link) throw errorResponseMessage.resourceNotFound("Payment link");
        const [stats] = await Transaction.aggregate([
            { $match: { paymentLink: link._id, status: TRANSACTION_STATUS.COMPLETED } },
            { $group: { _id: null, paid: { $sum: 1 }, totalPaid: { $sum: "$amount" } } },
        ]);
        return this.toOwnerView(link, { paid: stats?.paid || 0, totalPaid: round2(stats?.totalPaid || 0) });
    }

    /** A single-use link that has a completed payment */
    private async isUsedUp(link: Pick<IPaymentLink, "usage"> & { _id: any }) {
        if (link.usage !== PAYMENT_LINK_USAGE.SINGLE) return false;
        return !!(await Transaction.exists({ paymentLink: link._id, status: TRANSACTION_STATUS.COMPLETED }));
    }

    private toOwnerView(link: any, stats: { paid: number; totalPaid: number }) {
        return {
            id: String(link._id),
            slug: link.slug,
            currency: link.currency,
            toCurrency: link.toCurrency,
            amount: link.amount ?? null,
            title: link.title || link.description || null,
            active: link.active,
            usage: link.usage || PAYMENT_LINK_USAGE.REUSABLE,
            /** "used": a single-use link that has been paid */
            status: link.usage === PAYMENT_LINK_USAGE.SINGLE && stats.paid > 0 ? "used" : link.active ? "active" : "off",
            createdAt: link.createdAt,
            paymentsCount: stats.paid,
            totalPaid: stats.totalPaid,
        };
    }

    // ─────────────── Public (the payer) ───────────────

    /** The link plus its owner, or a 404 that doesn't say whether the slug ever existed */
    private async findPayable(slug: string) {
        if (typeof slug !== "string" || !/^[0-9A-Za-z]{6,32}$/.test(slug)) throw errorResponseMessage.resourceNotFound("Payment link");
        const link = await PaymentLink.findOne({ slug });
        if (!link) throw errorResponseMessage.resourceNotFound("Payment link");
        const owner = await User.findById(link.user).select("firstName lastName email phoneNumber tier status").lean<IUser>();
        if (!owner) throw errorResponseMessage.resourceNotFound("Payment link");
        return { link, owner };
    }

    private canTakePayments(link: IPaymentLink, owner: IUser) {
        return link.active && owner.status === "active" && (owner.tier ?? USER_TIER.UNVERIFIED) >= USER_TIER.INDIVIDUAL;
    }

    /** What the payer sees. Only the owner's name; nothing else about their account. */
    async getPublic(slug: string) {
        const { link, owner } = await this.findPayable(slug);
        const used = await this.isUsedUp(link);
        return {
            slug: link.slug,
            payee: ownerName(owner),
            currency: link.currency,
            amount: link.amount ?? null,
            title: link.title || link.description || null,
            methods: PAYMENT_LINK_MOMO_ONLY.includes(link.currency) ? ["momo"] : ["momo", "bank"],
            usage: link.usage || PAYMENT_LINK_USAGE.REUSABLE,
            available: !used && this.canTakePayments(link, owner),
            /** Why it can't be paid, so the page can say so */
            unavailableReason: used ? "used" : !link.active ? "off" : this.canTakePayments(link, owner) ? null : "unavailable",
        };
    }

    /** The payer submits their details; starts the collection under the owner's account */
    async pay(slug: string, body: unknown) {
        const { link, owner } = await this.findPayable(slug);
        if (!this.canTakePayments(link, owner)) {
            throw errorResponseMessage.createError(409, link.active ? UNAVAILABLE : "This payment link has been turned off.", ErrorSeverity.LOW, { code: "PAYMENT_LINK_UNAVAILABLE" });
        }
        const input = parse<PayPaymentLinkInput>(ZPayPaymentLink, body);
        if (await this.isUsedUp(link)) {
            throw errorResponseMessage.createError(409, "This payment link has already been paid.", ErrorSeverity.LOW, { code: "PAYMENT_LINK_USED" });
        }

        const amount = link.amount ?? input.amount;
        if (!amount) throw badRequest("Enter the amount you're paying", { issues: [{ path: "amount", message: "Enter an amount" }] });
        if (input.method === "bank" && PAYMENT_LINK_MOMO_ONLY.includes(link.currency)) {
            throw badRequest(`${link.currency} payments are by mobile money only`, { issues: [{ path: "method", message: "Pay by mobile money" }] });
        }

        const userId = String(owner._id);
        return transactionLimitService.withUserLock(userId, async () => {
            const pending = await Transaction.countDocuments({
                paymentLink: link._id,
                status: { $in: IN_FLIGHT },
                createdAt: { $gte: new Date(Date.now() - PENDING_PAYMENT_WINDOW_MS) },
            });
            // A single-use link takes one payment at a time
            if (link.usage === PAYMENT_LINK_USAGE.SINGLE && pending > 0) {
                throw errorResponseMessage.createError(409, "A payment on this link is already in progress. If it fails, you can try again.", ErrorSeverity.LOW, { code: "PAYMENT_LINK_IN_PROGRESS" });
            }
            if (pending >= MAX_PENDING_PAYMENTS_PER_LINK) {
                throw errorResponseMessage.createError(429, "A few payments on this link are still being processed. Please try again in a few minutes.", ErrorSeverity.LOW);
            }

            // The payer shouldn't see the owner's limits; fail with a neutral message
            const limit = await transactionLimitService.check(userId, [{ amount, currency: link.currency }]);
            if (!limit.allowed && limit.reason !== "unvalued") {
                logger.info("Payment link payment refused by owner's limit", { linkId: String(link._id), reason: limit.reason });
                throw errorResponseMessage.createError(409, UNAVAILABLE, ErrorSeverity.LOW, { code: "PAYMENT_LINK_UNAVAILABLE" });
            }

            const transaction = await this.startCollection(link, owner, input, amount);
            return this.toPublicPayment(transaction, link);
        });
    }

    private async startCollection(link: IPaymentLink, owner: IUser, input: PayPaymentLinkInput, amount: number) {
        const country = CURRENCY_COUNTRY[link.currency];
        const paymentLinkId = String(link._id);
        const payer = { name: input.method === "momo" ? input.momoName : input.accountName, email: input.email };

        if (link.currency === "GHS") {
            return this.transactionService.createOGatewayCollectionTransaction({
                amount,
                fromCurrency: "GHS",
                toCurrency: "NGN",
                sender: {
                    accountName: input.momoName!,
                    accountNumber: toLocal(input.momoNumber!, country),
                    network: toOgatewayNetwork(input.momoNetwork!),
                    email: input.email || owner.email || undefined,
                },
                paymentLinkId,
                payer,
            }, String(owner._id));
        }

        const isMomo = input.method === "momo";
        // Same shape as the dashboard's receive form: the owner is the YellowCard
        // "sender" record and the payer's wallet or bank is the destination.
        return this.transactionService.createYellowCardCollectionTransaction({
            amount,
            fromCurrency: link.currency,
            toCurrency: PAYMENT_LINK_TO_CURRENCY,
            sender: {
                name: ownerName(owner) || "User",
                country,
                phone: toIntl(owner.phoneNumber || "", country),
                address: "N/A",
                dob: "1990-01-01",
                email: owner.email || "",
            },
            destination: {
                accountName: isMomo ? input.momoName : input.accountName,
                accountNumber: isMomo ? toIntl(input.momoNumber!, country) : input.accountNumber,
                accountType: isMomo ? "momo" : "bank",
                country,
                network: isMomo ? input.momoNetwork : (input.bankCode || input.bankName),
                ...(isMomo ? {} : { bankName: input.bankName }),
            },
            paymentLinkId,
            payer,
        }, String(owner._id));
    }

    /** The payer checks on their payment. Syncs with the provider while it's still open. */
    async paymentStatus(slug: string, reference: string) {
        const { link } = await this.findPayable(slug);
        if (typeof reference !== "string" || reference.length > 100) throw errorResponseMessage.resourceNotFound("Payment");
        const transaction = await Transaction.findOne({ reference, paymentLink: link._id });
        if (!transaction) throw errorResponseMessage.resourceNotFound("Payment");

        if (!FINAL.includes(transaction.status as string)) {
            try {
                if (transaction.detailType === DETAIL_TYPE.OGATEWAY) {
                    await this.transactionService.pollOGatewayStatus(String(transaction._id));
                } else if (transaction.detailType === DETAIL_TYPE.YELLOWCARD) {
                    await this.transactionService.pollYellowCardCollectionStatus(String(transaction._id));
                }
            } catch (error: any) {
                // Keep reporting the last known status; the webhook will catch up
                logger.warn("Payment link status sync failed", { reference, error: error?.message });
            }
        }
        const fresh = (await Transaction.findById(transaction._id)) || transaction;
        const payment = this.toPublicPayment(fresh, link);
        if (payment.status !== "completed") return payment;
        return { ...payment, receipt: await this.payerReceipt(fresh) };
    }

    /**
     * What the payer's downloadable receipt shows. Payers forward it to the
     * link's owner as proof, so the account number is masked and nothing of
     * the owner's side (NGN credited, fee, wallet) is included.
     */
    private async payerReceipt(transaction: any) {
        const detail: any = await TransactionDetail.findOne({ transactionId: transaction._id }).lean();
        const account = String(detail?.momoNumber || detail?.accountNumber || "");
        return {
            payerName: transaction.payer?.name || detail?.momoName || detail?.accountName || null,
            method: detail?.institutionType === "bank" ? "bank" : "momo",
            provider: detail?.bankName || detail?.momoNetwork || detail?.ogNetwork || null,
            account: account.length > 5 ? `${account.slice(0, 3)}${"*".repeat(Math.max(3, account.length - 6))}${account.slice(-3)}` : null,
            completedAt: transaction.completedAt || transaction.updatedAt || null,
        };
    }

    /** Allow-listed: the payer never sees the owner's NGN amount, fee or account */
    private toPublicPayment(transaction: any, link: IPaymentLink) {
        const status = String(transaction.status);
        return {
            reference: transaction.reference,
            amount: transaction.amount,
            currency: link.currency,
            status: status === TRANSACTION_STATUS.COMPLETED ? "completed"
                : FINAL.includes(status) ? "failed"
                : "processing",
            createdAt: transaction.createdAt,
        };
    }
}

export default new PaymentLinkService();
