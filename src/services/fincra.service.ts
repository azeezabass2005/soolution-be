import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import config from "../config/env.config";
import logger from "../utils/logger.utils";

/**
 * Fincra client for the admin lab: NGN virtual accounts and fee lookups.
 *
 * Deliberately has no payout, conversion or wallet-transfer calls, so nothing
 * here can move money out of the Fincra balance, even with live keys. The
 * calls it makes are: read the business, create/list virtual accounts, list
 * deposits, create and check checkout payment links (money in), and the two
 * fee calculators (checkout fees, quotes), which only price a transaction.
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
    async createVirtualAccount(input: { firstName: string; lastName: string; email?: string; bvn: string; channel?: string }) {
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
                merchantReference: `sp-lab-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
                ...(input.channel ? { channel: input.channel } : {}),
            };
            const res = await this.request("post", "/profile/virtual-accounts/requests", { body });
            return maskDeep(res?.data);
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
        let res = await this.request("get", "/collections", { params: { business, virtualAccount: virtualAccountId } });
        let deposits = rows(res?.data);
        if (!deposits.length && accountNumber) {
            res = await this.request("get", "/collections", { params: { business, virtualAccount: accountNumber } });
            deposits = rows(res?.data);
        }
        return deposits.map(maskDeep);
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
                metadata: { source: "solutionpay-lab" },
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
}

export default new FincraService();
