import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import config from "../config/env.config";
import logger from "../utils/logger.utils";
import platformSettingsService, { RateDirection } from "./platform-settings.service";

/**
 * OGateway API client (Ghana instant send + receive).
 *
 * Auth: `Authorization: <api_key>` header. No HMAC on outbound requests.
 * Webhook auth: HMAC-SHA512 hex over the raw body, header `x-ogateway-signature`.
 *
 * Docs: https://docs.ogateway.io/docs/getting-started
 */
class OGatewayService {
    private client: AxiosInstance;
    /** In-memory rate cache: keyed by `source-destination`, value is the
     *  numeric rate plus the fetch timestamp. Rates are quoted per 1 unit
     *  of source so the cached rate works for any amount the caller asks
     *  about — keeps the keystroke-driven UI from hammering the endpoint. */
    private ratesCache: Map<string, { rate: number; fetchedAt: number }> = new Map();
    private readonly RATES_TTL_MS = 30_000;

    constructor() {
        const baseURL = config.OGATEWAY_BASE_URL || "https://api.ogateway.io";
        this.client = axios.create({
            baseURL,
            timeout: 30000,
            headers: { "Content-Type": "application/json" },
        });
    }

    private authHeader(): Record<string, string> {
        if (!config.OGATEWAY_API_KEY) {
            throw new Error("OGATEWAY_API_KEY is not configured");
        }
        return { Authorization: config.OGATEWAY_API_KEY };
    }

