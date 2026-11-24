import crypto from "crypto";
import paymentLinkRepository from "../repositories/payment-link.repository";
import transactionRepository from "../repositories/transaction.repository";
import transactionDetailRepository from "../repositories/transaction-detail.repository";
import userRepository from "../repositories/user.repository";
import { isUniqueViolation } from "../db/errors";
import type { PaymentLink as IPaymentLink, User as IUser, Transaction } from "../types/entities";
import type { PaymentLinkCollectField, TransactionStatus } from "../types/enums";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { DETAIL_TYPE, TRANSACTION_STATUS } from "../common/constant";
import { USER_TIER } from "../common/tier.constants";
import {
    COUNTRY_DIAL_CODE,
    CURRENCY_COUNTRY,
    MULTI_COUNTRY_CURRENCIES,
    ycCountryFor,
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
import identityService from "./identity.service";
import yellowCardService from "./yellowcard.service";
import { TRANSFER_DETAILS_REQUIRED_CODE } from "../common/identity.constants";
import logger from "../utils/logger.utils";
import config from "../config/env.config";
import ghsRateService from "./ghs-rate.service";
import { approvedBusinessName } from "./business-name.service";
import { limitProblem } from "../common/pricing";
import platformSettingsService from "./platform-settings.service";
import { pausedError } from "../middlewares/operations.middleware";
import fincraService from "./fincra.service";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const IN_FLIGHT = [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.PROCESSING] as TransactionStatus[];
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

/** The owner's address with the payment's reference and status added, so their site can match it up */
const withPaymentResult = (address: string, reference: string) => {
    try {
        const url = new URL(address);
        url.searchParams.set("reference", reference);
        url.searchParams.set("status", "completed");
        return url.toString();
    } catch {
        return address;
    }
};

const ownerName = (user: Pick<IUser, "firstName" | "lastName">) => `${user.firstName || ""} ${user.lastName || ""}`.trim();

class PaymentLinkService {
    private transactionService = new TransactionService();

    // ─────────────── Owner ───────────────

    async create(userId: string, body: unknown) {
        // Same rule as receiving directly: verify your BVN first
        await transactionLimitService.assertCanTransact(userId);
        const data = parse<{ currency: string; country?: string; amount?: number; title?: string; description?: string; usage: "single" | "reusable"; redirectUrl?: string; collect: PaymentLinkCollectField[] }>(ZCreatePaymentLink, body);
        // YellowCard collects every currency except GHS and needs the owner's KYC details
        if (data.currency !== "GHS") await identityService.assertTransferDetails(userId);
        // Fincra's GHS checkout takes whole cedis
        if (data.currency === "GHS" && data.amount !== undefined && !Number.isInteger(data.amount)) {
            throw badRequest("GHS links are in whole cedis. Enter an amount without pesewas.", { issues: [{ path: "amount", message: "Use a whole number" }] });
        }
        if (data.currency === "GHS" && data.amount !== undefined) {
            const problem = limitProblem(await ghsRateService.limits("receive"), data.amount, "GHS");
            if (problem) throw badRequest(problem, { issues: [{ path: "amount", message: problem }] });
        }

        const active = await paymentLinkRepository.countActive(userId);
        if (active >= MAX_ACTIVE_PAYMENT_LINKS) {
            throw badRequest(`You can have up to ${MAX_ACTIVE_PAYMENT_LINKS} active payment links. Turn off one you no longer use first.`);
        }

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const link = await paymentLinkRepository.create({
                    user: userId,
                    slug: generateSlug(),
                    currency: data.currency,
                    // Kept only for the CFA francs, and only a country that uses the currency
                    country: MULTI_COUNTRY_CURRENCIES[data.currency] ? ycCountryFor(data.currency, data.country) : undefined,
                    toCurrency: PAYMENT_LINK_TO_CURRENCY,
                    amount: data.amount !== undefined ? round2(data.amount) : undefined,
                    // Older clients send the note as "description"; it becomes the title
                    title: data.title || data.description,
                    usage: data.usage,
                    redirectUrl: data.redirectUrl,
                    collectFields: data.collect,
                });
                return this.toOwnerView(link, { paid: 0, totalPaid: 0 });
            } catch (error: any) {
                // A slug collision is astronomically unlikely; retry rather than fail
                if (!isUniqueViolation(error, "payment_links_slug_key")) throw error;
            }
        }
        throw errorResponseMessage.createError(500, "Couldn't create the link. Please try again.", ErrorSeverity.MEDIUM);
    }

    async list(userId: string) {
        const links = await paymentLinkRepository.listForUser(userId, 100);
        if (links.length === 0) return [];
        const byLink = await transactionRepository.paymentLinkStats(links.map((l) => l.id));
        return links.map((link) => {
            const s = byLink.get(link.id);
            return this.toOwnerView(link, { paid: s?.paid || 0, totalPaid: round2(s?.totalPaid || 0) });
        });
    }

    async update(userId: string, id: string, body: unknown) {
        const { active } = parse<{ active: boolean }>(ZUpdatePaymentLink, body);
        if (active) {
            await transactionLimitService.assertCanTransact(userId);
            const existing = await paymentLinkRepository.findOwned(id, userId);
            if (existing && (await this.isUsedUp(existing))) {
                throw errorResponseMessage.createError(409, "This single-use link has already been paid. Create a new link instead.", ErrorSeverity.LOW);
            }
        }
        const link = await paymentLinkRepository.setActive(id, userId, active);
        if (!link) throw errorResponseMessage.resourceNotFound("Payment link");
        const stats = (await transactionRepository.paymentLinkStats([link.id])).get(link.id);
        return this.toOwnerView(link, { paid: stats?.paid || 0, totalPaid: round2(stats?.totalPaid || 0) });
    }

    /** A single-use link that has a completed payment */
    private async isUsedUp(link: Pick<IPaymentLink, "usage" | "id">) {
        if (link.usage !== PAYMENT_LINK_USAGE.SINGLE) return false;
        return transactionRepository.hasCompletedPaymentForLink(link.id);
    }

    private toOwnerView(link: IPaymentLink, stats: { paid: number; totalPaid: number }) {
        return {
            id: link.id,
            slug: link.slug,
            currency: link.currency,
            country: link.country ?? null,
            toCurrency: link.toCurrency,
            amount: link.amount ?? null,
            title: link.title || link.description || null,
            active: link.active,
            usage: link.usage || PAYMENT_LINK_USAGE.REUSABLE,
            redirectUrl: link.redirectUrl ?? null,
            collect: link.collectFields ?? [],
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
        const link = await paymentLinkRepository.findBySlug(slug);
        if (!link) throw errorResponseMessage.resourceNotFound("Payment link");
        const owner = await userRepository.findById(link.user);
        if (!owner) throw errorResponseMessage.resourceNotFound("Payment link");
        return { link, owner };
    }

    private canTakePayments(link: IPaymentLink, owner: IUser) {
        // A frozen account takes nothing in (its links are off while it's on hold)
        return link.active && owner.status === "active" && (owner.freeze ?? "none") !== "account" && (owner.tier ?? USER_TIER.UNVERIFIED) >= USER_TIER.INDIVIDUAL;
    }

    /** What the payer sees. Only the owner's name; nothing else about their account. */
    async getPublic(slug: string) {
        const { link, owner } = await this.findPayable(slug);
        const used = await this.isUsedUp(link);
        const methods = await this.payMethods(link.currency, link.country);
        // No way to pay in this currency right now (e.g. YellowCard has collections off)
        const paused = (await platformSettingsService.getOperations()).pause.payments;
        const payable = !paused && this.canTakePayments(link, owner) && methods.length > 0;
        return {
            slug: link.slug,
            payee: (owner.tier >= USER_TIER.BUSINESS ? await approvedBusinessName(owner.id) : undefined) || ownerName(owner),
            currency: link.currency,
            /** The payer's country (e.g. CI for XOF in Côte d'Ivoire) */
            country: ycCountryFor(link.currency, link.country) ?? null,
            amount: link.amount ?? null,
            title: link.title || link.description || null,
            methods,
            usage: link.usage || PAYMENT_LINK_USAGE.REUSABLE,
            /** Details the payer must give */
            collect: link.collectFields ?? [],
            /** Whether the payer is sent back to the owner's site after paying */
            redirects: !!link.redirectUrl,
            available: !used && payable,
            /** Why it can't be paid, so the page can say so */
            unavailableReason: used ? "used" : !link.active ? "off" : paused ? "paused" : payable ? null : "unavailable",
            /** The per-payment minimum and maximum (0 = none), so a payer typing the amount knows the range */
            limits: link.currency === "GHS" ? await ghsRateService.limits("receive") : { min: 0, max: 0 },
        };
    }

    /**
     * How a payer can pay in this currency. YellowCard currencies follow its
     * country config (the channel types it can collect through right now);
     * GHS goes through Fincra's checkout, mobile money only. Falls back to our own list
     * if YellowCard can't be reached, so the page still loads.
     */
    private async payMethods(currency: string, linkCountry?: string | null): Promise<("momo" | "bank")[]> {
        const fallback: ("momo" | "bank")[] = PAYMENT_LINK_MOMO_ONLY.includes(currency) ? ["momo"] : ["momo", "bank"];
        if (currency === "GHS" || !CURRENCY_COUNTRY[currency]) return fallback;
        try {
            const config = await yellowCardService.getCountryConfig(ycCountryFor(currency, linkCountry), currency);
            if (!config.receive) return [];
            // Mobile money first, as payers mostly use it
            return (["momo", "bank"] as const).filter((type) => config.channelTypes.includes(type));
        } catch {
            return fallback;
        }
    }

    /** The payer submits their details; starts the collection under the owner's account */
    async pay(slug: string, body: unknown) {
        const { link, owner } = await this.findPayable(slug);
        const { pause } = await platformSettingsService.getOperations();
        if (pause.payments) throw pausedError(pause.message);
        if (!this.canTakePayments(link, owner)) {
            throw errorResponseMessage.createError(409, link.active ? UNAVAILABLE : "This payment link has been turned off.", ErrorSeverity.LOW, { code: "PAYMENT_LINK_UNAVAILABLE" });
        }
        const input = parse<PayPaymentLinkInput>(ZPayPaymentLink, body);
        // The details the owner asked for
        const wanted = link.collectFields ?? [];
        const missing: Array<{ path: string; message: string }> = [];
        if (wanted.includes("name") && !input.payerName) missing.push({ path: "payerName", message: "Enter your full name" });
        if (wanted.includes("email") && !input.email) missing.push({ path: "email", message: "Enter your email address" });
        if (wanted.includes("phone") && !input.payerPhone) missing.push({ path: "payerPhone", message: "Enter your phone number" });
        if (missing.length) throw badRequest(missing[0].message, { issues: missing });
        if (await this.isUsedUp(link)) {
            throw errorResponseMessage.createError(409, "This payment link has already been paid.", ErrorSeverity.LOW, { code: "PAYMENT_LINK_USED" });
        }

        const amount = link.amount ?? input.amount;
        if (!amount) throw badRequest("Enter the amount you're paying", { issues: [{ path: "amount", message: "Enter an amount" }] });
        // The per-payment range applies to whoever typed the amount; a payer can be told it
        if (link.currency === "GHS" && !link.amount) {
            const problem = limitProblem(await ghsRateService.limits("receive"), amount, "GHS");
            if (problem) throw badRequest(problem.replace("you can do in one transaction", "this link accepts in one payment"), { issues: [{ path: "amount", message: problem }] });
        }
        if (input.method === "bank" && PAYMENT_LINK_MOMO_ONLY.includes(link.currency)) {
            throw badRequest(`${link.currency} payments are by mobile money only`, { issues: [{ path: "method", message: "Pay by mobile money" }] });
        }

        const userId = owner.id;
        return transactionLimitService.withUserLock(userId, async () => {
            const pending = await transactionRepository.countForLink(link.id, IN_FLIGHT, new Date(Date.now() - PENDING_PAYMENT_WINDOW_MS));
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
                logger.info("Payment link payment refused by owner's limit", { linkId: link.id, reason: limit.reason });
                throw errorResponseMessage.createError(409, UNAVAILABLE, ErrorSeverity.LOW, { code: "PAYMENT_LINK_UNAVAILABLE" });
            }

            let transaction;
            try {
                transaction = await this.startCollection(link, owner, input, amount);
            } catch (error: any) {
                // The owner's missing details are theirs to fix; the payer just can't pay yet
                if (error?.details?.code !== TRANSFER_DETAILS_REQUIRED_CODE) throw error;
                logger.warn("Payment link payment refused: owner's transfer details are missing", { linkId: link.id });
                throw errorResponseMessage.createError(409, UNAVAILABLE, ErrorSeverity.LOW, { code: "PAYMENT_LINK_UNAVAILABLE" });
            }
            return this.toPublicPayment(transaction, link);
        });
    }

    private async startCollection(link: IPaymentLink, owner: IUser, input: PayPaymentLinkInput, amount: number) {
        const country = ycCountryFor(link.currency, link.country);
        const paymentLinkId = link.id;
        const payer = {
            name: input.payerName || (input.method === "momo" ? input.momoName : input.accountName),
            email: input.email,
            phone: input.payerPhone,
        };

        if (link.currency === "GHS") {
            // Fincra's checkout page takes the payment; the payer comes back here after
            return this.transactionService.createGhsCollectionTransaction({
                amount,
                fromCurrency: "GHS",
                toCurrency: "NGN",
                sender: {
                    accountName: input.momoName || undefined,
                    accountNumber: input.momoNumber ? toLocal(input.momoNumber, country) : undefined,
                    network: input.momoNetwork ? toOgatewayNetwork(input.momoNetwork) : undefined,
                    email: input.email || undefined,
                },
                paymentLinkId,
                payer,
                redirectUrl: `${config.FRONTEND_URL}/pay/${encodeURIComponent(link.slug)}`,
            }, owner.id);
        }

        const isMomo = input.method === "momo";
        // Same as the dashboard's receive form: the owner is YellowCard's KYC
        // recipient and the payer's wallet or bank is the destination.
        return this.transactionService.createYellowCardCollectionTransaction({
            amount,
            fromCurrency: link.currency,
            toCurrency: PAYMENT_LINK_TO_CURRENCY,
            // Where the payer pays from; the KYC recipient is the owner, from their record
            sender: { country },
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
        }, owner.id);
    }

    /** The payer checks on their payment. Syncs with the provider while it's still open. */
    async paymentStatus(slug: string, reference: string) {
        const { link } = await this.findPayable(slug);
        if (typeof reference !== "string" || reference.length > 100) throw errorResponseMessage.resourceNotFound("Payment");
        const transaction = await transactionRepository.findByReference(reference, link.id);
        if (!transaction) throw errorResponseMessage.resourceNotFound("Payment");

        if (!FINAL.includes(transaction.status as string)) {
            try {
                if (transaction.detailType === DETAIL_TYPE.FINCRA) {
                    await this.transactionService.pollGhsStatus(transaction.id);
                } else if (transaction.detailType === DETAIL_TYPE.YELLOWCARD) {
                    await this.transactionService.pollYellowCardCollectionStatus(transaction.id);
                }
            } catch (error: any) {
                // Keep reporting the last known status; the webhook will catch up
                logger.warn("Payment link status sync failed", { reference, error: error?.message });
            }
        }
        const fresh = (await transactionRepository.findById(transaction.id)) || transaction;
        const payment = this.toPublicPayment(fresh, link);
        if (payment.status !== "completed") return payment;
        return { ...payment, receipt: await this.payerReceipt(fresh), ...(link.redirectUrl ? { redirectUrl: withPaymentResult(link.redirectUrl, fresh.reference) } : {}) };
    }

    /**
     * What the payer's downloadable receipt shows. Payers forward it to the
     * link's owner as proof, so the account number is masked and nothing of
     * the owner's side (NGN credited, fee, wallet) is included.
     */
    private async payerReceipt(transaction: Transaction) {
        const detail = await transactionDetailRepository.findByTransactionId(transaction.id);
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
            /** GHS: where the payer completes the payment (Fincra's page) */
            ...(transaction.checkoutUrl || transaction.details?.checkoutUrl
                ? { checkoutUrl: transaction.checkoutUrl || transaction.details?.checkoutUrl }
                : {}),
            /** A direct charge: the payer approves on their phone (or with a code) on our page */
            ...(transaction.approval ? { approval: transaction.approval } : {}),
        };
    }

    /** The code a payer received, for a direct charge that asks for one */
    async authorizePayment(slug: string, reference: string, otp: unknown) {
        const { link } = await this.findPayable(slug);
        const code = String(otp ?? "").trim();
        if (!/^\d{4,8}$/.test(code)) throw badRequest("Enter the code sent to your phone", { issues: [{ path: "otp", message: "Enter the code" }] });
        const transaction = typeof reference === "string" && reference.length <= 100 ? await transactionRepository.findByReference(reference, link.id) : undefined;
        if (!transaction) throw errorResponseMessage.resourceNotFound("Payment");
        const detail = await transactionDetailRepository.findByTransactionId(transaction.id);
        if (!detail?.providerId || (detail.providerPayload as any)?.directCharge !== true) throw badRequest("This payment doesn't need a code");
        try {
            await fincraService.authorizeCharge(detail.providerId, code);
        } catch (error: any) {
            logger.warn("Direct charge OTP refused", { reference, error: error?.message });
            throw badRequest("That code didn't work. Check it and try again.", { issues: [{ path: "otp", message: "Check the code" }] });
        }
        return this.paymentStatus(slug, reference);
    }
}

export default new PaymentLinkService();
