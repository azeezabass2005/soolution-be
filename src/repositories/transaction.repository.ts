import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, notInArray, sql, type SQL } from "drizzle-orm";
import { transactionDetails, transactions, users } from "../db/schema";
import type { Executor } from "../db/client";
import type { PublicUser, Transaction, TransactionDetail, TransactionView } from "../types/entities";
import type { DetailType, TransactionStatus } from "../types/enums";
import { TRANSACTION_STATUS } from "../common/constant";
import { pageWindow, toPage, type PageRequest, type Paginated } from "../db/pagination";
import { definedOnly, escapeLike, exec, isUuid, stripNulls, toNumber, upper } from "./utils";
import { toPublicUser, toUser } from "./user.repository";

type TransactionRow = typeof transactions.$inferSelect;
type TransactionInsert = typeof transactions.$inferInsert;

export type NewTransaction = Omit<TransactionInsert, "payerName" | "payerEmail" | "user"> & {
    user: string;
    payer?: { name?: string; email?: string };
};

export type TransactionUpdate = Partial<
    Omit<TransactionInsert, "id" | "user" | "reference" | "createdAt" | "updatedAt" | "payerName" | "payerEmail">
>;

export function toTransaction(row: TransactionRow): Transaction {
    const { payerName, payerEmail, ...rest } = stripNulls(row);
    return payerName || payerEmail ? { ...rest, payer: stripNulls({ name: payerName ?? null, email: payerEmail ?? null }) } : rest;
}

/**
 * Keep completedAt / failedAt consistent with the status on creation, as the
 * Mongoose pre-save hook did.
 */
function normaliseTimestamps(data: TransactionInsert): TransactionInsert {
    const out = { ...data };
    if (out.status === TRANSACTION_STATUS.COMPLETED) {
        out.completedAt ??= new Date();
        out.failedAt = null;
    } else if (out.status === TRANSACTION_STATUS.FAILED) {
        out.failedAt ??= new Date();
        out.completedAt = null;
    } else if (!out.status || out.status === TRANSACTION_STATUS.PENDING || out.status === TRANSACTION_STATUS.PROCESSING) {
        out.completedAt = null;
        out.failedAt = null;
    }
    return out;
}

export interface TransactionListFilter {
    user?: string;
    /** One currency, or any of several */
    currency?: string | string[];
    status?: string;
    createdFrom?: Date;
    createdTo?: Date;
    /** Matches the reference (case-insensitive, partial) */
    search?: string;
}

function listWhere(filter: TransactionListFilter): SQL | undefined {
    const where: SQL[] = [];
    if (filter.user) where.push(eq(transactions.user, filter.user));
    if (Array.isArray(filter.currency)) where.push(inArray(transactions.currency, filter.currency));
    else if (filter.currency) where.push(eq(transactions.currency, filter.currency));
    if (filter.status) where.push(eq(transactions.status, filter.status as TransactionStatus));
    if (filter.createdFrom) where.push(gte(transactions.createdAt, filter.createdFrom));
    if (filter.createdTo) where.push(lte(transactions.createdAt, filter.createdTo));
    if (filter.search) where.push(ilike(transactions.reference, `%${escapeLike(filter.search)}%`));
    return where.length ? and(...where) : undefined;
}

class TransactionRepository {
    async create(data: NewTransaction, tx?: Executor): Promise<Transaction> {
        const { payer, ...rest } = data;
        const values = normaliseTimestamps({
            ...rest,
            currency: upper(rest.currency)!,
            fromCurrency: upper(rest.fromCurrency)!,
            lockedRateFromCurrency: upper(rest.lockedRateFromCurrency ?? undefined),
            lockedRateToCurrency: upper(rest.lockedRateToCurrency ?? undefined),
            payerName: payer?.name?.trim() || undefined,
            payerEmail: payer?.email?.trim().toLowerCase() || undefined,
        });
        const [row] = await exec(tx).insert(transactions).values(values).returning();
        return toTransaction(row);
    }