    private async post<T = any>(path: string, body: any, retries = 2): Promise<T> {
        let lastError: any;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const response = await this.client.post(path, body, {
                    headers: this.authHeader(),
                });
                return response.data;
            } catch (error: any) {
                lastError = error;
                const isTransient = !error?.response && (
                    error?.code === "ECONNRESET" ||
                    error?.code === "ETIMEDOUT" ||
                    error?.message?.includes("socket hang up") ||
                    error?.message?.includes("ECONNRESET") ||
                    error?.message?.includes("ETIMEDOUT")
                );
                if (isTransient && attempt < retries) {
                    logger.warn(`OGateway POST ${path} transient error, retrying`, {
                        attempt: attempt + 1,
                        errorMessage: error?.message,
                    });
                    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
                    continue;
                }
                logger.error("OGateway POST failed", {
                    path,
                    status: error?.response?.status,
                    data: error?.response?.data,
                    message: error?.message,
                });
                if (error?.response?.data) {
                    const ogData = error.response.data;
                    const enriched: any = new Error(
                        ogData?.message || ogData?.error || `OGateway POST ${path} failed (${error.response.status})`,
                    );
                    enriched.response = error.response;
                    enriched.ogError = ogData;
                    enriched.status = error.response.status;
                    throw enriched;
                }
                throw error;
            }
        }
        throw lastError;
    }

    /**
     * Mobile money collection (receive).
     * `POST /collections/mobilemoney`
     * Networks: MTN, VOD, ATM, ORANGE.
     */
    public async collectMobileMoney(params: {
        amount: number;
        currency: string;
        network: string;
        accountName: string;
        accountNumber: string;
        reason: string;
        reference: string;
        callbackURL?: string;
        email?: string;
        metadata?: Record<string, any>;
    }): Promise<any> {
        const body = {
            ...params,
            callbackURL: params.callbackURL || config.OGATEWAY_CALLBACK_URL || undefined,
        };
        const data = await this.post("/collections/mobilemoney", body);
        logger.info("OGateway collectMobileMoney success", {
            reference: params.reference,
            network: params.network,
        });
        return data;
    }

    /**
     * Mobile money payout (send).
     * `POST /disbursements/mobilemoney`
     * V1 supports one recipient per request only.
     */
    public async payoutMobileMoney(params: {
        reference: string;
        recipient: {
            amount: number;
            currency: string;
            network: string;
            accountName: string;
            accountNumber: string;
        };
        callbackURL?: string;
    }): Promise<any> {
        const body = {
            reference: params.reference,
            recipients: [params.recipient],
            callbackURL: params.callbackURL || config.OGATEWAY_CALLBACK_URL || undefined,
        };
        const data = await this.post("/disbursements/mobilemoney", body);
        logger.info("OGateway payoutMobileMoney success", {
            reference: params.reference,
            network: params.recipient.network,
        });
        return data;
    }

    /**
     * Bank payout (send).
     * `POST /disbursements/bank`
     * V1 supports one recipient per request only.
     */
    public async payoutBank(params: {
        reference: string;
        senderName: string;
        recipient: {
            amount: number;
            currency: string;
            bank: string;
            accountName: string;
            accountNumber: string;
            destination?: string;
            channel?: string;
        };
        callbackURL?: string;
    }): Promise<any> {
        const body = {
            reference: params.reference,
            senderName: params.senderName,
            recipients: [params.recipient],
            callbackURL: params.callbackURL || config.OGATEWAY_CALLBACK_URL || undefined,
        };
        const data = await this.post("/disbursements/bank", body);
        logger.info("OGateway payoutBank success", {
            reference: params.reference,
            bank: params.recipient.bank,
        });
        return data;
    }

    private async get<T = any>(path: string, params?: Record<string, any>): Promise<T> {
        try {
            const response = await this.client.get(path, {
                headers: { ...this.authHeader(), accept: "application/json" },
                params,
            });
            return response.data;
        } catch (error: any) {
            logger.error("OGateway GET failed", {
                path,
                status: error?.response?.status,
                data: error?.response?.data,
                message: error?.message,
            });
            if (error?.response?.data) {
                const ogData = error.response.data;
                const enriched: any = new Error(
                    ogData?.message || ogData?.error || `OGateway GET ${path} failed (${error.response.status})`,
                );
                enriched.response = error.response;
                enriched.ogError = ogData;
                enriched.status = error.response.status;
                throw enriched;
            }
            throw error;
        }
    }

    /**
     * Fetch the authoritative status of a previously-created OGateway
     * payment (disbursement or collection) by its OGateway-assigned `id`
     * (the UUID returned in the create response, stored as `ogId` on the
     * detail). Used by the stale-transaction sweeper to recover from
     * missed webhooks. Endpoint: `GET /payments/{id}`.
     */
    public async getTransactionStatus(ogId: string): Promise<any> {
        return this.get(`/payments/${ogId}`);
    }

    /**
     * Fetch the current OGateway conversion rate between two currencies and
     * cache it per direction for {@link RATES_TTL_MS}.
     *
     * Important: OGateway's `rate` field is always quoted as units of the
     * more-valuable currency per 1 unit of the less-valuable currency,
     * regardless of which one is `source`. For our GHS↔NGN pair that means
     * `rate` is always NGN-per-GHS — but the value differs by direction
     * because of OGateway's buy/sell spread:
     *   - `source=GHS, destination=NGN` → sell-GHS rate (e.g. 115.10)
     *   - `source=NGN, destination=GHS` → buy-GHS rate (e.g. 117.65)
     * Pick the direction that matches the economic side you're pricing.
     *
     * Supported currencies (per docs):
     *   GHS NGN UGX KES XOF XAF USD EUR GBP USDT USDC
     */
    public async getRate(source: string, destination: string): Promise<number> {
        const key = `${source}-${destination}`;
        const cached = this.ratesCache.get(key);
        if (cached && Date.now() - cached.fetchedAt < this.RATES_TTL_MS) {
            return cached.rate;
        }
        const data = await this.get("/rates", { source, destination, amount: 1 });
        const rateNum = typeof data?.rate === "string" ? parseFloat(data.rate) : Number(data?.rate);
        if (!isFinite(rateNum) || rateNum <= 0) {
            logger.error("OGateway: getRate returned non-numeric rate", { source, destination, data });
            throw new Error(`OGateway returned an invalid rate for ${source}→${destination}`);
        }
        this.ratesCache.set(key, { rate: rateNum, fetchedAt: Date.now() });
        logger.info("OGateway: getRate success", { source, destination, rate: rateNum });
        return rateNum;
    }

    /**
     * Provider rate with the platform's universal markup applied. This is
     * the rate that user-facing flows must use — both the rate-display
     * endpoint and the transaction-creation path consume this single
     * function so display and journal can never drift.
     *
     * Direction maps to the economic side of the trade as the user sees it:
     *   - 'send' when the user is buying the foreign currency (NGN→GHS)
     *   - 'receive' when the user is selling it (GHS→NGN)
     */
    public async getUserFacingRate(
        source: string,
        destination: string,
        direction: RateDirection,
    ): Promise<{ providerRate: number; userRate: number }> {
        const providerRate = await this.getRate(source, destination);
        const userRate = await platformSettingsService.applyRateMarkup(providerRate, direction);
        return { providerRate, userRate };
    }

    /**
     * Quote a conversion for a specific amount, with markup + fee preview.
     * The `rate` field is always NGN-per-GHS for the GHS↔NGN pair (see
     * {@link getRate}), so the math is direction-aware: multiply when
     * source is GHS, divide when source is NGN.
     *
     * Returns the breakdown the frontend renders verbatim — no client-side
     * recomputation of fees or markup.
     */
    public async quoteRate(source: string, destination: string, amount: number): Promise<{
        rate: number;
        providerRate: number;
        userRate: number;
        convertedAmount: number;
        feePercent: number;
        feeAmount: number;
        totalAmount: number;
        source: string;
        destination: string;
    }> {
        const direction: RateDirection = source === 'GHS' ? 'receive' : 'send';
        const { providerRate, userRate } = await this.getUserFacingRate(source, destination, direction);

        // For GHS↔NGN the rate is always NGN-per-GHS, so the math depends on
        // which side `amount` is in.
        const convertedAmount = source === "GHS"
            ? Math.round(amount * userRate * 100) / 100   // GHS → NGN
            : Math.round((amount / userRate) * 100) / 100; // NGN → GHS

        // Fee is computed off the NGN-denominated side of the trade since
        // FEES_NGN is the platform's fee account and our wallet is NGN.
        const feeBaseNgn = source === 'NGN' ? amount : convertedAmount;
        const { feeAmount, feePercent } = await platformSettingsService.computeFee('ogateway', feeBaseNgn);

        // For sends the fee is added on top of the NGN debit; for receives it
        // is netted out of the NGN credit. totalAmount reflects what the user
        // either pays (send) or receives (receive).
        const totalAmount = source === 'NGN'
            ? Math.round((amount + feeAmount) * 100) / 100              // send: pay extra
            : Math.round((convertedAmount - feeAmount) * 100) / 100;    // receive: get less

        return {
            rate: userRate,
            providerRate,
            userRate,
            convertedAmount,
            feePercent,
            feeAmount,
            totalAmount,
            source,
            destination,
        };
    }

    /**
     * Verify a webhook signature. OGateway signs the raw body with
     * HMAC-SHA512 (hex) keyed by the dashboard webhook secret and ships
     * it in the `x-ogateway-signature` header.
     *
     * Falls back to the API key only if no dedicated webhook secret is set
     * (some OGateway tenants don't expose a separate secret), to keep
     * dev/test working before the secret is generated.
     */
    public verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
        if (!signature) return false;
        const secret = config.OGATEWAY_WEBHOOK_SECRET || config.OGATEWAY_API_KEY;
        if (!secret) {
            logger.warn("OGateway: no webhook secret or API key configured — rejecting webhook");
            return false;
        }
        const expected = crypto
            .createHmac("sha512", secret)
            .update(rawBody)
            .digest("hex");
        try {
            const a = Buffer.from(signature, "utf8");
            const b = Buffer.from(expected, "utf8");
            if (a.byteLength !== b.byteLength) return false;
            return crypto.timingSafeEqual(a, b);
        } catch {
            return false;
        }
    }
}

export default new OGatewayService();
