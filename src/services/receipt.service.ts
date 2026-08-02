import crypto from "crypto";
import Transaction from "../models/transaction.model";
import TransactionDetail from "../models/transaction-details.model";
import { TRANSACTION_STATUS } from "../common/constant";
import logger from "../utils/logger.utils";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const TOKEN_LENGTH = 22;

/**
 * Backs the shareable receipt and its public verification page.
 *
 * Two rules govern everything here:
 *   1. The token is unguessable and unrelated to the reference. References
 *      are sequential, so exposing them publicly would let anyone walk the
 *      whole transaction table.
 *   2. The public projection is a deliberate allow-list. Receipts get
 *      forwarded to third parties, so anything not explicitly listed below
 *      must never leave this service.
 */
class ReceiptService {
    /**
     * Rejection-sampled base62 so the distribution stays uniform — `% 62`
     * over raw bytes would bias the first few characters.
     */
    private generateToken(): string {
        let out = "";
        while (out.length < TOKEN_LENGTH) {
            const bytes = crypto.randomBytes(TOKEN_LENGTH);
            for (const byte of bytes) {
                if (byte < 248) out += BASE62[byte % 62];
                if (out.length === TOKEN_LENGTH) break;
            }
        }
        return out;
    }

    /**
     * Return the transaction's receipt token, minting one on first use.
     * Only the owner may call this — the caller must pass the authenticated
     * user id and it is checked against the transaction.
     */
    public async getOrCreateToken(transactionId: string, userId: string): Promise<string> {
        const tx = await Transaction.findById(transactionId);
        if (!tx) {
            throw Object.assign(new Error("Transaction not found"), { response_code: 404 });
        }
        if (String(tx.user) !== String(userId)) {
            // Same shape as not-found so this can't be used as an oracle.
            throw Object.assign(new Error("Transaction not found"), { response_code: 404 });
        }
        if (tx.status !== TRANSACTION_STATUS.COMPLETED) {
            throw Object.assign(
                new Error("A receipt is only available once the transaction has completed"),
                { response_code: 409 },
            );
        }
        if (tx.receiptToken) return tx.receiptToken;

        // Retry on the astronomically unlikely unique-index collision rather
        // than failing the user's request.
        for (let attempt = 0; attempt < 3; attempt++) {
            const token = this.generateToken();
            try {
                tx.receiptToken = token;
                await tx.save();
                logger.info("Receipt token minted", { transactionId, attempt });
                return token;
            } catch (error: any) {
                if (error?.code === 11000 && attempt < 2) continue;
                throw error;
            }
        }
        throw new Error("Could not allocate a receipt token");
    }

    /**
     * Mask a name to initial-plus-surname-initial: "Jane Doe" -> "Jane D."
     * Keeps the receipt checkable without publishing the recipient's
     * full identity to anyone who gets the link.
     */
    private maskName(name?: string): string {
        if (!name) return "—";
        const parts = String(name).trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) return "—";
        if (parts.length === 1) return parts[0];
        return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
    }

    /** 0240000001 -> 024****001 */
    private maskAccount(value?: string): string {
        if (!value) return "—";
        const s = String(value).trim();
        if (s.length <= 5) return "*".repeat(s.length);
        const head = s.slice(0, 3);
        const tail = s.slice(-3);
        return `${head}${"*".repeat(Math.max(3, s.length - 6))}${tail}`;
    }

    /**
     * The public, unauthenticated view of a receipt.
     *
     * Allow-list only. Never add user id, email, phone, wallet balance,
     * sender identity, provider ids or raw provider payloads here.
     */
    public async verify(token: string): Promise<{
        verified: boolean;
        receipt?: Record<string, any>;
    }> {
        if (!token || typeof token !== "string" || token.length !== TOKEN_LENGTH) {
            return { verified: false };
        }
        const tx = await Transaction.findOne({ receiptToken: token });
        if (!tx || tx.status !== TRANSACTION_STATUS.COMPLETED) {
            return { verified: false };
        }
        const detail: any = await TransactionDetail.findOne({ transactionId: tx._id });

        return {
            verified: true,
            receipt: {
                reference: tx.reference,
                status: tx.status,
                amount: tx.amount,
                currency: tx.currency,
                fromCurrency: tx.fromCurrency,
                fromAmount: detail?.fromAmount ?? null,
                completedAt: tx.completedAt ?? null,
                initiatedAt: tx.initiatedAt ?? null,
                recipientName: this.maskName(detail?.momoName || detail?.accountName),
                recipientAccount: this.maskAccount(detail?.momoNumber || detail?.accountNumber),
                method: detail?.institutionType || null,
                network: detail?.momoNetwork || detail?.ogNetwork || null,
            },
        };
    }
}

export default new ReceiptService();
