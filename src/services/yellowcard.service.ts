import config from "../config/env.config";
import crypto from "crypto";
import axios, { AxiosInstance } from "axios";
import logger from "../utils/logger.utils";
import errorResponseMessage, { ErrorResponseCode, ErrorSeverity } from "../common/messages/error-response-message";
import { CURRENCY_COUNTRY, YELLOWCARD_FLOW_CURRENCIES } from "../common/payment-link.constants";

/** The KYC person on a payment (sender) or collection (recipient) */
export type YellowCardChannelType = "bank" | "momo";

export interface YellowCardCountryConfig {
    country: string;
    currency: string;
    send: boolean;
    receive: boolean;
    sendMin: number;
    /** 0 means no maximum */
    sendMax: number;
    receiveMin: number;
    /** 0 means no maximum */
    receiveMax: number;
    channelTypes: YellowCardChannelType[];
    /**
     * When money arrives, per direction and channel type, from YellowCard's
     * channel settlement times. Missing when the channel list can't be read.
     */
    arrival?: { send: Partial<Record<YellowCardChannelType, YellowCardArrival>>; receive: Partial<Record<YellowCardChannelType, YellowCardArrival>> };
}

/** "minutes": instant settlement; "same_day": within the day; "next_day": T+1 or later */
export type YellowCardArrival = "minutes" | "same_day" | "next_day";

/**
 * How soon a channel settles. YellowCard gives a settlementType ("instant",
 * "T+1", …) and an estimatedSettlementTime in seconds; the slower reading wins.
 */
export function channelArrival(channel: { settlementType?: unknown; estimatedSettlementTime?: unknown }): YellowCardArrival {
    const type = String(channel.settlementType ?? "").toLowerCase().replace(/[\s_-]/g, "");
    const seconds = Number(channel.estimatedSettlementTime);
    let fromType: YellowCardArrival | null = null;
    if (/^t\+?[1-9]|nextday|nextbusinessday|t1/.test(type)) fromType = "next_day";
    else if (/sameday|t\+?0|t0/.test(type)) fromType = "same_day";
    else if (type.includes("instant")) fromType = "minutes";
    let fromTime: YellowCardArrival | null = null;
    if (Number.isFinite(seconds) && seconds > 0) fromTime = seconds <= 60 * 60 ? "minutes" : seconds < 12 * 60 * 60 ? "same_day" : "next_day";
    const order: YellowCardArrival[] = ["minutes", "same_day", "next_day"];
    const picks = [fromType, fromTime].filter((a): a is YellowCardArrival => !!a);
    return picks.length ? picks.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a)) : "minutes";
}

const COUNTRY_CONFIG_TTL_MS = 5 * 60 * 1000;

export interface KycPerson {
    name: string;
    country: string;
    phone: string;
    address?: string;
    dob?: string;
    email: string;
    idNumber?: string;
    idType?: string;
    additionalIdType?: string;
    additionalIdNumber?: string;
}

