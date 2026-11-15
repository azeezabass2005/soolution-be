import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import config from "../config/env.config";
import logger from "../utils/logger.utils";

/**
 * Daya client for the admin lab: customers, NGN funding accounts (Daya's NGN
 * virtual accounts), USD/EUR virtual accounts, deposits, balances and fees.
 *
 * Deliberately has no transfer, withdrawal, bridge, balance-transfer or
 * settlement-change calls, and never opens an account that settles on-chain
 * or pays out, so nothing here can send money out of Daya, even with a live
 * key. Calls made: read balances, fees, rates and quotes (prices only),
 * create/read customers, submit Tier 1 verification, create/read funding
 * accounts and virtual accounts, read deposits, and (sandbox key only) the
 * sandbox deposit simulator.
 *
 * Auth: `X-Api-Key: <key>`. sk_sandbox_ keys only work on the sandbox host,
 * sk_live_ keys only on production. Docs: https://docs.daya.co
 */

const HOSTS = {
    sandbox: "https://api.sandbox.daya.co",
    live: "https://api.daya.co",
};

/** Funding account settlement choices that keep money inside Daya */
export const DAYA_SETTLEMENTS = {
    PERMANENT: ["CUSTOMER_NGN_BALANCE", "NGN_BALANCE", "INTERNAL_BALANCE"],
    TEMPORARY: ["NGN_BALANCE", "INTERNAL_BALANCE"],
} as const;
export type DayaAccountType = keyof typeof DAYA_SETTLEMENTS;
export const DAYA_VA_CURRENCIES = ["usd", "eur"] as const;
export const DAYA_SANDBOX_SCENARIOS = ["COMPLETED", "PROCESSING", "REQUIRES_REVIEW", "FAILED"] as const;

export class DayaError extends Error {
    constructor(message: string, public status: number, public daya?: any) {
        super(message);
    }
}

/** Lists come back as { data: [...], page, limit, total, total_pages } */
const rows = (body: any): any[] => (Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []);
const totalPages = (body: any) => (typeof body?.total_pages === "number" ? body.total_pages : undefined);

class DayaService {
    private client: AxiosInstance;
    /** One write at a time per key, so a double click can't open two */
    private busy = new Set<string>();

    constructor() {
        this.client = axios.create({
            timeout: 30000,
            headers: { Accept: "application/json", "Content-Type": "application/json" },
        });
    }

    get mode(): "live" | "sandbox" | null {
        const key = config.DAYA_SECRET_KEY;
        if (key.startsWith("sk_live_")) return "live";
        if (key.startsWith("sk_sandbox_")) return "sandbox";
        return null;
    }

    get configured() {
        return !!config.DAYA_SECRET_KEY;
    }

    get baseUrl() {
        return config.DAYA_BASE_URL || (this.mode ? HOSTS[this.mode] : "");
    }

    private async request<T = any>(method: "get" | "post", path: string, { body, params, idempotencyKey }: { body?: any; params?: any; idempotencyKey?: string } = {}): Promise<T> {
        if (!config.DAYA_SECRET_KEY) throw new DayaError("DAYA_SECRET_KEY is not set", 503);
        if (!this.mode) throw new DayaError("DAYA_SECRET_KEY should start with sk_sandbox_ or sk_live_", 400);
        const headers: Record<string, string> = { "X-Api-Key": config.DAYA_SECRET_KEY };
        if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
        try {
            const response = await this.client.request({ method, baseURL: this.baseUrl, url: path, data: body, params, headers });
            return response.data;
        } catch (error: any) {
            const data = error?.response?.data;
            const status = error?.response?.status || 502;
            logger.error("Daya request failed", { method, path, status, data, message: error?.message });
            const e = data?.error;
            const message =
                (typeof e === "object" ? e?.message : e) || data?.message ||
                (error?.response ? `Daya returned ${status}` : `Daya unreachable: ${error?.message}`);
            const extra = typeof e === "object" && e?.validation ? ` (${JSON.stringify(e.validation)})` : "";
            throw new DayaError(`${message}${extra}`, status, data);
        }
    }

    /** Pages through a list endpoint (limit 200), stopping at total_pages or a short page */
    private async all(path: string, params: Record<string, any> = {}, maxPages = 10) {
        const out: any[] = [];
        const seen = new Set<string>();
        for (let page = 1; page <= maxPages; page++) {
            const body = await this.request("get", path, { params: { ...params, page, limit: 200 } });
            const batch = rows(body);
            const fresh = batch.filter((r) => !r?.id || !seen.has(r.id));
            fresh.forEach((r) => r?.id && seen.add(r.id));
            out.push(...fresh);
            const pages = totalPages(body);
            if (!fresh.length || batch.length < 200 || (pages !== undefined && page >= pages)) break;
        }
        return out;
    }

    private async once<T>(key: string, fn: () => Promise<T>): Promise<T> {
        if (this.busy.has(key)) throw new DayaError("The same request is already in progress", 409);
        this.busy.add(key);
        try {
            return await fn();
        } finally {
            this.busy.delete(key);
        }
    }

    /* ---------------- merchant ---------------- */

    /** Collection and withdrawal balances (USD, NGN, SOL, BNB), decimal strings in major units */
    async merchantBalance() {
        return (await this.request("get", "/v1/merchant/balance"))?.data ?? null;
    }

    /** The business's own NGN account and crypto addresses; null if Daya hasn't set one up */
    async merchantFunding() {
        try {
            return (await this.request("get", "/v1/merchant/funding"))?.data ?? null;
        } catch (error) {
            if (error instanceof DayaError && error.status === 404) return null;
            throw error;
        }
    }

