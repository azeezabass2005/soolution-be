import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import config from "../config/env.config";
import logger from "../utils/logger.utils";

/**
 * Fincra client: the platform's NGN and GHS rail.
 *
 *   - NGN virtual accounts (one per user) take deposits into the NGN wallet
 *   - payouts: NGN to Nigerian banks (withdrawals) and NGN→GHS to Ghana
 *     mobile money or banks (sends), priced by a quote
 *   - checkout payment links take GHS from payers (receives)
 *   - quotes price NGN↔GHS for the rates users see
 *
 * Every payout carries our own reference as `customerReference`, which Fincra
 * refuses to reuse, so a retried request can't pay twice.
 *
 * Auth: `api-key: <secret key>`. Some endpoints also need `x-business-id`.
 * Docs: https://docs.fincra.com/docs/authentication
 */

export const FINCRA_CHECKOUT_CURRENCIES = ["GHS", "NGN"] as const;
export type FincraCheckoutCurrency = (typeof FINCRA_CHECKOUT_CURRENCIES)[number];
/** Methods a payer can use, per currency (GHS has no cards) */
export const FINCRA_CHECKOUT_METHODS: Record<FincraCheckoutCurrency, string[]> = {
    GHS: ["mobile_money", "bank_transfer"],
    NGN: ["bank_transfer", "card"],
};
/** Statuses after which a checkout won't change */
export const FINCRA_CHECKOUT_FINAL = new Set(["success", "successful", "failed", "expired"]);

export const FINCRA_VA_CHANNELS = ["globus", "wema", "habari", "sterling", "moniepoint", "uba", "opay"] as const;

/** Ghana mobile money networks as our forms name them (OGateway-era codes) */
export const GHS_MOMO_NETWORKS = [
    { code: "MTN", name: "MTN Mobile Money" },
    { code: "VOD", name: "Telecel Cash (Vodafone)" },
    { code: "ATM", name: "AirtelTigo Money" },
] as const;

export type PayoutDestination = "bank_account" | "mobile_money_wallet";

export interface FincraBank {
    code: string;
    name: string;
    swiftCode?: string;
    isMobileVerified?: boolean;
}

const BASE_URLS = {
    sandbox: "https://sandboxapi.fincra.com",
    live: "https://api.fincra.com",
};

export class FincraError extends Error {
    constructor(message: string, public status: number, public fincra?: any) {
        super(message);
    }
}

/** BVNs never leave this service unmasked, and never reach the logs */
const maskBvn = (value: unknown) => (typeof value === "string" && value.length >= 4 ? `*******${value.slice(-4)}` : value);
const maskDeep = (value: any): any => {
    if (Array.isArray(value)) return value.map(maskDeep);
    if (!value || typeof value !== "object") return value;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = /bvn/i.test(k) && typeof v === "string" ? maskBvn(v) : maskDeep(v);
    return out;
};

/** List endpoints answer in a few shapes; take the array wherever it is */
const rows = (data: any): any[] => {
    if (Array.isArray(data)) return data;
    for (const key of ["results", "docs", "data", "items"]) if (Array.isArray(data?.[key])) return data[key];
    return [];
};

const num = (value: unknown) => {
    const n = typeof value === "string" ? parseFloat(value) : typeof value === "number" ? value : NaN;
    return isFinite(n) ? n : NaN;
};

/**
 * NGN per GHS from a quote, from its two amounts where it has them (the rate
 * field's direction isn't documented). GHS is worth tens of naira or more, so
 * a figure below 1 is GHS per NGN and is inverted.
 */
export function toNgnPerGhs(quote: { rate?: unknown; sourceAmount?: unknown; destinationAmount?: unknown; sourceCurrency?: string }): number {
    const source = num(quote.sourceAmount);
    const destination = num(quote.destinationAmount);
    let value = NaN;
    if (source > 0 && destination > 0) value = quote.sourceCurrency === "GHS" ? destination / source : source / destination;
    if (!(value > 0)) value = num(quote.rate);
    if (!(value > 0)) return NaN;
    return value < 1 ? 1 / value : value;
}

class FincraService {
    private client: AxiosInstance;
    private businessId: string | null = config.FINCRA_BUSINESS_ID || null;
    /** One account request at a time per BVN, so a double click can't open two */
    private creating = new Set<string>();

    constructor() {
        this.client = axios.create({
            baseURL: BASE_URLS[config.FINCRA_ENV],
            timeout: 30000,
            headers: { Accept: "application/json", "Content-Type": "application/json" },
        });
    }

    get environment() {
        return config.FINCRA_ENV;
    }

