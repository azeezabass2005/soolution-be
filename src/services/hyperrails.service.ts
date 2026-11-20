import axios, { AxiosInstance } from "axios";
import config from "../config/env.config";
import logger from "../utils/logger.utils";

/**
 * HyperRails client for the admin lab (GHS and KES).
 *
 * Calls: balances, rates, mobile money currencies and providers, bank lists,
 * express quotes (price a trade), accepting a quote with the payer's mobile
 * money (a pay-in), the OTP step, payment status, completing or cancelling a
 * quote, and bank payouts and their status.
 *
 * Auth: `Authorization: Bearer sk_test_…|sk_live_…` plus `x-service-source`.
 * One host for both modes; the key prefix picks test or live. Most calls live
 * under /api/v1, marketplace quotes under /exchange/api/v1. The docs disagree
 * on a few paths, so those calls try each documented path in turn (on 404).
 * Docs: https://github.com/Hyper-Rail/docs
 */

export const HYPERRAILS_LAB_CURRENCIES = ["GHS", "KES"] as const;
export type HyperRailsLabCurrency = (typeof HYPERRAILS_LAB_CURRENCIES)[number];
export const HYPERRAILS_COUNTRY: Record<HyperRailsLabCurrency, string> = { GHS: "GH", KES: "KE" };

export class HyperRailsError extends Error {
    constructor(message: string, public status: number, public hyperrails?: any) {
        super(message);
    }
}

const API = "/api/v1";
const EXCHANGE = "/exchange/api/v1";

/** A list that may come back bare or wrapped ({ data: [...] }, { items: [...] }…) */
export const asRows = (body: any): any[] => {
    if (Array.isArray(body)) return body;
    for (const key of ["data", "items", "results", "providers", "banks", "currencies", "balances"]) {
        if (Array.isArray(body?.[key])) return body[key];
        if (Array.isArray(body?.data?.[key])) return body.data[key];
    }
    // Otherwise the first list one or two levels down (e.g. { data: { GH: [...] } })
    const nested = (value: any, depth: number): any[] | null => {
        if (!value || typeof value !== "object" || depth > 2) return null;
        for (const v of Object.values(value)) {
            if (Array.isArray(v) && v.length) return v;
            const deeper = nested(v, depth + 1);
            if (deeper) return deeper;
        }
        return null;
    };
    return nested(body, 0) ?? [];
};

/** An object that may come back wrapped in { data } */
const unwrap = (body: any) => (body && typeof body === "object" && !Array.isArray(body) && body.data && typeof body.data === "object" && !Array.isArray(body.data) && !("quoteId" in body) ? body.data : body);

class HyperRailsService {
    private client: AxiosInstance;
    /** One write at a time per key, so a double click can't start two */
    private busy = new Set<string>();

    constructor() {
        this.client = axios.create({ timeout: 30000, headers: { Accept: "application/json", "Content-Type": "application/json" } });
    }

    get mode(): "live" | "test" | null {
        const key = config.HYPERRAILS_SECRET_KEY;
        if (key.startsWith("sk_live_")) return "live";
        if (key.startsWith("sk_test_")) return "test";
        return null;
    }

    get configured() {
        return !!config.HYPERRAILS_SECRET_KEY;
    }

    private async request<T = any>(method: "get" | "post" | "put", path: string, { body, params }: { body?: any; params?: any } = {}): Promise<T> {
        if (!config.HYPERRAILS_SECRET_KEY) throw new HyperRailsError("HYPERRAILS_SECRET_KEY is not set", 503);
        if (!this.mode) throw new HyperRailsError("HYPERRAILS_SECRET_KEY should start with sk_test_ or sk_live_ (the secret key, not the public pk_ or encryption enc_ key)", 400);
        try {
            const response = await this.client.request({
                method,
                baseURL: config.HYPERRAILS_BASE_URL,
                url: path,
                data: body,
                params,
                headers: { Authorization: `Bearer ${config.HYPERRAILS_SECRET_KEY}`, "x-service-source": config.HYPERRAILS_SERVICE_SOURCE },
            });
            return response.data;
        } catch (error: any) {
            const data = error?.response?.data;
            const status = error?.response?.status || 502;
            logger.error("HyperRails request failed", { method, path, status, data, message: error?.message });
            const message = data?.errorMessage || data?.message || data?.error?.message || (typeof data?.error === "string" ? data.error : "")
                || (error?.response ? `HyperRails returned ${status}${status === 401 && !data ? " with an empty body (check the key and path)" : ""}` : `HyperRails unreachable: ${error?.message}`);
            throw new HyperRailsError(Array.isArray(message) ? message.join(", ") : String(message), status, data);
        }
    }