    async fees() {
        return this.request("get", "/v1/fees");
    }

    /** Current NGN rate; temporary accounts need its rate_id. Prices only. */
    async rate(to: "USD" | "USDC" | "USDT" = "USD", side: "BUY" | "SELL" = "BUY") {
        return this.request("get", "/v1/rates", { params: { from: "NGN", to, side } });
    }

    /** Preview of an NGN → stablecoin conversion with every fee. Moves nothing, reserves nothing. */
    async quote(sourceAmount: string, destination: "USDC" | "USDT", chain: string) {
        return this.request("post", "/v1/quotes", {
            body: { source_currency: "NGN", destination_currency: destination, source_amount: sourceAmount, chain },
        });
    }

    /* ---------------- customers ---------------- */

    async listCustomers() {
        return this.all("/v1/customers");
    }

    async getCustomer(id: string) {
        return this.request("get", `/v1/customers/${encodeURIComponent(id)}`);
    }

    async createCustomer(input: { email: string; firstName?: string; lastName?: string }) {
        return this.once(`customer:${input.email}`, () =>
            this.request("post", "/v1/customers", {
                body: {
                    email: input.email,
                    ...(input.firstName ? { first_name: input.firstName } : {}),
                    ...(input.lastName ? { last_name: input.lastName } : {}),
                },
            }));
    }

    /** NGN held for the customer (from permanent accounts settling to CUSTOMER_NGN_BALANCE) */
    async customerBalances(id: string) {
        return rows(await this.request("get", `/v1/customers/${encodeURIComponent(id)}/balances`));
    }

    /**
     * Tier 1: BVN plus a selfie, needed before a permanent NGN account.
     * The BVN, phone and image are passed straight through and never logged.
     */
    async submitTier1(id: string, input: { bvn: string; phoneNumber?: string; imageUrl: string }) {
        return this.once(`tier1:${id}`, () =>
            this.request("post", `/v1/customers/${encodeURIComponent(id)}/tier1-verification`, {
                body: { bvn: input.bvn, image_url: input.imageUrl, ...(input.phoneNumber ? { phone_number: input.phoneNumber } : {}) },
            }));
    }

    /* ---------------- NGN funding accounts ---------------- */

    async listFundingAccounts(customerId?: string) {
        return this.all("/v1/funding-accounts", { rail: "NGN_VIRTUAL_ACCOUNT", ...(customerId ? { customer_id: customerId } : {}) });
    }

    async getFundingAccount(id: string) {
        return this.request("get", `/v1/funding-accounts/${encodeURIComponent(id)}`);
    }

    /**
     * NGN virtual account for a customer. Permanent needs the customer's
     * Tier 1; temporary takes one payment of `amount` naira (Daya adds its
     * collection charge, so the account's own amount is what to pay) and
     * needs a fresh rate_id, which is fetched here. Settlement is limited to
     * balances inside Daya: never ONCHAIN, never a payout.
     */
    async createFundingAccount(input: { type: DayaAccountType; customerId: string; settlement: string; amount?: number }) {
        const allowed: readonly string[] = DAYA_SETTLEMENTS[input.type];
        if (!allowed.includes(input.settlement)) throw new DayaError(`Settlement must be one of ${allowed.join(", ")}`, 400);
        return this.once(`fa:${input.customerId}:${input.type}`, async () => {
            const settlement_destination: Record<string, any> = { type: input.settlement };
            if (input.type === "TEMPORARY") {
                const rate = await this.rate("USD", "BUY");
                if (!rate?.rate_id) throw new DayaError("Daya didn't return a rate_id for the temporary account", 502, rate);
                settlement_destination.rate_id = rate.rate_id;
            }
            return this.request("post", "/v1/funding-accounts", {
                idempotencyKey: `sp-lab-fa-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
                body: {
                    type: input.type,
                    rail: "NGN_VIRTUAL_ACCOUNT",
                    currency: "NGN",
                    customer: { customer_id: input.customerId },
                    ...(input.type === "TEMPORARY" ? { amount: input.amount } : {}),
                    settlement_destination,
                },
            });
        });
    }

    /**
     * NGN (and crypto) deposits since `from`. Daya's list has no funding
     * account filter, so callers filter by funding_account_id.
     */
    async listDeposits(from?: string) {
        return this.all("/v1/deposits", from ? { from } : {}, 5);
    }

    /* ---------------- USD / EUR virtual accounts ---------------- */

    async listVirtualAccounts(customerId?: string) {
        return this.all("/v1/virtual-accounts", customerId ? { customer_id: customerId } : {});
    }

    /** Needs the customer's Tier 2 (and Daya's SEPA approval for EUR) */
    async createVirtualAccount(customerId: string, currency: "usd" | "eur") {
        return this.once(`va:${customerId}:${currency}`, () =>
            this.request("post", "/v1/virtual-accounts", { body: { customer_id: customerId, currency } }));
    }

    async listVirtualAccountDeposits(virtualAccountId: string) {
        return this.all("/v1/virtual-account-deposits", { virtual_account_id: virtualAccountId }, 5);
    }

    /* ---------------- sandbox only ---------------- */

    /** Fake payment into a customer funding account. Refused on a live key. */
    async simulateDeposit(fundingAccountId: string, scenario: string) {
        if (this.mode !== "sandbox") throw new DayaError("The deposit simulator only works with a sandbox key", 400);
        return this.once(`sim:${fundingAccountId}`, () =>
            this.request("post", "/v1/sandbox/deposits", { body: { funding_account_id: fundingAccountId, scenario } }));
    }
}

export default new DayaService();