    get configured() {
        return !!config.FINCRA_SECRET_KEY;
    }

    get checkoutConfigured() {
        return !!config.FINCRA_PUBLIC_KEY;
    }

    private async request<T = any>(method: "get" | "post", path: string, { body, params, withBusiness = false, withPublicKey = false }: { body?: any; params?: any; withBusiness?: boolean; withPublicKey?: boolean } = {}): Promise<T> {
        if (!config.FINCRA_SECRET_KEY) throw new FincraError("FINCRA_SECRET_KEY is not set", 503);
        // The public key can't authenticate server calls; Fincra just answers 401
        if (config.FINCRA_SECRET_KEY.startsWith("pk_")) {
            throw new FincraError("FINCRA_SECRET_KEY is the public key (pk_…). Use the secret key from the same Fincra dashboard page.", 400);
        }
        const headers: Record<string, string> = { "api-key": config.FINCRA_SECRET_KEY };
        if (withPublicKey) {
            if (!config.FINCRA_PUBLIC_KEY) throw new FincraError("FINCRA_PUBLIC_KEY is not set; payment links need it", 503);
            if (!config.FINCRA_PUBLIC_KEY.startsWith("pk_")) throw new FincraError("FINCRA_PUBLIC_KEY should be the public key (pk_…)", 400);
            headers["x-pub-key"] = config.FINCRA_PUBLIC_KEY;
        }
        if (withBusiness) headers["x-business-id"] = await this.getBusinessId();
        try {
            const response = await this.client.request({ method, url: path, data: body, params, headers });
            return response.data;
        } catch (error: any) {
            const data = error?.response?.data;
            const status = error?.response?.status || 502;
            logger.error("Fincra request failed", { method, path, status, data: maskDeep(data), message: error?.message });
            const message = data?.message || data?.error || (error?.response ? `Fincra returned ${status}` : `Fincra unreachable: ${error?.message}`);
            throw new FincraError(Array.isArray(message) ? message.join(", ") : String(message), status, maskDeep(data));
        }
    }

    async getBusiness() {
        const res = await this.request("get", "/profile/business/me");
        const business = res?.data ?? {};
        if (business._id && !config.FINCRA_BUSINESS_ID) this.businessId = business._id;
        return business;
    }

    async getBusinessId(): Promise<string> {
        if (this.businessId) return this.businessId;
        const business = await this.getBusiness();
        if (!business._id) throw new FincraError("Fincra did not return a business ID", 502);
        return business._id;
    }

    /** Every NGN virtual account on the business, page by page */
    async listVirtualAccounts() {
        const perPage = 100;
        const accounts: any[] = [];
        const seen = new Set<string>();
        for (let page = 1; ; page++) {
            const res = await this.request("get", "/profile/virtual-accounts", { params: { currency: "NGN", page, perPage } });
            const batch = rows(res?.data);
            // Stop if a page repeats (an API that ignores `page`) or runs out
            const fresh = batch.filter((a) => !seen.has(a._id || a.id));
            fresh.forEach((a) => seen.add(a._id || a.id));
            accounts.push(...fresh.map(maskDeep));
            const total = Number(res?.data?.total);
            if (!fresh.length || batch.length < perPage || (isFinite(total) && accounts.length >= total)) break;
        }
        return { accounts, total: accounts.length };
    }

    async getVirtualAccount(id: string) {
        const res = await this.request("get", `/profile/virtual-accounts/${encodeURIComponent(id)}`);
        return maskDeep(res?.data);
    }

