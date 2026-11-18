import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { fxConversions } from "../db/schema";
import type { Executor } from "../db/client";
import { exec, isUuid, stripNulls } from "./utils";

export type FxConversion = typeof fxConversions.$inferSelect;
export type NewFxConversion = typeof fxConversions.$inferInsert;
export type FxConversionUpdate = Partial<Omit<NewFxConversion, "id" | "transactionId" | "createdAt" | "updatedAt">>;

class FxConversionRepository {
    /** Queues a conversion for a receipt; a second call for the same transaction does nothing */
    async queue(data: NewFxConversion, tx?: Executor): Promise<FxConversion | undefined> {
        const [row] = await exec(tx).insert(fxConversions).values(data).onConflictDoNothing({ target: fxConversions.transactionId }).returning();
        return row ? stripNulls(row) : undefined;
    }

    async findById(id: string, tx?: Executor): Promise<FxConversion | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec(tx).select().from(fxConversions).where(eq(fxConversions.id, id)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findByTransaction(transactionId: string): Promise<FxConversion | undefined> {
        if (!isUuid(transactionId)) return undefined;
        const [row] = await exec().select().from(fxConversions).where(eq(fxConversions.transactionId, transactionId)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findByProviderReference(reference: string): Promise<FxConversion | undefined> {
        const [row] = await exec().select().from(fxConversions).where(eq(fxConversions.providerReference, reference)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /** Conversions due to start, retry or check now, oldest first */
    async listDue(limit = 25, now = new Date()): Promise<FxConversion[]> {
        const rows = await exec()
            .select()
            .from(fxConversions)
            .where(and(inArray(fxConversions.status, ["pending", "processing"]), lte(fxConversions.nextAttemptAt, now)))
            .orderBy(asc(fxConversions.nextAttemptAt))
            .limit(limit);
        return rows.map((row) => stripNulls(row));
    }

    async update(id: string, patch: FxConversionUpdate, tx?: Executor): Promise<void> {
        await exec(tx).update(fxConversions).set(patch).where(eq(fxConversions.id, id));
    }

    /** Claims the next attempt of a pending conversion; false if another worker got there first */
    async claimAttempt(id: string, attempts: number, patch: FxConversionUpdate): Promise<boolean> {
        const rows = await exec().update(fxConversions).set(patch)
            .where(and(eq(fxConversions.id, id), eq(fxConversions.status, "pending"), eq(fxConversions.attempts, attempts)))
            .returning({ id: fxConversions.id });
        return rows.length > 0;
    }

    /** Moves a conversion out of `from` only if it's still there (one worker wins) */
    async updateIfStatus(id: string, from: FxConversion["status"], patch: FxConversionUpdate, tx?: Executor): Promise<boolean> {
        const rows = await exec(tx).update(fxConversions).set(patch).where(and(eq(fxConversions.id, id), eq(fxConversions.status, from))).returning({ id: fxConversions.id });
        return rows.length > 0;
    }
}

export const fxConversionRepository = new FxConversionRepository();
export default fxConversionRepository;
