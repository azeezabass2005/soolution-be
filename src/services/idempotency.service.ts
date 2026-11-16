import idempotencyKeyRepository from "../repositories/idempotency-key.repository";
import type { IdempotencyKey } from "../types/entities";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";

class IdempotencyService {
    /** An existing, unexpired key for this user (or undefined) */
    public async checkKey(key: string, userId: string): Promise<IdempotencyKey | undefined> {
        return idempotencyKeyRepository.findActive(key, userId);
    }

    /**
     * Updates an idempotency key with the transaction it created
     */
    public async updateKeyWithTransaction(key: string, transactionId: string): Promise<IdempotencyKey | undefined> {
        return idempotencyKeyRepository.attachTransaction(key, transactionId);
    }

    /**
     * Validates and handles an idempotency key for transaction creation.
     * If the key exists and has a transaction, returns that transaction's id.
     * If it doesn't exist, claims it (atomically, so two identical requests
     * can't both get through).
     */
    public async validateKey(key: string, userId: string, expirationHours: number = 24): Promise<{
        isDuplicate: boolean;
        transactionId?: string;
    }> {
        const existingKey = await this.checkKey(key, userId);

        if (existingKey) {
            if (existingKey.transactionId) {
                return { isDuplicate: true, transactionId: existingKey.transactionId };
            }
            // Key exists but its transaction isn't recorded yet (still in flight, or it failed)
            throw errorResponseMessage.createError(409, "Idempotency key already exists but no transaction found", ErrorSeverity.HIGH);
        }

        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + expirationHours);
        const claimed = await idempotencyKeyRepository.tryCreate({ key, userId, expiresAt });
        if (!claimed) {
            // Another request with the same key got there first (or the key belongs to someone else)
            throw errorResponseMessage.createError(409, "Idempotency key already exists but no transaction found", ErrorSeverity.HIGH);
        }

        return { isDuplicate: false };
    }

    /** Deletes expired keys (Postgres has no TTL index; the cleanup job calls this) */
    public async cleanupExpiredKeys(): Promise<number> {
        return idempotencyKeyRepository.deleteExpired();
    }
}

export default IdempotencyService;
