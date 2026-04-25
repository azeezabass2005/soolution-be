import config from "../config/env.config";
import crypto from "crypto";
import axios, { AxiosInstance } from "axios";
import logger from "../utils/logger.utils";

class YellowCardService {

    private client: AxiosInstance;
    private basePath: string;

    constructor() {
        const baseURL = config.YELLOWCARD_BASE_URL || "https://sandbox.api.yellowcard.io/business";
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
            .createHmac("sha256", config.YELLOWCARD_SECRET_KEY)
            .update(message)
            .digest("base64");

        return {
            Authorization: `YcHmacV1 ${config.YELLOWCARD_API_KEY}:${signature}`,
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
            logger.error("YellowCard: getRates failed", { error: error?.response?.data || error?.message || error });
            throw error;
        }
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
        channelId: string;
        sequenceId: string;
        amount?: number;
        localAmount?: number;
        sender: {
            name: string;
            country: string;
            phone: string;
            address: string;
            dob: string;
            email: string;
            idNumber?: string;
            idType?: string;
        };
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

            // Format dob to mm/dd/yyyy as required by YellowCard
            let dob = params.sender.dob;
            if (dob && dob.includes('-') && dob.indexOf('-') === 4) {
                // Convert yyyy-mm-dd to mm/dd/yyyy
                const [y, m, d] = dob.split('-');
                dob = `${m}/${d}/${y}`;
            }

            const recipient: any = {
                name: params.sender.name,
                country: params.sender.country,
                phone: params.sender.phone,
                address: params.sender.address || 'N/A',
                dob,
                email: params.sender.email,
                idNumber: params.sender.idNumber || '0000',
                idType: params.sender.idType || 'license',
            };

            const body: any = {
                channelId: params.channelId,
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
        channelId: string;
        sequenceId: string;
        amount?: number;
        localAmount?: number;
        sender: {
            name: string;
            country: string;
            phone: string;
            address: string;
            dob: string;
            email: string;
            idNumber?: string;
            idType?: string;
        };
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
                channelId: params.channelId,
                sequenceId: params.sequenceId,
                sender: params.sender,
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
