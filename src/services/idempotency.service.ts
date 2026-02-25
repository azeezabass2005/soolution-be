import DBService from "../utils/db.utils";
import { IIdempotencyKey } from "../models/idempotency-key.model";
import IdempotencyKey from "../models/idempotency-key.model";
import { Types } from "mongoose";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";

class IdempotencyService extends DBService<IIdempotencyKey> {
    /**
     * Creates an instance of IdempotencyService
     * @constructor
     */
    constructor() {
        super(IdempotencyKey);
    }

    /**
     * Checks if an idempotency key exists and is valid
     * @param key Idempotency key to check
     * @param userId User ID associated with the key
     * @returns Existing idempotency key record if found, null otherwise
     */
    public async checkKey(key: string, userId: string): Promise<IIdempotencyKey | null> {
        const idempotencyKey = await this.findOne({
            key,
            userId: new Types.ObjectId(userId),
            expiresAt: { $gt: new Date() } // Only get non-expired keys
        });

        return idempotencyKey;
    }

    /**
     * Creates a new idempotency key record
     * @param key Idempotency key
     * @param userId User ID
     * @param transactionId Transaction ID (optional, can be set later)
     * @param expirationHours Hours until expiration (default: 24)
     * @returns Created idempotency key record
     */
    public async createKey(
        key: string,
        userId: string,
        transactionId?: string,
        expirationHours: number = 24
    ): Promise<IIdempotencyKey> {
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + expirationHours);

        const idempotencyKey = await this.create({
            key,
            userId: new Types.ObjectId(userId),
            transactionId: transactionId ? new Types.ObjectId(transactionId) : undefined,
            expiresAt
        });

        return idempotencyKey;
    }

    /**
     * Updates an idempotency key with a transaction ID
     * @param key Idempotency key
     * @param transactionId Transaction ID to associate
     * @returns Updated idempotency key record
     */
    public async updateKeyWithTransaction(key: string, transactionId: string): Promise<IIdempotencyKey | null> {
        const idempotencyKey = await this.findOne({ key });

        if (!idempotencyKey) {
            return null;
        }

        return await this.updateById((idempotencyKey._id as Types.ObjectId).toString(), {
            transactionId: new Types.ObjectId(transactionId)
        });
    }

    /**
     * Validates and handles idempotency key for transaction creation
     * If key exists and has a transaction, returns the existing transaction ID
     * If key doesn't exist, creates a new key record
     * @param key Idempotency key
     * @param userId User ID
     * @returns Object with isDuplicate flag and existing transactionId if duplicate
     */
    public async validateKey(key: string, userId: string): Promise<{
        isDuplicate: boolean;
        transactionId?: string;
    }> {
        const existingKey = await this.checkKey(key, userId);

        if (existingKey) {
            // Key exists and is valid
            if (existingKey.transactionId) {
                // Transaction already created with this key
                return {
                    isDuplicate: true,
                    transactionId: existingKey.transactionId.toString()
                };
            }
            // Key exists but no transaction yet - this shouldn't happen in normal flow
            // but handle it gracefully
            throw errorResponseMessage.createError(
                409,
                "Idempotency key already exists but no transaction found",
                ErrorSeverity.HIGH
            );
        }

        // Key doesn't exist, create it
        await this.createKey(key, userId);

        return {
            isDuplicate: false
        };
    }

    /**
     * Cleans up expired idempotency keys (called by scheduled job)
     * Note: MongoDB TTL index should handle this automatically, but this method
     * can be used for manual cleanup if needed
     */
    public async cleanupExpiredKeys(): Promise<number> {
        const result = await this.deleteMany({
            expiresAt: { $lt: new Date() }
        });

        return result.deletedCount || 0;
    }
}

export default IdempotencyService;
