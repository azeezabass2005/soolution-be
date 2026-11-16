import { and, asc, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import { accounts } from "../db/schema";
import type { Executor } from "../db/client";
import type { Account } from "../types/entities";
import type { AccountType } from "../types/enums";
import { escapeLike, exec, stripNulls, upper } from "./utils";

export type NewAccount = typeof accounts.$inferInsert;

class AccountRepository {
    async findByCode(code: string, tx?: Executor): Promise<Account | undefined> {
        const [row] = await exec(tx).select().from(accounts).where(eq(accounts.code, code)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findByCodes(codes: string[], tx?: Executor): Promise<Account[]> {
        if (!codes.length) return [];
        const rows = await exec(tx).select().from(accounts).where(inArray(accounts.code, codes));
        return rows.map(stripNulls);
    }

    /**
     * Create the account unless one with this code exists. Never touches an
     * existing account's balance. Returns true when it was created.
     */
    async createIfMissing(data: NewAccount, tx?: Executor): Promise<boolean> {
        const rows = await exec(tx)
            .insert(accounts)
            .values({ ...data, currency: upper(data.currency)! })
            .onConflictDoNothing({ target: accounts.code })
            .returning({ id: accounts.id });
        return rows.length > 0;
    }

    /**
     * Apply balance deltas atomically. Codes are updated in sorted order so
     * concurrent postings always lock accounts in the same order (no deadlocks).
     */
    async applyBalanceDeltas(deltas: Map<string, number>, at: Date, tx: Executor): Promise<void> {
        const codes = [...deltas.keys()].sort();
        for (const code of codes) {
            const delta = deltas.get(code)!;
            await tx
                .update(accounts)
                .set({ balance: sql`${accounts.balance} + ${String(delta)}::numeric`, balanceUpdatedAt: at })
                .where(eq(accounts.code, code));
        }
    }

    async setBalance(code: string, balance: number, tx?: Executor): Promise<void> {
        await exec(tx).update(accounts).set({ balance, balanceUpdatedAt: new Date() }).where(eq(accounts.code, code));
    }

    async listAll(tx?: Executor): Promise<Account[]> {
        const rows = await exec(tx).select().from(accounts).orderBy(asc(accounts.code));
        return rows.map(stripNulls);
    }

    /** Admin chart of accounts */
    async search(filter: { type?: string; currency?: string; code?: string }, limit = 500): Promise<Account[]> {
        const where: SQL[] = [];
        if (filter.type) where.push(eq(accounts.type, filter.type as AccountType));
        if (filter.currency) where.push(eq(accounts.currency, filter.currency.toUpperCase()));
        if (filter.code) where.push(ilike(accounts.code, `%${escapeLike(filter.code)}%`));
        const rows = await exec()
            .select()
            .from(accounts)
            .where(where.length ? and(...where) : undefined)
            .orderBy(asc(accounts.type), asc(accounts.code))
            .limit(limit);
        return rows.map(stripNulls);
    }
}

export const accountRepository = new AccountRepository();
export default accountRepository;
