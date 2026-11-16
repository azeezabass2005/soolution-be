import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { fxQuotes } from "../db/schema";
import type { Executor } from "../db/client";
import type { FxQuote } from "../types/entities";
import { exec, isUuid, stripNulls } from "./utils";

export type NewFxQuote = typeof fxQuotes.$inferInsert;

class FxQuoteRepository {
    async create(data: NewFxQuote): Promise<FxQuote> {
        const [row] = await exec().insert(fxQuotes).values(data).returning();
        return stripNulls(row);
    }

    async findOwned(id: string, userId: string): Promise<FxQuote | undefined> {
        if (!isUuid(id) || !isUuid(userId)) return undefined;
        const [row] = await exec().select().from(fxQuotes).where(and(eq(fxQuotes.id, id), eq(fxQuotes.user, userId))).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /**
     * Mark an unused, unexpired quote as used. Inside the exchange transaction,
     * so a rollback releases it again. Undefined if it's gone, used or expired.
     */
    async claim(id: string, userId: string, tx: Executor): Promise<FxQuote | undefined> {
        const now = new Date();
        const [row] = await tx
            .update(fxQuotes)
            .set({ usedAt: now })
            .where(and(eq(fxQuotes.id, id), eq(fxQuotes.user, userId), isNull(fxQuotes.usedAt), gt(fxQuotes.expiresAt, now)))
            .returning();
        return row ? stripNulls(row) : undefined;
    }

    /** Quotes are useless after a day (replaces Mongo's TTL index) */
    async deleteCreatedBefore(cutoff: Date): Promise<number> {
        const rows = await exec().delete(fxQuotes).where(lt(fxQuotes.createdAt, cutoff)).returning({ id: fxQuotes.id });
        return rows.length;
    }
}

export const fxQuoteRepository = new FxQuoteRepository();
export default fxQuoteRepository;