/** Env values pasted into a dashboard often keep their quotes or a stray space */
const clean = (value?: string): string => (value || "").trim().replace(/^["']|["']$/g, "").trim();

class YellowCardService {

    private client: AxiosInstance;
    private basePath: string;

    constructor() {
        // Dashboard-pasted values often carry quotes or spaces; a value without
        // https:// makes every call fail with a bare "Invalid URL".
        const baseURL = clean(config.YELLOWCARD_BASE_URL) || "https://sandbox.api.yellowcard.io/business";
        if (!clean(config.YELLOWCARD_API_KEY) || !clean(config.YELLOWCARD_SECRET_KEY)) {
            logger.error("YELLOWCARD_API_KEY or YELLOWCARD_SECRET_KEY is not set; YellowCard will reject every call");
        }
        if (!/^https?:\/\/[^\s/]+/i.test(baseURL)) {
            logger.error("YELLOWCARD_BASE_URL is not a full URL; every YellowCard call (rates, sends, receives) will fail. Set it like https://sandbox.api.yellowcard.io/business", { value: baseURL });
        }
        this.client = axios.create({
            baseURL,
            timeout: 30000,
            headers: { "Content-Type": "application/json" },
        });
        // Extract the path portion from the base URL for HMAC signing
        // e.g. "https://sandbox.api.yellowcard.io/business" -> "/business"
        try {
            this.basePath = new URL(baseURL).pathname.replace(/\/$/, "");
        } catch {
            this.basePath = "/business";
        }
    }

    /**
     * The person block YellowCard requires on payments ("sender") and
     * collections ("recipient"): dob as mm/dd/yyyy, and an ID.
     * Callers pass identityService.yellowCardPerson(), built from the user's
     * verified record; the placeholders below only fill gaps on the sandbox.
     */
    private kycPerson(person: KycPerson) {
        let dob = person.dob;
        if (dob && /^\d{4}-\d{2}-\d{2}$/.test(dob)) {
            const [y, m, d] = dob.split('-');
            dob = `${m}/${d}/${y}`;
        }
        return {
            name: person.name,
            country: person.country,
            phone: person.phone,
            address: person.address || 'N/A',
            dob,
            email: person.email,
            idNumber: person.idNumber || '0000',
            idType: person.idType || 'license',
            // Nigeria: the NIN is the ID and the BVN the additional ID
            ...(person.additionalIdType && person.additionalIdNumber
                ? { additionalIdType: person.additionalIdType, additionalIdNumber: person.additionalIdNumber }
                : {}),
        };
    }

    /**
     * Build auth headers for each request.
     * YellowCard HMAC auth:
     *   message = ISO8601_timestamp + fullPath + METHOD [+ base64(sha256(body)) for POST/PUT]
     *   fullPath includes base path, e.g. /business/channels
     *   Authorization: YcHmacV1 {apiKey}:{base64_signature}
     */
    private getAuthHeaders(path: string, method: string, body?: any): Record<string, string> {
        const timestamp = new Date().toISOString();
        // Full path = basePath + endpoint path, e.g. /business/channels
        const fullPath = `${this.basePath}${path}`;

        // Build the message to sign: timestamp + fullPath + METHOD [+ bodyHash for POST/PUT]
        let message = `${timestamp}${fullPath}${method}`;
        if ((method === "POST" || method === "PUT") && body) {
            const bodyString = typeof body === "string" ? body : JSON.stringify(body);
            const bodyHash = crypto.createHash("sha256").update(bodyString).digest("base64");
            message += bodyHash;
        }

        const signature = crypto
            .createHmac("sha256", clean(config.YELLOWCARD_SECRET_KEY))
            .update(message)
            .digest("base64");

        return {
            Authorization: `YcHmacV1 ${clean(config.YELLOWCARD_API_KEY)}:${signature}`,
            "X-YC-Timestamp": timestamp,
        };
    }

    /**
     * Make an authenticated GET request with retry for transient errors.
     * Note: Query params are NOT included in the HMAC signature path.
     */
    private async get(path: string, params?: Record<string, any>, retries = 2) {
        let lastError: any;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                // Regenerate auth headers per attempt (timestamp-based HMAC)
                const response = await this.client.get(path, {
                    headers: this.getAuthHeaders(path, "GET"),
                    params,
                });
                return response.data;
            } catch (error: any) {
                lastError = error;
                const isTransient = !error?.response && (
                    error?.message?.includes('SSL') ||
                    error?.message?.includes('ssl') ||
                    error?.message?.includes('ECONNRESET') ||
                    error?.message?.includes('ETIMEDOUT') ||
                    error?.message?.includes('socket hang up') ||
                    error?.code === 'ECONNRESET' ||
                    error?.code === 'ETIMEDOUT'
                );
                if (isTransient && attempt < retries) {
                    logger.warn(`YellowCard GET ${path} transient error (attempt ${attempt + 1}/${retries + 1}), retrying...`, {
                        errorMessage: error?.message,
                    });
                    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                    continue;
                }
                logger.error("YellowCard GET raw error", {
                    path,
                    responseStatus: error?.response?.status,
                    responseData: error?.response?.data,
                    errorMessage: error?.message,
                });
                if (error?.response?.data) {
                    const ycData = error.response.data;
                    const enrichedError: any = new Error(
                        ycData.message || ycData.code || `YellowCard GET ${path} failed with status ${error.response.status}`
                    );
                    enrichedError.response = error.response;
                    enrichedError.ycError = ycData;
                    enrichedError.status = error.response.status;
                    throw enrichedError;
                }
                throw error;
            }
        }
        throw lastError;
    }

    /**
     * Make an authenticated POST request with retry for transient errors.
     */
    private async post(path: string, body?: any, retries = 2) {
        let lastError: any;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                // Regenerate auth headers per attempt (timestamp-based HMAC)
                const headers = this.getAuthHeaders(path, "POST", body);
                if (attempt === 0) {
                    logger.info("YellowCard POST request", {
                        path,
                        hasBody: !!body,
                        bodyKeys: body ? Object.keys(body) : [],
                    });
                }
                const response = await this.client.post(path, body, { headers });
                return response.data;
            } catch (error: any) {
                lastError = error;
                const isTransient = !error?.response && (
                    error?.message?.includes('SSL') ||
                    error?.message?.includes('ssl') ||
                    error?.message?.includes('ECONNRESET') ||
                    error?.message?.includes('ETIMEDOUT') ||
                    error?.message?.includes('socket hang up') ||
                    error?.code === 'ECONNRESET' ||
                    error?.code === 'ETIMEDOUT'
                );
                if (isTransient && attempt < retries) {
                    logger.warn(`YellowCard POST ${path} transient error (attempt ${attempt + 1}/${retries + 1}), retrying...`, {
                        errorMessage: error?.message,
                    });
                    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                    continue;
                }
                logger.error("YellowCard POST raw error", {
                    path,
                    isAxiosError: error?.isAxiosError,
                    responseStatus: error?.response?.status,
                    responseData: error?.response?.data,
                    errorName: error?.name,
                    errorMessage: error?.message,
                    errorCode: error?.code,
                });
                if (error?.response?.data) {
                    const ycData = error.response.data;
                    const enrichedError: any = new Error(
                        ycData.message || ycData.code || `YellowCard POST ${path} failed with status ${error.response.status}`
                    );
                    enrichedError.response = error.response;
                    enrichedError.ycError = ycData;
                    enrichedError.status = error.response.status;
                    throw enrichedError;
                }
                throw error;
            }
        }
        throw lastError;
    }

    /**
     * Make an authenticated PUT request.
     */
    private async put(path: string, body?: any) {
        try {
            const response = await this.client.put(path, body, {
                headers: this.getAuthHeaders(path, "PUT", body),
            });
            return response.data;
        } catch (error: any) {
            logger.error("YellowCard PUT raw error", {
                path,
                responseStatus: error?.response?.status,
                responseData: error?.response?.data,
                errorMessage: error?.message,
            });
            if (error?.response?.data) {
                const ycData = error.response.data;
                const enrichedError: any = new Error(
                    ycData.message || ycData.code || `YellowCard PUT ${path} failed with status ${error.response.status}`
                );
                enrichedError.response = error.response;
                enrichedError.ycError = ycData;
                enrichedError.status = error.response.status;
                throw enrichedError;
            }
            throw error;
        }
    }

    /**
     * Make an authenticated DELETE request.
     */
    private async del(path: string) {
        const response = await this.client.delete(path, {
            headers: this.getAuthHeaders(path, "DELETE"),
        });
        return response.data;
    }

    /**
     * Get supported payment channels (Bank Transfer, Mobile Money, E-Wallets).
     */
    public async getChannels(country?: string) {
        try {
            const params: any = {};
            if (country) params.country = country;
            const data = await this.get("/channels", params);
            logger.info("YellowCard: getChannels success");
            return data;
        } catch (error: any) {
            logger.error("YellowCard: getChannels failed", { error: error?.ycError || error?.response?.data || error?.message });
            throw error;
        }
    }

    /** Country configs by "country:currency", kept briefly so every form open doesn't call YellowCard */
    private countryConfigCache = new Map<string, { at: number; value: YellowCardCountryConfig }>();

    /**
     * What YellowCard supports for a country and currency: whether send and
     * receive are active, their limits (local currency; a max of 0 means none)
     * and the channel types ("bank", "momo") to offer.
     */
    public async getCountryConfig(country: string, currency: string): Promise<YellowCardCountryConfig> {
        const key = `${country}:${currency}`.toUpperCase();
        const cached = this.countryConfigCache.get(key);
        if (cached && Date.now() - cached.at < COUNTRY_CONFIG_TTL_MS) return cached.value;
        try {
            const data = await this.get("/country/config", { country, currency });
            const raw = data?.data ?? data ?? {};
            const value: YellowCardCountryConfig = {
                country: raw.country || country,
                currency: raw.currency || currency,
                send: raw.send === "active",
                receive: raw.receive === "active",
                sendMin: Number(raw.sendMin) || 0,
                sendMax: Number(raw.sendMax) || 0,
                receiveMin: Number(raw.receiveMin) || 0,
                receiveMax: Number(raw.receiveMax) || 0,
                channelTypes: (Array.isArray(raw.channelTypes) ? raw.channelTypes : [])
                    .filter((t: unknown): t is YellowCardChannelType => t === "bank" || t === "momo"),
            };
            value.arrival = await this.arrivalTimes(country, currency).catch(() => undefined);
            this.countryConfigCache.set(key, { at: Date.now(), value });
            return value;
        } catch (error: any) {
            logger.error("YellowCard: getCountryConfig failed, trying the channel list", { country, currency, error: error?.ycError || error?.response?.data || error?.message });
            // Some accounts can't read /country/config; the channel list says the same thing
            const value = await this.configFromChannels(country, currency).catch(() => null);
            if (!value) throw error;
            this.countryConfigCache.set(key, { at: Date.now(), value });
            return value;
        }
    }

    /** A country config pieced together from YellowCard's active channels (withdraw = send, deposit = receive) */
    private async configFromChannels(country: string, currency: string): Promise<YellowCardCountryConfig> {
        const data = await this.getChannels(country);
        const rows: any[] = (Array.isArray(data?.channels) ? data.channels : Array.isArray(data) ? data : [])
            .filter((c: any) => String(c?.currency).toUpperCase() === currency.toUpperCase()
                && (c?.status ?? "active") === "active" && (c?.apiStatus ?? "active") === "active"
                && (c?.channelType === "bank" || c?.channelType === "momo"));
        const side = (rampType: string) => rows.filter((c) => c.rampType === rampType);
        const limits = (list: any[]) => ({
            min: list.length ? Math.min(...list.map((c) => Number(c.min) || 0)) : 0,
            max: list.some((c) => !Number(c.max)) ? 0 : Math.max(0, ...list.map((c) => Number(c.max) || 0)),
        });
        const send = side("withdraw");
        const receive = side("deposit");
        return {
            country, currency,
            send: send.length > 0,
            receive: receive.length > 0,
            sendMin: limits(send).min, sendMax: limits(send).max,
            receiveMin: limits(receive).min, receiveMax: limits(receive).max,
            channelTypes: [...new Set(rows.map((c) => c.channelType as YellowCardChannelType))],
            arrival: this.arrivalFromRows(rows),
        };
    }

    /** Active channels for a currency, from YellowCard's channel list */
    private async activeChannels(country: string, currency: string): Promise<any[]> {
        const data = await this.getChannels(country);
        return (Array.isArray(data?.channels) ? data.channels : Array.isArray(data) ? data : [])
            .filter((c: any) => String(c?.currency).toUpperCase() === currency.toUpperCase()
                && (c?.status ?? "active") === "active" && (c?.apiStatus ?? "active") === "active"
                && (c?.channelType === "bank" || c?.channelType === "momo"));
    }

    private async arrivalTimes(country: string, currency: string) {
        return this.arrivalFromRows(await this.activeChannels(country, currency));
    }

    /** The slowest active channel of each type sets when money arrives that way */
    private arrivalFromRows(rows: any[]): NonNullable<YellowCardCountryConfig["arrival"]> {
        const order: YellowCardArrival[] = ["minutes", "same_day", "next_day"];
        const pick = (rampType: string) => {
            const out: Partial<Record<YellowCardChannelType, YellowCardArrival>> = {};
            for (const c of rows.filter((r) => r.rampType === rampType)) {
                const type = c.channelType as YellowCardChannelType;
                const arrival = channelArrival(c);
                if (!out[type] || order.indexOf(arrival) > order.indexOf(out[type]!)) out[type] = arrival;
            }
            return out;
        };
        return { send: pick("withdraw"), receive: pick("deposit") };
    }

    /**
     * Which of our YellowCard currencies can be sent to and received in right
     * now. A currency YellowCard can't be reached for is left out.
     */
    public async flowCurrencies(): Promise<{ send: string[]; receive: string[]; unavailable: Record<string, string> }> {
        const unavailable: Record<string, string> = {};
        const configs = await Promise.all(YELLOWCARD_FLOW_CURRENCIES.map((currency) =>
            this.getCountryConfig(CURRENCY_COUNTRY[currency], currency).catch((error: any) => {
                const reason = error?.response?.data?.message || error?.ycError?.message || error?.message || "YellowCard could not be reached";
                unavailable[currency] = `${error?.response?.status ? `${error.response.status}: ` : ""}${reason}`;
                return null;
            })));
        const usable = configs.filter((c): c is YellowCardCountryConfig => {
            if (!c) return false;
            if (!c.channelTypes.length) unavailable[c.currency] = "no bank or mobile money channel is on";
            else if (!c.send && !c.receive) unavailable[c.currency] = "send and receive are both off on this YellowCard account";
            return c.channelTypes.length > 0;
        });
        if (Object.keys(unavailable).length) logger.warn("YellowCard: some currencies are not on offer", { unavailable });
        return {
            send: usable.filter((c) => c.send).map((c) => c.currency),
            receive: usable.filter((c) => c.receive).map((c) => c.currency),
            unavailable,
        };
    }

    /**
     * Get supported financial networks (Banks, Mobile Money providers).
     */
    public async getNetworks(country?: string) {
        try {
            const params: any = {};
            if (country) params.country = country;
            const data = await this.get("/networks", params);
            logger.info("YellowCard: getNetworks success");
            return data;
        } catch (error: any) {
            logger.error("YellowCard: getNetworks failed", { error: error?.ycError || error?.response?.data || error?.message });
            throw error;
        }
    }

    /**
     * Get exchange rates for supported countries.
     */
    public async getRates() {
        try {
            const data = await this.get("/rates");
            const ratesArr = data?.rates || data || [];
            const codes = Array.isArray(ratesArr) ? ratesArr.map((r: any) => r.code || r.currency || r.currencyCode).filter(Boolean) : [];
            logger.info("YellowCard: getRates success", { count: codes.length, currencies: codes });
            return data;
        } catch (error: any) {
            logger.error("YellowCard: getRates failed", { status: error?.response?.status, error: error?.response?.data || error?.message || error });
            // What the provider answered stays in the log above; customers get a plain message
            throw errorResponseMessage.createError(
                ErrorResponseCode.UNABLE_TO_COMPLETE,
                "Exchange rates are unavailable right now. Please try again in a few minutes.",
                ErrorSeverity.HIGH,
                { code: "RATES_UNAVAILABLE" },
            );
        }
    }

    /**
     * Implied rate between an arbitrary pair, bridged via USD as YellowCard
     * quotes each currency per-USD. Returns the *provider* (raw) rate; apply
     * the platform markup separately through PlatformSettingsService.
     *
     *   - direction='send'    (user pays `from`, recipient gets `to`): rate = from-units-per-`to` unit
     *   - direction='receive' (user receives `to`, sender pays `from`): rate = to-units-per-`from` unit
     *
     * In both cases the *first* currency in the name is what's multiplied:
     *   send:   fromAmount   = toAmount   × rate
     *   receive: toAmount    = fromAmount × rate
     */
    public async getImpliedRate(from: string, to: string, direction: 'send' | 'receive'): Promise<number> {
        const data = await this.getRates();
        const ratesArr = data?.rates || (Array.isArray(data) ? data : []);
        const find = (cur: string) => ratesArr.find((r: any) =>
            r.code === cur || r.currency === cur || r.currencyCode === cur,
        );
        const fromRate = find(from);
        const toRate = find(to);
        if (!fromRate || !toRate) {
            throw new Error(`No rate found for ${from}→${to}`);
        }
        const buyFrom = Number(fromRate.buy);
        const sellFrom = Number(fromRate.sell);
        const buyTo = Number(toRate.buy);
        const sellTo = Number(toRate.sell);
        if (!isFinite(buyFrom) || !isFinite(sellTo) || buyFrom <= 0 || sellTo <= 0) {
            throw new Error(`Invalid rate values for ${from}→${to}`);
        }
        return direction === 'send'
            ? buyFrom / sellTo       // from-units per to-unit
            : sellTo / buyFrom;      // to-units per from-unit  (legacy: uses sellTo/buyFrom; symmetry with display memo)
    }

    /**
     * Get account info including available balance.
     */
    public async getAccount() {
        try {
            const data = await this.get("/account");
            logger.info("YellowCard: getAccount success");
            return data;
        } catch (error: any) {
            logger.error("YellowCard: getAccount failed", { error: error?.response?.data || error?.message || error });
            throw error;
        }
    }

    /**
     * Resolve/validate a bank account before sending payment.
     */
    public async resolveBankAccount(accountNumber: string, networkId: string, country: string) {
        try {
            const data = await this.post("/details/bank", { accountNumber, networkId, country });
            logger.info("YellowCard: resolveBankAccount success");
            return data;
        } catch (error: any) {
            logger.error("YellowCard: resolveBankAccount failed", { error: error?.response?.data || error?.message || error });
            throw error;
        }
    }

    /**
     * Resolve/validate a mobile money account before sending payment.
     */
    public async resolveMobileMoneyAccount(accountNumber: string, networkId: string, country: string) {
        try {
            const data = await this.post("/details/momo", { accountNumber, networkId, country });
            logger.info("YellowCard: resolveMobileMoneyAccount success");
            return data;
        } catch (error: any) {
            logger.error("YellowCard: resolveMobileMoneyAccount failed", { error: error?.response?.data || error?.message || error });
            throw error;
        }
    }

    /**
     * Submit a collection request (collect money FROM a customer in local currency).
     * This is step 1 of the automatic payment flow.
     */
    public async submitCollectionRequest(params: {
        /** YellowCard picks the best active channel of this type for the country and currency */
        channelType: YellowCardChannelType;
        country: string;
        currency: string;
        sequenceId: string;
        amount?: number;
        localAmount?: number;
        sender: KycPerson;
        destination?: {
            accountName?: string;
            accountNumber?: string;
            accountType?: string;
            networkId?: string;
        };
        forceAccept?: boolean;
    }) {
        try {
            // YellowCard collections API uses "recipient" (who receives funds) and "source" (where funds come from)
            // This differs from payments API which uses "sender" and "destination"

            const recipient = this.kycPerson(params.sender);

            const body: any = {
                channelType: params.channelType,
                country: params.country,
                currency: params.currency,
                sequenceId: params.sequenceId,
                customerType: "retail",
                customerUID: params.sender.email,
                recipient,
                forceAccept: params.forceAccept ?? true,
            };
            if (params.amount != null) body.amount = params.amount;
            if (params.localAmount != null) body.localAmount = params.localAmount;
            if (params.destination) {
                body.source = params.destination;
            }

            const data = await this.post("/collections", body);
            logger.info("YellowCard: submitCollectionRequest success", { sequenceId: params.sequenceId });
            return data;
        } catch (error: any) {
            logger.error("YellowCard: submitCollectionRequest failed", {
                sequenceId: params.sequenceId,
                error: error?.response?.data || error?.message || error,
            });
            throw error;
        }
    }

    /**
     * Accept a collection request for execution.
     */
    public async acceptCollectionRequest(collectionId: string) {
        try {
            const data = await this.post(`/collections/${collectionId}/accept`);
            logger.info("YellowCard: acceptCollectionRequest success", { collectionId });
            return data;
        } catch (error: any) {
            logger.error("YellowCard: acceptCollectionRequest failed", { collectionId, error: error?.response?.data || error?.message || error });
            throw error;
        }
    }

    /**
     * Look up a collection by its ID.
     */
    public async lookupCollection(collectionId: string) {
        try {
            const data = await this.get(`/collections/${collectionId}`);
            logger.info("YellowCard: lookupCollection success", { collectionId });
            return data;
        } catch (error: any) {
            logger.error("YellowCard: lookupCollection failed", { collectionId, error: error?.response?.data || error?.message || error });
            throw error;
        }
    }

    /**
     * Look up a collection by its sequenceId (your transaction reference).
     */
    public async lookupCollectionBySequenceId(sequenceId: string) {
        try {
            const data = await this.get(`/collections/sequence-id/${sequenceId}`);
            logger.info("YellowCard: lookupCollectionBySequenceId success", { sequenceId });
            return data;
        } catch (error: any) {
            logger.error("YellowCard: lookupCollectionBySequenceId failed", { sequenceId, error: error?.response?.data || error?.message || error });
            throw error;
        }
    }

    /**
     * Submit a payment/disbursement request (send money TO a recipient).
     * This is step 2 of the automatic payment flow.
     */
    public async submitPaymentRequest(params: {
        /** YellowCard picks the best active channel of this type for the country and currency */
        channelType: YellowCardChannelType;
        country: string;
        currency: string;
        sequenceId: string;
        amount?: number;
        localAmount?: number;
        sender: KycPerson;
        destination: {
            accountName: string;
            accountNumber: string;
            accountType: string;
            networkId: string;
            country: string;
        };
        reason?: string;
        forceAccept?: boolean;
    }) {
        try {
            const body: any = {
                channelType: params.channelType,
                country: params.country,
                currency: params.currency,
                sequenceId: params.sequenceId,
                sender: this.kycPerson(params.sender),
                destination: params.destination,
                reason: params.reason || "other",
                forceAccept: params.forceAccept ?? true,
            };
            if (params.amount != null) body.amount = params.amount;
            if (params.localAmount != null) body.localAmount = params.localAmount;

            const data = await this.post("/payments", body);
            logger.info("YellowCard: submitPaymentRequest success", { sequenceId: params.sequenceId });
            return data;
        } catch (error: any) {
            logger.error("YellowCard: submitPaymentRequest failed", {
                sequenceId: params.sequenceId,
                status: error?.status || error?.response?.status,
                ycError: error?.ycError,
                error: error?.ycError || error?.response?.data || error?.message || error,
            });
            throw error;
        }
    }

    /**
     * Accept a payment request for execution.
     */
    public async acceptPaymentRequest(paymentId: string) {
        try {
            const data = await this.post(`/payments/${paymentId}/accept`);
            logger.info("YellowCard: acceptPaymentRequest success", { paymentId });
            return data;
        } catch (error: any) {
            logger.error("YellowCard: acceptPaymentRequest failed", { paymentId, error: error?.response?.data || error?.message || error });
            throw error;
        }
    }

    /**
     * Deny a payment request.
     */
    public async denyPaymentRequest(paymentId: string) {
        try {
            const data = await this.post(`/payments/${paymentId}/deny`);
            logger.info("YellowCard: denyPaymentRequest success", { paymentId });
            return data;
        } catch (error: any) {
            logger.error("YellowCard: denyPaymentRequest failed", { paymentId, error: error?.response?.data || error?.message || error });
            throw error;
        }
    }

    /**
     * Look up a payment by its ID.
     */
    public async lookupPayment(paymentId: string) {
        try {
            const data = await this.get(`/payments/${paymentId}`);
            logger.info("YellowCard: lookupPayment success", { paymentId });
            return data;
        } catch (error: any) {
            logger.error("YellowCard: lookupPayment failed", { paymentId, error: error?.response?.data || error?.message || error });
            throw error;
        }
    }

    /**
     * Look up a payment by its sequenceId.
     */
    public async lookupPaymentBySequenceId(sequenceId: string) {
        try {
            const data = await this.get(`/payments/sequence-id/${sequenceId}`);
            logger.info("YellowCard: lookupPaymentBySequenceId success", { sequenceId });
            return data;
        } catch (error: any) {
            logger.error("YellowCard: lookupPaymentBySequenceId failed", { sequenceId, error: error?.response?.data || error?.message || error });
            throw error;
        }
    }

    /**
     * Cancel a collection request that is pending or processing.
     */
    public async cancelCollection(collectionId: string) {
        try {
            const data = await this.post(`/collections/${collectionId}/cancel`);
            logger.info("YellowCard: cancelCollection success", { collectionId });
            return data;
        } catch (error: any) {
            logger.error("YellowCard: cancelCollection failed", { collectionId, error: error?.response?.data || error?.message || error });
            throw error;
        }
    }

    // ============= WEBHOOK MANAGEMENT =============

    /**
     * Register a webhook URL with YellowCard.
     * Omit `state` to subscribe to all events, or pass e.g. "PAYMENT.COMPLETE".
     */
    public async registerWebhook(url: string, state?: string) {
        const body: any = { url, active: true };
        if (state) body.state = state;
        const data = await this.post("/webhooks", body);
        logger.info("YellowCard: webhook registered", { url, state: state || "ALL" });
        return data;
    }

    /**
     * List all registered webhooks.
     */
    public async listWebhooks() {
        const data = await this.get("/webhooks");
        return data;
    }

    /**
     * Delete/deactivate a webhook.
     */
    public async deleteWebhook(webhookId: string) {
        // YellowCard uses PUT to deactivate, or DELETE to remove
        const headers = this.getAuthHeaders(`/webhooks/${webhookId}`, "DELETE");
        const response = await this.client.delete(`/webhooks/${webhookId}`, { headers });
        logger.info("YellowCard: webhook deleted", { webhookId });
        return response.data;
    }

    /**
     * Verify a YellowCard webhook signature.
     * YellowCard signs webhook payloads with HMAC-SHA256.
     * Uses YELLOWCARD_WEBHOOK_SECRET if set, otherwise falls back to the API secret key.
     */
    public verifyWebhookSignature(payload: string, signature: string): boolean {
        const secret = config.YELLOWCARD_WEBHOOK_SECRET || config.YELLOWCARD_SECRET_KEY;
        if (!secret) {
            logger.warn("YellowCard: No webhook secret or API secret configured, rejecting webhook");
            return false;
        }

        // Try hex digest first, then base64 (YellowCard docs say base64-encoded SHA-256 HMAC)
        const hmac = crypto.createHmac("sha256", secret).update(payload);
        const hexSignature = hmac.digest("hex");
        const base64Signature = crypto.createHmac("sha256", secret).update(payload).digest("base64");

        // Compare against both formats
        try {
            const sigBuf = Buffer.from(signature);
            const hexBuf = Buffer.from(hexSignature);
            const b64Buf = Buffer.from(base64Signature);

            if (sigBuf.byteLength === hexBuf.byteLength && crypto.timingSafeEqual(sigBuf, hexBuf)) {
                return true;
            }
            if (sigBuf.byteLength === b64Buf.byteLength && crypto.timingSafeEqual(sigBuf, b64Buf)) {
                return true;
            }
        } catch {
            // Buffer length mismatch throws in timingSafeEqual — that's fine, just means no match
        }

        logger.warn("YellowCard: webhook signature mismatch", {
            receivedLength: signature.length,
            expectedHexLength: hexSignature.length,
            expectedB64Length: base64Signature.length,
        });
        return false;
    }
}

export default new YellowCardService();
