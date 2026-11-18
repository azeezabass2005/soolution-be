import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import config from "../config/env.config";
import logger from "../utils/logger.utils";

/**
 * Spotflow client for the admin lab: NGN and GHS virtual accounts and balances.
 *
 * Deliberately has no transfer or deactivate calls, so nothing here can move
 * money out or close an account, even with a live key. Calls made: list and
 * read accounts, create static or dynamic accounts, read balances and
 * transaction history.
 *
 * Auth: `Authorization: Bearer <secret key>`. Test and live share one host;
 * the key prefix (sk_test_ / sk_live_) picks the mode.
 * Docs: https://docs.spotflow.one/api-reference/authentication
 */

export const SPOTFLOW_CURRENCIES = ["NGN", "GHS"] as const;
export type SpotflowCurrency = (typeof SPOTFLOW_CURRENCIES)[number];

export class SpotflowError extends Error {
    constructor(message: string, public status: number, public spotflow?: any) {
        super(message);
    }
}

/** List endpoints may answer with a bare array or wrap it */
const rows = (body: any): any[] => {
    if (Array.isArray(body)) return body;
    for (const key of ["data", "content", "results", "items"]) {
        if (Array.isArray(body?.[key])) return body[key];
        if (Array.isArray(body?.[key]?.data)) return body[key].data;
    }
    return [];
};
const one = (body: any) => (body && typeof body === "object" && body.data && !Array.isArray(body.data) ? body.data : body);

class SpotflowService {
    private client: AxiosInstance;
    /** One create at a time per name and currency, so a double click can't open two */
    private creating = new Set<string>();

    constructor() {
        this.client = axios.create({
            baseURL: config.SPOTFLOW_BASE_URL,
            timeout: 30000,
            headers: { Accept: "application/json", "Content-Type": "application/json" },
        });
    }

    get mode(): "live" | "test" | null {
        const key = config.SPOTFLOW_SECRET_KEY;
        if (key.startsWith("sk_live_")) return "live";
        if (key.startsWith("sk_test_")) return "test";
        return null;
    }

    get configured() {
        return !!config.SPOTFLOW_SECRET_KEY;
    }

    /** Customers can be given GHS accounts: switched on, keyed, and webhooks verifiable */
    get ghsAccountsAvailable() {
        return config.SPOTFLOW_GHS_ACCOUNTS_ENABLED && this.configured && !!this.mode && !!config.SPOTFLOW_WEBHOOK_SECRET_KEY;
    }

