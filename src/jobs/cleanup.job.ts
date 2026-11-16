import idempotencyKeyRepository from '../repositories/idempotency-key.repository';
import fxQuoteRepository from '../repositories/fx-quote.repository';
import transactionLimitLockRepository from '../repositories/transaction-limit-lock.repository';
import logger from '../utils/logger.utils';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Deletes rows Mongo used to expire with TTL indexes:
 *   - idempotency keys past their expiresAt
 *   - FX quotes older than a day
 *   - transaction-limit locks whose holder died over an hour ago
 */
export async function runExpiredRecordCleanup(): Promise<void> {
    const now = Date.now();
    const [idempotencyKeys, fxQuotes, limitLocks] = await Promise.all([
        idempotencyKeyRepository.deleteExpired(new Date(now)),
        fxQuoteRepository.deleteCreatedBefore(new Date(now - DAY_MS)),
        transactionLimitLockRepository.deleteExpired(new Date(now - HOUR_MS)),
    ]);
    logger.info('Expired records cleaned up', { idempotencyKeys, fxQuotes, limitLocks });
}