    /**
     * Permanent individual NGN account. Fincra approves it instantly; the BVN
     * must belong to the person named, in the same name order.
     * https://docs.fincra.com/docs/ngn-virtual-account
     */
    async createVirtualAccount(input: { firstName: string; lastName: string; email?: string; bvn: string; channel?: string; merchantReference?: string }) {
        if (this.creating.has(input.bvn)) throw new FincraError("An account request for this BVN is already in progress", 409);
        this.creating.add(input.bvn);
        try {
            const body: Record<string, any> = {
                currency: "NGN",
                accountType: "individual",
                KYCInformation: {
                    firstName: input.firstName,
                    lastName: input.lastName,
                    bvn: input.bvn,
                    ...(input.email ? { email: input.email } : {}),
                },
                merchantReference: input.merchantReference || `sp-lab-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
                ...(input.channel ? { channel: input.channel } : {}),
            };
            try {
                const res = await this.request("post", "/profile/virtual-accounts/requests", { body });
                return maskDeep(res?.data);
            } catch (error) {
                // Fincra support needs the reference to trace a failed request
                if (error instanceof FincraError) {
                    logger.warn("Fincra account request failed", { merchantReference: body.merchantReference, channel: input.channel || "default", status: error.status });
                    error.message = `${error.message} (reference ${body.merchantReference}${input.channel ? `, bank ${input.channel}` : ""})`;
                }
                throw error;
            }
        } finally {
            this.creating.delete(input.bvn);
        }
    }

    /**
     * Deposits into one virtual account, each with Fincra's fee and the amount
     * that settled. The docs call the filter "the virtual account number" but
     * webhooks carry the account's ID, so both are tried.
     * https://docs.fincra.com/reference/fetch-deposits-by-virtual-account-id
     */
    async listDeposits(virtualAccountId: string, accountNumber?: string) {
        const business = await this.getBusinessId();
        const id = await this.resolveAccountId(virtualAccountId, accountNumber);
        const res = await this.request("get", "/collections", { params: { business, virtualAccount: id } });
        return rows(res?.data).map(maskDeep);
    }

    /** Account number → Fincra's 24-character account id, learnt from the account list */
    private accountIds = new Map<string, string>();

    /**
     * The live API only accepts the account's 24-character id as
     * `virtualAccount` (an account number fails validation). The id given
     * may be something else, such as what a create returned, so fall back
     * to finding the account by its number.
     */
    private async resolveAccountId(id: string, accountNumber?: string): Promise<string> {
        if (/^[0-9a-f]{24}$/i.test(id)) return id;
        const key = accountNumber || id;
        const cached = this.accountIds.get(key);
        if (cached) return cached;
        const { accounts } = await this.listVirtualAccounts();
        for (const a of accounts) {
            const n = a.accountInformation?.accountNumber || a.accountNumber;
            if (n && a._id) this.accountIds.set(n, a._id);
        }
        const match = accounts.find((a: any) => a._id === id || a.id === id || (accountNumber && (a.accountInformation?.accountNumber || a.accountNumber) === accountNumber));
        if (!match?._id) throw new FincraError("This account isn't in Fincra's account list yet; deposits can be checked once it appears", 404);
        this.accountIds.set(key, match._id);
        return match._id;
    }

    /** What Fincra charges on a checkout payment of this size. Prices only; nothing is charged. */
    async checkoutFee(type: "bank_transfer" | "card" | "payattitude" | "mobile_money", amount: number, currency: FincraCheckoutCurrency = "NGN") {
        const res = await this.request("post", "/checkout/data/fees", { body: { currency, type, amount }, withBusiness: true });
        return res?.data;
    }

    /**
     * Hosted checkout payment link. Money paid through it settles into the
     * Fincra balance of the same currency. `amount` is a whole number; the
     * docs' examples (350 GHS, decimals in amountReceived) point to major
     * units, but don't say so outright.
     * https://docs.fincra.com/docs/checkout-redirect
     */
    async createCheckout(input: {
        currency: FincraCheckoutCurrency;
        amount: number;
        customer: { name: string; email: string; phoneNumber?: string };
        paymentMethods: string[];
        feeBearer: "customer" | "business";
        reference: string;
        redirectUrl?: string;
        metadata?: Record<string, string>;
    }) {
        const res = await this.request("post", "/checkout/payments", {
            withPublicKey: true,
            body: {
                currency: input.currency,
                amount: input.amount,
                customer: input.customer,
                paymentMethods: input.paymentMethods,
                feeBearer: input.feeBearer,
                settlementDestination: "wallet",
                reference: input.reference,
                ...(input.redirectUrl ? { redirectUrl: input.redirectUrl } : {}),
                metadata: input.metadata ?? { source: "solutionpay-lab" },
            },
        });
        // Checkout answers { status: true, data: { link, reference, payCode } }
        if (!res?.data?.link) throw new FincraError(res?.message || "Fincra didn't return a payment link", 502, res);
        return res.data as { link: string; reference?: string; payCode?: string };
    }

    /** Status of a checkout by our reference. 404 until Fincra has a record of it. */
    async getCheckout(reference: string) {
        const res = await this.request("get", `/checkout/payments/merchant-reference/${encodeURIComponent(reference)}`, { withBusiness: true });
        return res?.data;
    }

    /**
     * Payout quote for an NGN bank transfer. Generating a quote prices the
     * payout and expires after 30 seconds; it does not send anything.
     * https://docs.fincra.com/reference/generate-quote
     */
    async payoutQuote(amount: number) {
        const business = await this.getBusinessId();
        const res = await this.request("post", "/quotes/generate", {
            body: {
                sourceCurrency: "NGN",
                destinationCurrency: "NGN",
                amount: String(amount),
                action: "send",
                transactionType: "disbursement",
                feeBearer: "business",
                paymentDestination: "bank_account",
                beneficiaryType: "individual",
                business,
            },
        });
        return res?.data;
    }

    // ───────────────────────── Banks and accounts ─────────────────────────

    private bankCache = new Map<string, { at: number; banks: FincraBank[] }>();

    /** Banks or mobile money providers Fincra pays out to, cached for an hour */
    async listBanks(country: "NG" | "GH", currency: "NGN" | "GHS", paymentDestination: PayoutDestination): Promise<FincraBank[]> {
        const key = `${country}:${currency}:${paymentDestination}`;
        const cached = this.bankCache.get(key);
        if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.banks;
        const res = await this.request("get", "/core/banks", { params: { country, currency, paymentDestination } });
        const banks: FincraBank[] = rows(res?.data ?? res)
            .filter((b: any) => b?.code && b?.name)
            .map((b: any) => ({ code: String(b.code), name: String(b.name).trim(), swiftCode: b.swiftCode || undefined, isMobileVerified: b.isMobileVerified }))
            .sort((a, b) => a.name.localeCompare(b.name));
        if (banks.length) this.bankCache.set(key, { at: Date.now(), banks });
        return banks;
    }

    /** Fincra's mobile money code for one of our network codes (MTN / VOD / ATM) */
    async ghsMobileMoneyCode(network: string): Promise<string> {
        const providers = await this.listBanks("GH", "GHS", "mobile_money_wallet");
        const n = (network || "").toUpperCase();
        const patterns: Record<string, RegExp> = {
            MTN: /mtn/i,
            VOD: /vodafone|telecel/i,
            ATM: /airtel|tigo/i,
        };
        const pattern = patterns[n];
        const match = providers.find((p) => p.code.toUpperCase() === n) || (pattern ? providers.find((p) => pattern.test(p.name) || pattern.test(p.code)) : undefined);
        if (!match) throw new FincraError(`Mobile money network ${network} isn't available for payouts right now`, 422);
        return match.code;
    }

    /** The account holder's name for an account number (NGN bank, GHS bank or mobile money) */
    async resolveAccount(input: { currency: "NGN" | "GHS"; accountNumber: string; bankCode?: string; bankSwiftCode?: string; mobileMoneyCode?: string }) {
        const body: Record<string, string> = { accountNumber: input.accountNumber, currency: input.currency };
        if (input.mobileMoneyCode) Object.assign(body, { type: "mobile_money", mobileMoneyCode: input.mobileMoneyCode });
        else if (input.currency === "NGN") Object.assign(body, { type: "nuban", bankCode: input.bankCode || "" });
        else Object.assign(body, { type: "bank_account", ...(input.bankSwiftCode ? { bankSwiftCode: input.bankSwiftCode } : {}), ...(input.bankCode ? { bankCode: input.bankCode } : {}) });
        const res = await this.request("post", "/core/accounts/resolve", { body });
        const name = res?.data?.accountName;
        if (!name) throw new FincraError("Fincra couldn't confirm this account", 404);
        return { accountName: String(name), accountNumber: String(res?.data?.accountNumber || input.accountNumber) };
    }

    // ───────────────────────── Rates ─────────────────────────

    private rateCache = new Map<string, { at: number; ngnPerGhs: number }>();
    private rateLoading = new Map<string, Promise<number>>();

    /**
     * NGN per 1 GHS as Fincra prices it, for a payout (we buy GHS: "send") or
     * for GHS taken in through payment links (we sell GHS: "receive").
     * Priced off a quote for a typical amount; cached for a minute.
     */
    async ngnPerGhs(direction: "send" | "receive"): Promise<number> {
        const cached = this.rateCache.get(direction);
        if (cached && Date.now() - cached.at < 60_000) return cached.ngnPerGhs;
        let loading = this.rateLoading.get(direction);
        if (!loading) {
            loading = this.loadNgnPerGhs(direction).finally(() => this.rateLoading.delete(direction));
            this.rateLoading.set(direction, loading);
        }
        return loading;
    }

    private async loadNgnPerGhs(direction: "send" | "receive"): Promise<number> {
        const quote = direction === "send"
            ? await this.quote({ sourceCurrency: "NGN", destinationCurrency: "GHS", amount: 1000, action: "receive", transactionType: "disbursement", paymentDestination: "mobile_money_wallet" })
            : await this.quote({ sourceCurrency: "GHS", destinationCurrency: "NGN", amount: 1000, action: "send", transactionType: "conversion", paymentDestination: "fliqpay_wallet" });
        const ngnPerGhs = toNgnPerGhs(quote);
        if (!(ngnPerGhs > 0)) throw new FincraError("Fincra didn't return a usable NGN/GHS rate", 502, quote);
        this.rateCache.set(direction, { at: Date.now(), ngnPerGhs });
        return ngnPerGhs;
    }

    /**
     * A quote. With action "receive" the amount is what arrives (destination
     * currency); with "send" it's what leaves. Expires in about 30 seconds.
     * https://docs.fincra.com/reference/generate-quote
     */
    async quote(input: {
        sourceCurrency: string;
        destinationCurrency: string;
        amount: number;
        action: "send" | "receive";
        transactionType: "disbursement" | "conversion";
        paymentDestination: PayoutDestination | "fliqpay_wallet";
    }) {
        const business = await this.getBusinessId();
        const res = await this.request("post", "/quotes/generate", {
            body: {
                sourceCurrency: input.sourceCurrency,
                destinationCurrency: input.destinationCurrency,
                amount: String(input.amount),
                action: input.action,
                transactionType: input.transactionType,
                feeBearer: "business",
                paymentDestination: input.paymentDestination,
                beneficiaryType: "individual",
                business,
            },
        });
        if (!res?.data) throw new FincraError(res?.message || "Fincra didn't return a quote", 502, res);
        return res.data as {
            reference: string;
            rate?: number | string;
            sourceAmount?: number | string;
            destinationAmount?: number | string;
            amountToCharge?: number | string;
            amountToReceive?: number | string;
            fee?: number | string;
            expireAt?: string;
        };
    }

    // ───────────────────────── Payouts ─────────────────────────

    /**
     * Send money out. `customerReference` is ours and unique per payout; a
     * repeat is refused (DUPLICATE_CUSTOMER_REFERENCE), so retries are safe.
     * A cross-currency payout (NGN → GHS) needs `quoteReference`.
     * https://docs.fincra.com/reference/initiate-payout
     */
    async createPayout(input: {
        customerReference: string;
        sourceCurrency: "NGN" | "GHS";
        destinationCurrency: "NGN" | "GHS";
        amount: number;
        paymentDestination: PayoutDestination;
        description: string;
        quoteReference?: string;
        beneficiary: {
            firstName: string;
            lastName: string;
            accountHolderName: string;
            accountNumber: string;
            country: "NG" | "GH";
            bankCode?: string;
            bankSwiftCode?: string;
            mobileMoneyCode?: string;
            email?: string;
        };
        senderName?: string;
    }) {
        const business = await this.getBusinessId();
        const res = await this.request("post", "/disbursements/payouts", {
            body: {
                business,
                sourceCurrency: input.sourceCurrency,
                destinationCurrency: input.destinationCurrency,
                amount: input.amount,
                description: input.description,
                customerReference: input.customerReference,
                paymentDestination: input.paymentDestination,
                ...(input.quoteReference ? { quoteReference: input.quoteReference } : {}),
                beneficiary: { type: "individual", ...input.beneficiary },
                ...(input.senderName ? { sender: { name: input.senderName } } : {}),
            },
        });
        return (res?.data ?? {}) as { id?: number | string; reference?: string; customerReference?: string; status?: string };
    }

    /** A payout by our reference; null when Fincra has no record of it */
    async getPayout(customerReference: string) {
        try {
            const res = await this.request("get", `/disbursements/payouts/customer-reference/${encodeURIComponent(customerReference)}`);
            return res?.data && Object.keys(res.data).length ? res.data : null;
        } catch (error) {
            if (error instanceof FincraError && error.status === 404) return null;
            throw error;
        }
    }

    // ───────────────────────── Webhooks ─────────────────────────

    /**
     * Fincra signs webhooks with HMAC-SHA512 (hex) of the JSON body using the
     * webhook key, in the `signature` header. Its examples sign the parsed
     * body re-serialised, so both the raw bytes and that form are accepted.
     * https://docs.fincra.com/docs/validating-webhook
     */
    verifyWebhookSignature(rawBody: string, parsedBody: unknown, signature: string | undefined): boolean {
        const secret = config.FINCRA_WEBHOOK_SECRET;
        if (!secret || !signature) return false;
        const given = Buffer.from(signature.trim().toLowerCase(), "utf8");
        const candidates = new Set([rawBody, JSON.stringify(parsedBody)]);
        for (const body of candidates) {
            const expected = Buffer.from(crypto.createHmac("sha512", secret).update(body).digest("hex"), "utf8");
            if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return true;
        }
        return false;
    }
}

export default new FincraService();