    /**
     * Spotflow signs webhooks the Standard Webhooks way: HMAC-SHA256 of
     * "{webhook-id}.{webhook-timestamp}.{raw body}" keyed with the webhook
     * secret (base64, after an optional "whsec_" prefix), sent as
     * "v1,<base64>" in x-spotflow-signature (several may be space-separated).
     * Older than 5 minutes is refused, so a captured delivery can't be replayed.
     */
    verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, now = Date.now()): boolean {
        const secret = config.SPOTFLOW_WEBHOOK_SECRET_KEY;
        const header = (name: string) => {
            const v = headers[name];
            return Array.isArray(v) ? v[0] : v;
        };
        const id = header("webhook-id");
        const timestamp = header("webhook-timestamp");
        const signatures = header("x-spotflow-signature") || header("webhook-signature");
        if (!secret || !id || !timestamp || !signatures) return false;
        const seconds = Number(timestamp);
        if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > 5 * 60) return false;
        let key: Buffer;
        try {
            key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
        } catch {
            return false;
        }
        if (!key.length) return false;
        const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
        return signatures.split(" ").some((entry) => {
            const [version, value] = entry.split(",", 2);
            if (version !== "v1" || !value) return false;
            const given = Buffer.from(value, "base64");
            return given.length === expected.length && crypto.timingSafeEqual(given, expected);
        });
    }

    private async request<T = any>(method: "get" | "post", path: string, { body, params }: { body?: any; params?: any } = {}): Promise<T> {
        if (!config.SPOTFLOW_SECRET_KEY) throw new SpotflowError("SPOTFLOW_SECRET_KEY is not set", 503);
        try {
            const response = await this.client.request({
                method, url: path, data: body, params,
                headers: { Authorization: `Bearer ${config.SPOTFLOW_SECRET_KEY}` },
            });
            return response.data;
        } catch (error: any) {
            const data = error?.response?.data;
            const status = error?.response?.status || 502;
            logger.error("Spotflow request failed", { method, path, status, data, message: error?.message });
            const message = data?.errorMessage || data?.message || data?.error || data?.detail || (error?.response ? `Spotflow returned ${status}` : `Spotflow unreachable: ${error?.message}`);
            throw new SpotflowError(Array.isArray(message) ? message.join(", ") : String(message), status, data);
        }
    }

    /** Main account balances, one per currency */
    async mainBalances() {
        return rows(await this.request("get", "/balances", { params: { page: 0, size: 50 } }));
    }

    /** Every permanent account (optionally one currency), page by page */
    async listStaticAccounts(currency?: SpotflowCurrency) {
        const size = 100;
        const accounts: any[] = [];
        const seen = new Set<string>();
        for (let page = 0; ; page++) {
            const batch = rows(await this.request("get", "/accounts", { params: { page, size, accountTag: "sub-account", ...(currency ? { currency } : {}) } }));
            // Stop if a page repeats (an API that ignores `page`) or runs out
            const fresh = batch.filter((a) => !seen.has(a.id));
            fresh.forEach((a) => seen.add(a.id));
            accounts.push(...fresh);
            if (!fresh.length || batch.length < size) break;
        }
        return accounts;
    }

    /** The main account of a currency (where one-time accounts pay in) */
    async mainAccountId(currency: string): Promise<string | undefined> {
        return (await this.mainBalances()).find((b: any) => b.currency === currency)?.accountId;
    }

    /**
     * Credits and debits on one account (a permanent account's id, or a main
     * account's id), newest first. `GET /transactions` isn't in Spotflow's
     * docs; it's the history their dashboard shows. Records carry no fee.
     */
    async listTransactions(accountId: string, size = 50) {
        const body = await this.request("get", "/transactions", { params: { accountId, page: 0, size } });
        // Keep only this account's rows, in case the filter is ever ignored
        const transactions = rows(body).filter((t) => !t.accountId || t.accountId === accountId).map((t) => {
            const sender = t.metadata?.sender;
            return {
                id: t.id,
                reference: t.spotflowReference || t.reference,
                amount: t.amount,
                currency: t.currency,
                type: t.type,
                status: t.status,
                source: t.source,
                description: typeof t.description === "string" ? t.description.trim() : t.description,
                date: t.transactionDate || t.createdAt,
                fee: t.fee ?? t.metadata?.fee,
                sender: sender ? {
                    name: typeof sender.accountName === "string" ? sender.accountName.trim() : sender.accountName,
                    // Only the last four digits of the payer's number reach the screen
                    account: sender.accountNumber ? `••••${String(sender.accountNumber).slice(-4)}` : undefined,
                    bank: sender.bankName,
                } : undefined,
            };
        });
        return { transactions, total: typeof body?.totalElements === "number" ? body.totalElements : transactions.length };
    }

    /**
     * One account's own balance. The live API wants the account's id (uuid),
     * not the account number the docs show.
     */
    async accountBalance(accountId: string) {
        return one(await this.request("get", `/balances/accounts/${encodeURIComponent(accountId)}/balance`));
    }

    /**
     * Permanent account with its own balance. Needs the feature switched on
     * by Spotflow support first. https://docs.spotflow.one/features/static-accounts
     */
    async createStaticAccount(currency: SpotflowCurrency, accountName: string) {
        return this.once(`static:${currency}:${accountName.toLowerCase()}`, async () =>
            one(await this.request("post", "/accounts", { body: { currency, accountName } })));
    }

    /**
     * One-off account for a set amount, paid straight into the main account;
     * expires after 30 minutes by default. https://docs.spotflow.one/features/dynamic-accounts
     */
    async createDynamicAccount(currency: SpotflowCurrency, accountName: string, amount: number, expiresIn?: number) {
        return this.once(`dynamic:${currency}:${accountName.toLowerCase()}:${amount}`, async () =>
            one(await this.request("post", "/virtual-accounts/temporary", { body: { currency, accountName, amount, ...(expiresIn ? { expiresIn } : {}) } })));
    }

    private async once<T>(key: string, fn: () => Promise<T>): Promise<T> {
        if (this.creating.has(key)) throw new SpotflowError("The same account request is already in progress", 409);
        this.creating.add(key);
        try {
            return await fn();
        } finally {
            this.creating.delete(key);
        }
    }
}

export default new SpotflowService();