    /** Tries each path in order, moving on only when HyperRails says 404 */
    private async firstOf<T = any>(method: "get" | "post" | "put", paths: string[], options: { body?: any; params?: any } = {}): Promise<T> {
        let last: any;
        for (const path of paths) {
            try {
                return await this.request<T>(method, path, options);
            } catch (error: any) {
                last = error;
                if (!(error instanceof HyperRailsError) || error.status !== 404) throw error;
            }
        }
        throw last;
    }

    private async once<T>(key: string, fn: () => Promise<T>): Promise<T> {
        if (this.busy.has(key)) throw new HyperRailsError("The same request is already in progress", 409);
        this.busy.add(key);
        try {
            return await fn();
        } finally {
            this.busy.delete(key);
        }
    }

    /* ---------------- balances, rates, coverage ---------------- */

    /** Every currency account: { accountId, currency, balance, availableBalance } */
    async balances() {
        return asRows(await this.firstOf("get", [`${API}/partners/balances`, `${API}/balances`]));
    }

    /** The account for one currency (its accountId is what trades settle into) */
    async balanceFor(currency: string) {
        const account = unwrap(await this.firstOf("get", [`${API}/partners/balances/currency/${encodeURIComponent(currency)}`, `${API}/balances/currency/${encodeURIComponent(currency)}`]));
        if (!account?.accountId) throw new HyperRailsError(`No ${currency} account on this HyperRails business`, 404, account);
        return account as { accountId: string; currency: string; balance: number; availableBalance: number };
    }

    /** The published rate (a trade can fill at a different one: quote to be sure) */
    async rate(base: string, quote: string) {
        return unwrap(await this.request("get", `${API}/partners/rates`, { params: { base, quote } }));
    }

    async mobileMoneyCurrencies() {
        return asRows(await this.firstOf("get", [`${API}/partners/marketplace/mobile-money/currencies`, `${EXCHANGE}/partners/marketplace/mobile-money/currencies`]));
    }

    /** The providers for a currency, and HyperRails' reply as it came */
    async mobileMoneyProviders(currency: string, countryCode?: string) {
        const raw = await this.firstOf("get", [`${API}/partners/marketplace/mobile-money/providers`, `${EXCHANGE}/partners/marketplace/mobile-money/providers`], { params: { currency, ...(countryCode ? { countryCode } : {}) } });
        return { providers: asRows(raw), raw };
    }

    async banks(currency: string) {
        return asRows(await this.request("get", `${API}/transfers/banks/${encodeURIComponent(currency)}`));
    }

    /* ---------------- quotes and mobile money pay-ins ---------------- */

    /** Prices a trade in one call; nothing is charged until it's accepted */
    async expressQuote(input: { sourceCurrency: string; destinationCurrency: string; amount: number; amountDirection: "source" | "destination"; accountId: string; externalReference?: string }) {
        return unwrap(await this.request("post", `${EXCHANGE}/partners/marketplace/express/quote`, { body: input }));
    }

    private quotePaths(id: string, action = "") {
        const tail = `/partners/marketplace/quote/${encodeURIComponent(id)}${action}`;
        return [`${EXCHANGE}${tail}`, `${API}${tail}`];
    }

    /** Accepts a quote and charges the payer's mobile money (they approve on their phone or with an OTP) */
    async acceptWithMobileMoney(id: string, input: { accountId: string; countryCode: string; providerCode: string; phoneNumber: string }) {
        return this.once(`accept:${id}`, async () => unwrap(await this.firstOf("put", this.quotePaths(id, "/accept"), {
            body: {
                accountId: input.accountId,
                payment: { channel: "mobile_money", countryCode: input.countryCode, mobileMoney: { code: input.providerCode, phoneNumber: input.phoneNumber } },
            },
        })));
    }

    async authorize(id: string, otp: string) {
        return unwrap(await this.firstOf("put", this.quotePaths(id, "/payment/authorize"), { body: { otp } }));
    }

    async paymentStatus(id: string) {
        return unwrap(await this.firstOf("get", this.quotePaths(id, "/payment/status")));
    }

    async getQuote(id: string) {
        return unwrap(await this.firstOf("get", this.quotePaths(id)));
    }

    /** Settles a paid quote into the destination account */
    async complete(id: string) {
        return this.once(`complete:${id}`, async () => unwrap(await this.firstOf("put", this.quotePaths(id, "/complete"))));
    }

    async cancel(id: string) {
        return unwrap(await this.firstOf("put", this.quotePaths(id, "/cancel")));
    }

    /* ---------------- bank payouts ---------------- */

    /** Pays a bank account from this currency's balance. `reference` is the idempotency key */
    async payout(input: { reference: string; amount: number; currency: string; destination: { accountNumber: string; accountName: string; bankCode: string; branchCode?: string }; narration?: string }) {
        return this.once(`payout:${input.reference}`, async () => unwrap(await this.request("post", `${API}/partners/payouts`, { body: input })));
    }

    async payoutStatus(reference: string) {
        return unwrap(await this.request("get", `${API}/partners/payouts/${encodeURIComponent(reference)}`));
    }
}

export default new HyperRailsService();
