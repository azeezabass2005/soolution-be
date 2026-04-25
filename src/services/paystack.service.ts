import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import config from "../config/env.config";
import logger from "../utils/logger.utils";

class PaystackService {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            baseURL: config.PAYSTACK_BASE_URL || "https://api.paystack.co",
            timeout: 30000,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`,
            },
        });
    }

    /**
     * Create a Paystack customer
     */
    async createCustomer(data: {
        email: string;
        first_name: string;
        last_name: string;
        phone?: string;
    }) {
        try {
            const response = await this.client.post("/customer", data);
            logger.info("Paystack: customer created", { email: data.email, customerCode: response.data?.data?.customer_code });
            return response.data.data;
        } catch (error: any) {
            logger.error("Paystack: createCustomer failed", {
                email: data.email,
                status: error?.response?.status,
                body: error?.response?.data,
                message: error?.message,
            });
            throw error;
        }
    }

    /**
     * Create a Dedicated Virtual Account for a customer.
     * Paystack test mode requires preferred_bank = "test-bank".
     * Response shape varies — normalise before returning.
     */
    async createDedicatedAccount(customerCode: string, preferredBank?: string) {
        const payload: any = {
            customer: customerCode,
            preferred_bank: preferredBank || "test-bank",
        };
        let raw: any;
        try {
            const response = await this.client.post("/dedicated_account", payload);
            raw = response.data?.data;
            logger.info("Paystack: DVA raw response", { customerCode, raw: JSON.stringify(raw) });
        } catch (error: any) {
            logger.error("Paystack: createDedicatedAccount failed", {
                customerCode,
                status: error?.response?.status,
                body: error?.response?.data,
                message: error?.message,
            });
            throw error;
        }

        // Normalise: Paystack may return the account at top level or nested
        const accountNumber = raw?.account_number || raw?.dedicated_account?.account_number;
        const accountName = raw?.account_name || raw?.dedicated_account?.account_name;
        const bank = raw?.bank || raw?.dedicated_account?.bank || {};

        return {
            ...raw,
            account_number: accountNumber,
            account_name: accountName,
            bank,
        };
    }

    /**
     * Verify a Paystack transaction by reference
     */
    async verifyTransaction(reference: string) {
        const response = await this.client.get(`/transaction/verify/${encodeURIComponent(reference)}`);
        return response.data.data;
    }

    /**
     * Resolve a bank account number to get account name
     */
    async resolveAccountNumber(accountNumber: string, bankCode: string) {
        const response = await this.client.get("/bank/resolve", {
            params: { account_number: accountNumber, bank_code: bankCode },
        });
        return response.data.data;
    }

    /**
     * Create a transfer recipient
     */
    async createTransferRecipient(data: {
        name: string;
        account_number: string;
        bank_code: string;
        currency?: string;
    }) {
        const response = await this.client.post("/transferrecipient", {
            type: "nuban",
            currency: data.currency || "NGN",
            ...data,
        });
        logger.info("Paystack: transfer recipient created", { recipientCode: response.data?.data?.recipient_code });
        return response.data.data;
    }

    /**
     * Initiate a transfer (withdrawal)
     * Note: amount is in kobo (NGN × 100)
     */
    async initiateTransfer(data: {
        amount: number;
        recipient: string;
        reason?: string;
        reference?: string;
    }) {
        const response = await this.client.post("/transfer", {
            source: "balance",
            ...data,
        });
        logger.info("Paystack: transfer initiated", { reference: data.reference, transferCode: response.data?.data?.transfer_code });
        return response.data.data;
    }

    /**
     * List Nigerian banks
     */
    async listBanks(currency: string = "NGN") {
        const response = await this.client.get("/bank", {
            params: { currency, perPage: 100 },
        });
        return response.data.data;
    }

    /**
     * Verify/fetch transfer status by transfer code or reference
     */
    async verifyTransfer(idOrReference: string) {
        const response = await this.client.get(`/transfer/${encodeURIComponent(idOrReference)}`);
        return response.data.data;
    }

    /**
     * Verify webhook signature (HMAC SHA512)
     */
    verifyWebhookSignature(payload: string, signature: string): boolean {
        const hash = crypto
            .createHmac("sha512", config.PAYSTACK_SECRET_KEY)
            .update(payload)
            .digest("hex");
        return hash === signature;
    }
}

export default new PaystackService();