    async findById(id: string, tx?: Executor): Promise<Transaction | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec(tx).select().from(transactions).where(eq(transactions.id, id)).limit(1);
        return row ? toTransaction(row) : undefined;
    }

    async findByReference(reference: string, paymentLinkId?: string): Promise<Transaction | undefined> {
        const where = paymentLinkId
            ? and(eq(transactions.reference, reference), eq(transactions.paymentLink, paymentLinkId))
            : eq(transactions.reference, reference);
        const [row] = await exec().select().from(transactions).where(where).limit(1);
        return row ? toTransaction(row) : undefined;
    }

    async findByReceiptToken(token: string): Promise<Transaction | undefined> {
        const [row] = await exec().select().from(transactions).where(eq(transactions.receiptToken, token)).limit(1);
        return row ? toTransaction(row) : undefined;
    }

    async update(id: string, patch: TransactionUpdate, tx?: Executor): Promise<Transaction | undefined> {
        if (!isUuid(id)) return undefined;
        const values = definedOnly(patch as Record<string, unknown>);
        if (!Object.keys(values).length) return this.findById(id, tx);
        const [row] = await exec(tx).update(transactions).set(values).where(eq(transactions.id, id)).returning();
        return row ? toTransaction(row) : undefined;
    }

    /**
     * Apply `patch` only while the status is still `expected`. Returns the
     * updated transaction, or undefined when another caller changed it first.
     */
    async updateIfStatus(id: string, expected: TransactionStatus, patch: TransactionUpdate, tx?: Executor): Promise<Transaction | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec(tx)
            .update(transactions)
            .set(definedOnly(patch as Record<string, unknown>))
            .where(and(eq(transactions.id, id), eq(transactions.status, expected)))
            .returning();
        return row ? toTransaction(row) : undefined;
    }

    /** Lock the row for the rest of the transaction, only if it has `status` */
    async findByIdForUpdate(id: string, status: TransactionStatus, tx: Executor): Promise<Transaction | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await tx
            .select()
            .from(transactions)
            .where(and(eq(transactions.id, id), eq(transactions.status, status)))
            .for("update")
            .limit(1);
        return row ? toTransaction(row) : undefined;
    }

    /** Sets the receipt token unless one is already set; returns the token now stored */
    async setReceiptTokenIfMissing(id: string, token: string): Promise<string | undefined> {
        const [row] = await exec()
            .update(transactions)
            .set({ receiptToken: token })
            .where(and(eq(transactions.id, id), isNull(transactions.receiptToken)))
            .returning({ receiptToken: transactions.receiptToken });
        if (row?.receiptToken) return row.receiptToken;
        return (await this.findById(id))?.receiptToken;
    }

    /** The user's transactions created since `since`, excluding `excludeStatuses` (daily limit) */
    async listForLimit(userId: string, since: Date, excludeStatuses: TransactionStatus[]) {
        if (!isUuid(userId)) return [];
        const rows = await exec()
            .select({ ngnValue: transactions.ngnValue, amount: transactions.amount, currency: transactions.currency })
            .from(transactions)
            .where(and(eq(transactions.user, userId), gte(transactions.createdAt, since), notInArray(transactions.status, excludeStatuses)));
        return rows.map((row) => stripNulls(row) as { ngnValue?: number; amount: number; currency: string });
    }

    /** Stuck provider transactions for the sweeper, oldest first */
    async listStale(detailType: DetailType, statuses: TransactionStatus[], initiatedBefore: Date, limit: number): Promise<Transaction[]> {
        const rows = await exec()
            .select()
            .from(transactions)
            .where(and(eq(transactions.detailType, detailType), inArray(transactions.status, statuses), lte(transactions.initiatedAt, initiatedBefore)))
            .orderBy(asc(transactions.initiatedAt))
            .limit(limit);
        return rows.map(toTransaction);
    }

    async count(filter: { detailType?: DetailType; status?: TransactionStatus } = {}): Promise<number> {
        const where: SQL[] = [];
        if (filter.detailType) where.push(eq(transactions.detailType, filter.detailType));
        if (filter.status) where.push(eq(transactions.status, filter.status));
        const [row] = await exec().select({ n: count() }).from(transactions).where(where.length ? and(...where) : undefined);
        return Number(row?.n ?? 0);
    }

    /** Move every transaction of `userId` in `from` to `to` */
    async moveStatusForUser(userId: string, from: TransactionStatus, to: TransactionStatus): Promise<number> {
        const rows = await exec()
            .update(transactions)
            .set({ status: to })
            .where(and(eq(transactions.user, userId), eq(transactions.status, from)))
            .returning({ id: transactions.id });
        return rows.length;
    }

    /** How many transactions the user created since `since` (rate limiting) */
    async countCreatedSince(userId: string, since: Date): Promise<number> {
        if (!isUuid(userId)) return 0;
        const [row] = await exec()
            .select({ n: count() })
            .from(transactions)
            .where(and(eq(transactions.user, userId), gte(transactions.createdAt, since)));
        return Number(row?.n ?? 0);
    }

    /** Whether the user has an open transaction with the same amount and currencies since `since` */
    async hasSimilarSince(
        userId: string,
        match: { amount: number; fromCurrency: string; currency: string; statuses: TransactionStatus[] },
        since: Date
    ): Promise<boolean> {
        if (!isUuid(userId) || !Number.isFinite(match.amount)) return false;
        const [row] = await exec()
            .select({ id: transactions.id })
            .from(transactions)
            .where(
                and(
                    eq(transactions.user, userId),
                    eq(transactions.amount, match.amount),
                    eq(transactions.fromCurrency, match.fromCurrency),
                    eq(transactions.currency, match.currency),
                    inArray(transactions.status, match.statuses),
                    gte(transactions.createdAt, since)
                )
            )
            .limit(1);
        return !!row;
    }

    // ───────────── Payment links ─────────────

    /** Completed payments per link: how many and how much */
    async paymentLinkStats(linkIds: string[]): Promise<Map<string, { paid: number; totalPaid: number }>> {
        const ids = linkIds.filter(isUuid);
        if (!ids.length) return new Map();
        const rows = await exec()
            .select({
                link: transactions.paymentLink,
                paid: count(),
                totalPaid: sql<string>`coalesce(sum(${transactions.amount}), 0)`,
            })
            .from(transactions)
            .where(and(inArray(transactions.paymentLink, ids), eq(transactions.status, TRANSACTION_STATUS.COMPLETED as TransactionStatus)))
            .groupBy(transactions.paymentLink);
        return new Map(rows.map((row) => [row.link!, { paid: Number(row.paid), totalPaid: toNumber(row.totalPaid) }]));
    }

    async hasCompletedPaymentForLink(linkId: string): Promise<boolean> {
        const [row] = await exec()
            .select({ id: transactions.id })
            .from(transactions)
            .where(and(eq(transactions.paymentLink, linkId), eq(transactions.status, TRANSACTION_STATUS.COMPLETED as TransactionStatus)))
            .limit(1);
        return !!row;
    }

    async countForLink(linkId: string, statuses: TransactionStatus[], createdSince: Date): Promise<number> {
        const [row] = await exec()
            .select({ n: count() })
            .from(transactions)
            .where(and(eq(transactions.paymentLink, linkId), inArray(transactions.status, statuses), gte(transactions.createdAt, createdSince)));
        return Number(row?.n ?? 0);
    }

    // ───────────── Views (transaction + details + owner) ─────────────

    /** Transactions with their detail and owner, as the API returns them */
    async toViews(rows: Transaction[], tx?: Executor): Promise<TransactionView[]> {
        if (!rows.length) return [];
        const ids = rows.map((row) => row.id);
        const ownerIds = [...new Set(rows.map((row) => row.user))];
        const [detailRows, ownerRows] = await Promise.all([
            exec(tx).select().from(transactionDetails).where(inArray(transactionDetails.transactionId, ids)),
            exec(tx).select().from(users).where(inArray(users.id, ownerIds)),
        ]);
        const details = new Map(detailRows.map((row) => [row.transactionId, stripNulls(row) as TransactionDetail]));
        const owners = new Map<string, PublicUser>(ownerRows.map((row) => [row.id, toPublicUser(toUser(row))]));
        return rows.map((row) => ({ ...row, user: owners.get(row.user) ?? row.user, details: details.get(row.id) }));
    }

    async findViewById(id: string, tx?: Executor): Promise<TransactionView | undefined> {
        const transaction = await this.findById(id, tx);
        if (!transaction) return undefined;
        const [view] = await this.toViews([transaction], tx);
        return view;
    }

    /** Newest first, with details and owner */
    async paginateViews(filter: TransactionListFilter, request: PageRequest): Promise<Paginated<TransactionView>> {
        const window = pageWindow(request);
        const where = listWhere(filter);
        const [rows, [{ n }]] = await Promise.all([
            exec().select().from(transactions).where(where).orderBy(desc(transactions.createdAt), desc(transactions.id)).limit(window.limit).offset(window.offset),
            exec().select({ n: count() }).from(transactions).where(where),
        ]);
        return toPage(await this.toViews(rows.map(toTransaction)), Number(n), window);
    }

    /** Latest transactions with a few owner fields (admin dashboard) */
    async recentWithOwner(limit: number) {
        const rows = await exec()
            .select({ transaction: transactions, firstName: users.firstName, lastName: users.lastName, email: users.email })
            .from(transactions)
            .leftJoin(users, eq(users.id, transactions.user))
            .orderBy(desc(transactions.createdAt))
            .limit(limit);
        return rows.map(({ transaction, firstName, lastName, email }) => ({
            ...toTransaction(transaction),
            user: firstName !== null ? { id: transaction.user, firstName, lastName, email } : transaction.user,
        }));
    }

    /**
     * Dashboard totals. The NGN/GHS equivalent of a transaction is the detail's
     * fromAmount (else amount) when it was paid from NGN/GHS, the amount when it
     * pays out in NGN/GHS, and 0 otherwise.
     */
    async dashboardTotals(statuses?: TransactionStatus[]): Promise<{ count: number; total: number }> {
        const normalised = sql<string>`coalesce(sum(case
            when ${transactions.fromCurrency} in ('NGN', 'GHS') then coalesce(${transactionDetails.fromAmount}, ${transactions.amount})
            when ${transactions.currency} in ('NGN', 'GHS') then ${transactions.amount}
            else 0 end), 0)`;
        const [row] = await exec()
            .select({ n: count(), total: normalised })
            .from(transactions)
            .leftJoin(transactionDetails, eq(transactionDetails.transactionId, transactions.id))
            .where(statuses?.length ? inArray(transactions.status, statuses) : undefined);
        return { count: Number(row?.n ?? 0), total: toNumber(row?.total) };
    }
}

export const transactionRepository = new TransactionRepository();
export default transactionRepository;
