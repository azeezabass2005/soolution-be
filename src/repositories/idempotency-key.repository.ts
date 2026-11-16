import { and, eq, gt, lt } from "drizzle-orm";
import { idempotencyKeys } from "../db/schema";
import type { IdempotencyKey } from "../types/entities";
import { exec, isUuid, stripNulls } from "./utils";

class IdempotencyKeyRepository {
    /** An unexpired key owned by the user */
    async findActive(key: string, userId: string): Promise<IdempotencyKey | undefined> {
        if (!isUuid(userId)) return undefined;
        const [row] = await exec()
            .select()
            .from(idempotencyKeys)
            .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.userId, userId), gt(idempotencyKeys.expiresAt, new Date())))
            .limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /**
     * Claim `key`. Returns false when it already exists (any user), which
     * is how two identical requests are told apart without a race.
     */
    async tryCreate(data: { key: string; userId: string; transactionId?: string; expiresAt: Date }): Promise<boolean> {
        const rows = await exec()
            .insert(idempotencyKeys)
            .values(data)
            .onConflictDoNothing({ target: idempotencyKeys.key })
            .returning({ id: idempotencyKeys.id });
        return rows.length > 0;
    }

    async attachTransaction(key: string, transactionId: string): Promise<IdempotencyKey | undefined> {
        const [row] = await exec().update(idempotencyKeys).set({ transactionId }).where(eq(idempotencyKeys.key, key)).returning();
        return row ? stripNulls(row) : undefined;
    }

    /** Postgres has no TTL index; the cleanup job calls this */
    async deleteExpired(now = new Date()): Promise<number> {
        const rows = await exec().delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, now)).returning({ id: idempotencyKeys.id });
        return rows.length;
    }
}

export const idempotencyKeyRepository = new IdempotencyKeyRepository();
export default idempotencyKeyRepository;
