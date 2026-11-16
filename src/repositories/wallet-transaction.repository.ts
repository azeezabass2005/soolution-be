import { and, asc, count, desc, eq, gte, inArray, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { walletTransactions } from "../db/schema";
import type { Executor } from "../db/client";
import type { WalletTransaction } from "../types/entities";
import type { WalletTransactionStatus, WalletTransactionType } from "../types/enums";
import { pageWindow, toPage, type PageRequest, type Paginated } from "../db/pagination";
import { definedOnly, exec, isUuid, stripNulls, toNumber, upper } from "./utils";

export type NewWalletTransaction = typeof walletTransactions.$inferInsert;
export type WalletTransactionUpdate = Partial<
    Omit<NewWalletTransaction, "id" | "wallet" | "user" | "reference" | "createdAt" | "updatedAt">
>;

const normalise = (data: NewWalletTransaction): NewWalletTransaction => ({
    ...data,
    currency: upper(data.currency ?? undefined),
    counterCurrency: upper(data.counterCurrency ?? undefined),
});

class WalletTransactionRepository {
    async create(data: NewWalletTransaction, tx?: Executor): Promise<WalletTransaction> {
        const [row] = await exec(tx).insert(walletTransactions).values(normalise(data)).returning();
        return stripNulls(row);
    }

    async createMany(data: NewWalletTransaction[], tx?: Executor): Promise<WalletTransaction[]> {
        if (!data.length) return [];
        const rows = await exec(tx).insert(walletTransactions).values(data.map(normalise)).returning();
        // Keep the order the caller passed
        const byReference = new Map(rows.map((row) => [row.reference, stripNulls(row)]));
        return data.map((item) => byReference.get(item.reference)!);
    }

    async findById(id: string, tx?: Executor): Promise<WalletTransaction | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec(tx).select().from(walletTransactions).where(eq(walletTransactions.id, id)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findByPaystackReference(paystackReference: string, type?: WalletTransactionType, tx?: Executor): Promise<WalletTransaction | undefined> {
        const where = type
            ? and(eq(walletTransactions.paystackReference, paystackReference), eq(walletTransactions.type, type))
            : eq(walletTransactions.paystackReference, paystackReference);
        const [row] = await exec(tx).select().from(walletTransactions).where(where).orderBy(desc(walletTransactions.createdAt)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /** A withdrawal by Paystack transfer code or our reference (webhooks send either) */
    async findByTransferCodeOrReference(transferCode: string | undefined, reference: string | undefined): Promise<WalletTransaction | undefined> {
        const conditions: SQL[] = [];
        if (transferCode) conditions.push(eq(walletTransactions.paystackTransferCode, transferCode));
        if (reference) conditions.push(eq(walletTransactions.reference, reference));
        if (!conditions.length) return undefined;
        const [row] = await exec().select().from(walletTransactions).where(or(...conditions)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findOwned(id: string, userId: string, type?: WalletTransactionType): Promise<WalletTransaction | undefined> {
        if (!isUuid(id) || !isUuid(userId)) return undefined;
        const where = [eq(walletTransactions.id, id), eq(walletTransactions.user, userId)];
        if (type) where.push(eq(walletTransactions.type, type));
        const [row] = await exec().select().from(walletTransactions).where(and(...where)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async update(id: string, patch: WalletTransactionUpdate, tx?: Executor): Promise<WalletTransaction | undefined> {
        if (!isUuid(id)) return undefined;
        const values = definedOnly(patch as Record<string, unknown>);
        if (!Object.keys(values).length) return this.findById(id, tx);
        const [row] = await exec(tx).update(walletTransactions).set(values).where(eq(walletTransactions.id, id)).returning();
        return row ? stripNulls(row) : undefined;
    }

    /**
     * Change the row only while its status is not one of `notIn`; returns the
     * updated row, or undefined if another caller already moved it.
     */
    async claim(
        id: string,
        notIn: WalletTransactionStatus[],
        patch: WalletTransactionUpdate,
        tx: Executor
    ): Promise<WalletTransaction | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await tx
            .update(walletTransactions)
            .set(definedOnly(patch as Record<string, unknown>))
            .where(and(eq(walletTransactions.id, id), notInArray(walletTransactions.status, notIn)))
            .returning();
        return row ? stripNulls(row) : undefined;
    }

    /** Claim the pending manual-payout hold for a transaction (one caller wins) */
    async claimPendingTransferFor(transactionId: string, patch: WalletTransactionUpdate, tx: Executor): Promise<WalletTransaction | undefined> {
        if (!isUuid(transactionId)) return undefined;
        const [pending] = await tx
            .select({ id: walletTransactions.id })
            .from(walletTransactions)
            .where(
                and(
                    eq(walletTransactions.transactionId, transactionId),
                    eq(walletTransactions.type, "transfer"),
                    eq(walletTransactions.status, "pending")
                )
            )
            .orderBy(walletTransactions.createdAt)
            .limit(1)
            .for("update");
        if (!pending) return undefined;
        const [row] = await tx
            .update(walletTransactions)
            .set(definedOnly(patch as Record<string, unknown>))
            .where(and(eq(walletTransactions.id, pending.id), eq(walletTransactions.status, "pending")))
            .returning();
        return row ? stripNulls(row) : undefined;
    }

    /** Rows of `type` stuck in `status` since before `createdBefore`, oldest first (sweeper) */
    async listStale(type: WalletTransactionType, status: WalletTransactionStatus, createdBefore: Date, limit: number): Promise<WalletTransaction[]> {
        const rows = await exec()
            .select()
            .from(walletTransactions)
            .where(and(eq(walletTransactions.type, type), eq(walletTransactions.status, status), lte(walletTransactions.createdAt, createdBefore)))
            .orderBy(asc(walletTransactions.createdAt))
            .limit(limit);
        return rows.map(stripNulls);
    }

    /** Sum of a user's withdrawals since `since` that are successful or still in progress */
    async withdrawalTotalSince(userId: string, since: Date): Promise<number> {
        const [row] = await exec()
            .select({ total: sql<string>`coalesce(sum(${walletTransactions.amount}), 0)` })
            .from(walletTransactions)
            .where(
                and(
                    eq(walletTransactions.user, userId),
                    eq(walletTransactions.type, "withdrawal"),
                    inArray(walletTransactions.status, ["successful", "processing", "pending"]),
                    gte(walletTransactions.createdAt, since)
                )
            );
        return toNumber(row?.total);
    }

    /** A user's history, newest first. `wallet: null` (an unopened wallet) returns nothing. */
    async paginateForUser(
        filter: { user: string; type?: string; wallet?: string | null },
        request: PageRequest
    ): Promise<Paginated<WalletTransaction>> {
        const window = pageWindow(request);
        if (filter.wallet === null || !isUuid(filter.user)) return toPage([], 0, window);
        const where: SQL[] = [eq(walletTransactions.user, filter.user)];
        if (filter.type) where.push(eq(walletTransactions.type, filter.type as WalletTransactionType));
        if (filter.wallet) where.push(eq(walletTransactions.wallet, filter.wallet));
        const condition = and(...where);
        const [rows, [{ n }]] = await Promise.all([
            exec().select().from(walletTransactions).where(condition).orderBy(desc(walletTransactions.createdAt), desc(walletTransactions.id)).limit(window.limit).offset(window.offset),
            exec().select({ n: count() }).from(walletTransactions).where(condition),
        ]);
        return toPage(rows.map(stripNulls), Number(n), window);
    }
}

export const walletTransactionRepository = new WalletTransactionRepository();
export default walletTransactionRepository;
