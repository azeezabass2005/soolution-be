import { and, eq, lt, lte } from "drizzle-orm";
import { transactionLimitLocks } from "../db/schema";
import { exec } from "./utils";

class TransactionLimitLockRepository {
    /**
     * Take the lock for `key` if it's free or its holder's time ran out.
     * One statement, so two requests can't both get it.
     */
    async tryAcquire(key: string, token: string, ttlMs: number): Promise<boolean> {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + ttlMs);
        const rows = await exec()
            .insert(transactionLimitLocks)
            .values({ key, token, expiresAt })
            .onConflictDoUpdate({
                target: transactionLimitLocks.key,
                set: { token, expiresAt },
                setWhere: lte(transactionLimitLocks.expiresAt, now),
            })
            .returning({ token: transactionLimitLocks.token });
        return rows.length > 0 && rows[0].token === token;
    }

    /** Release only if we still hold it */
    async release(key: string, token: string): Promise<void> {
        await exec().delete(transactionLimitLocks).where(and(eq(transactionLimitLocks.key, key), eq(transactionLimitLocks.token, token)));
    }

    /** Clean up locks whose holders died (replaces Mongo's TTL index) */
    async deleteExpired(olderThan: Date): Promise<number> {
        const rows = await exec()
            .delete(transactionLimitLocks)
            .where(lt(transactionLimitLocks.expiresAt, olderThan))
            .returning({ key: transactionLimitLocks.key });
        return rows.length;
    }
}

export const transactionLimitLockRepository = new TransactionLimitLockRepository();
export default transactionLimitLockRepository;
