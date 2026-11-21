import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, notInArray, sql, type SQL } from "drizzle-orm";
import { fxConversions, transactionDetails, transactions, users, walletTransactions } from "../db/schema";
import type { Executor } from "../db/client";
import type { PublicUser, Transaction, TransactionDetail, TransactionView, WalletTransaction } from "../types/entities";
import type { DetailType, TransactionStatus, WalletTransactionStatus } from "../types/enums";
import { TRANSACTION_STATUS } from "../common/constant";
import { pageWindow, toPage, type PageRequest, type Paginated } from "../db/pagination";
import { definedOnly, escapeLike, exec, isUuid, stripNulls, toNumber, upper } from "./utils";
import { toPublicUser, toUser } from "./user.repository";

type TransactionRow = typeof transactions.$inferSelect;
type TransactionInsert = typeof transactions.$inferInsert;

export type NewTransaction = Omit<TransactionInsert, "payerName" | "payerEmail" | "payerPhone" | "user"> & {
    user: string;
    payer?: { name?: string; email?: string; phone?: string };
};

export type TransactionUpdate = Partial<
    Omit<TransactionInsert, "id" | "user" | "reference" | "createdAt" | "updatedAt" | "payerName" | "payerEmail" | "payerPhone">
>;

export function toTransaction(row: TransactionRow): Transaction {
    const { payerName, payerEmail, payerPhone, ...rest } = stripNulls(row);
    return payerName || payerEmail || payerPhone
        ? { ...rest, payer: stripNulls({ name: payerName ?? null, email: payerEmail ?? null, phone: payerPhone ?? null }) }
        : rest;
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
    /** Leave out receives (collections and top-ups) that failed or were cancelled: users don't need them, admins do */
    hideFailedReceives?: boolean;
}

/**
 * A receive: a top-up, or money collected from a payer through a provider.
 * Sends always record the wallet that paid (funding_currency); receives don't.
 */
const isReceive = sql`(coalesce(${transactions.purpose}, '') = 'top_up' or (
    ${transactions.detailType} in ('yellowcard', 'fincra', 'spotflow', 'ogateway')
    and ${transactions.currency} <> ${transactions.fromCurrency}
    and not exists (select 1 from transaction_details d where d.transaction_id = "transactions"."id" and d.funding_currency is not null)
))`;

/**
 * The wallet statuses a funding can be in for a transaction status filter.
 * undefined means any status; an empty list means no funding matches.
 */
function fundingStatuses(status?: string): WalletTransactionStatus[] | undefined {
    if (!status) return undefined;
    const map: Record<string, WalletTransactionStatus[]> = {
        completed: ["successful"],
        in_progress: ["pending", "processing"],
        pending: ["pending"],
        processing: ["processing"],
        unsuccessful: ["failed", "reversed"],
        failed: ["failed"],
    };
    return (map[status] ?? []) as WalletTransactionStatus[];
}

/** One row of the history page: a transaction, or a wallet funding shaped like one */
export type HistoryRow = TransactionView | (Record<string, unknown> & { isFunding: true });

/** A funding in the shape the transaction lists render */
function fundingAsRow(row: WalletTransaction): HistoryRow {
    const status = row.status === "successful" ? "completed" : row.status;
    return {
        id: row.id,
        reference: row.reference,
        fromCurrency: row.currency || "NGN",
        currency: row.currency || "NGN",
        amount: toNumber(row.amount as any),
        detailType: "funding",
        details: stripNulls({ type: "funding", description: row.description ?? null, fee: row.fee != null ? toNumber(row.fee as any) : null, balanceAfter: toNumber(row.balanceAfter as any) }),
        status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        isFunding: true,
    };
}

/**
 * Filters users pick from, each covering the statuses behind it:
 * "in_progress" is anything not finished yet, "unsuccessful" is failed or cancelled.
 */
const STATUS_GROUPS: Record<string, TransactionStatus[]> = {
    in_progress: ["pending", "pending_input", "awaiting_confirmation", "awaiting_kyc_verification", "processing"] as TransactionStatus[],
    unsuccessful: ["failed", "cancelled"] as TransactionStatus[],
};

function listWhere(filter: TransactionListFilter): SQL | undefined {
    const where: SQL[] = [];
    if (filter.user) where.push(eq(transactions.user, filter.user));
    if (Array.isArray(filter.currency)) where.push(inArray(transactions.currency, filter.currency));
    else if (filter.currency) where.push(eq(transactions.currency, filter.currency));
    if (filter.status && STATUS_GROUPS[filter.status]) where.push(inArray(transactions.status, STATUS_GROUPS[filter.status]));
    else if (filter.status) where.push(eq(transactions.status, filter.status as TransactionStatus));
    if (filter.createdFrom) where.push(gte(transactions.createdAt, filter.createdFrom));
    if (filter.createdTo) where.push(lte(transactions.createdAt, filter.createdTo));
    if (filter.search) where.push(ilike(transactions.reference, `%${escapeLike(filter.search)}%`));
    if (filter.hideFailedReceives) where.push(sql`not (${transactions.status} in ('failed', 'cancelled') and ${isReceive})`);
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
            payerPhone: payer?.phone?.trim() || undefined,
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
    /**
     * The user's transactions since `since` that use up their daily limit. Leaves
     * out `excludeStatuses`, and anything a provider has already reported as
     * failed, expired, refunded or cancelled even if our status hasn't caught up.
     */
    async listForLimit(userId: string, since: Date, excludeStatuses: TransactionStatus[]) {
        if (!isUuid(userId)) return [];
        const providerFailed = sql`lower(coalesce(${transactionDetails.ycStatus}, ${transactionDetails.ogStatus}, ${transactionDetails.providerStatus}, '')) in ('failed', 'expired', 'refunded', 'cancelled', 'rejected')`;
        const rows = await exec()
            .select({ ngnValue: transactions.ngnValue, amount: transactions.amount, currency: transactions.currency })
            .from(transactions)
            .leftJoin(transactionDetails, eq(transactionDetails.transactionId, transactions.id))
            .where(and(
                eq(transactions.user, userId),
                gte(transactions.createdAt, since),
                notInArray(transactions.status, excludeStatuses),
                sql`not (${providerFailed})`,
            ));
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

    /**
     * A user's transaction history in one list, newest first: their transactions
     * plus the bank transfers into their wallet (fundings not tied to a
     * transaction; a GHS top-up's funding is already its transaction). Both are
     * paged together in the database, so every page is complete and in order.
     */
    async paginateHistory(filter: TransactionListFilter & { user: string }, request: PageRequest): Promise<Paginated<HistoryRow>> {
        const window = pageWindow(request);
        if (!isUuid(filter.user)) return toPage([], 0, window);

        const fundingWhere: SQL[] = [
            eq(walletTransactions.user, filter.user),
            eq(walletTransactions.type, "funding"),
            isNull(walletTransactions.transactionId),
        ];
        const statuses = fundingStatuses(filter.status);
        if (statuses) fundingWhere.push(statuses.length ? inArray(walletTransactions.status, statuses) : sql`false`);
        if (filter.createdFrom) fundingWhere.push(gte(walletTransactions.createdAt, filter.createdFrom));
        if (filter.createdTo) fundingWhere.push(lte(walletTransactions.createdAt, filter.createdTo));
        if (filter.search) fundingWhere.push(ilike(walletTransactions.reference, `%${escapeLike(filter.search)}%`));
        const fundings = and(...fundingWhere);
        const own = listWhere(filter);

        const page = await exec()
            .select({ kind: sql<string>`'transaction'`.as("kind"), id: transactions.id, createdAt: transactions.createdAt })
            .from(transactions)
            .where(own)
            .unionAll(
                exec()
                    .select({ kind: sql<string>`'funding'`.as("kind"), id: walletTransactions.id, createdAt: walletTransactions.createdAt })
                    .from(walletTransactions)
                    .where(fundings)
            )
            .orderBy(sql`created_at desc`, sql`id desc`)
            .limit(window.limit)
            .offset(window.offset);

        const transactionIds = page.filter((r) => r.kind === "transaction").map((r) => r.id);
        const fundingIds = page.filter((r) => r.kind === "funding").map((r) => r.id);
        const [[{ n: transactionCount }], [{ n: fundingCount }], transactionRows, fundingRows] = await Promise.all([
            exec().select({ n: count() }).from(transactions).where(own),
            exec().select({ n: count() }).from(walletTransactions).where(fundings),
            transactionIds.length ? exec().select().from(transactions).where(inArray(transactions.id, transactionIds)) : Promise.resolve([]),
            fundingIds.length ? exec().select().from(walletTransactions).where(inArray(walletTransactions.id, fundingIds)) : Promise.resolve([]),
        ]);
        const views = new Map((await this.toViews(transactionRows.map(toTransaction))).map((v) => [v.id, v as HistoryRow]));
        const funded = new Map(fundingRows.map((row) => [row.id, fundingAsRow(stripNulls(row) as WalletTransaction)]));
        const rows = page
            .map((r) => (r.kind === "transaction" ? views.get(r.id) : funded.get(r.id)))
            .filter((row): row is HistoryRow => !!row);
        return toPage(rows, Number(transactionCount) + Number(fundingCount), window);
    }

    /** Credited GHS receipts at Fincra, completed between `since` and `before`, that have no conversion */
    async listFincraGhsReceiptsWithoutConversion(since: Date, before: Date): Promise<Array<{ id: string; reference: string }>> {
        return exec()
            .select({ id: transactions.id, reference: transactions.reference })
            .from(transactions)
            .leftJoin(fxConversions, eq(fxConversions.transactionId, transactions.id))
            .where(and(
                eq(transactions.detailType, "fincra"),
                eq(transactions.fromCurrency, "GHS"),
                eq(transactions.currency, "NGN"),
                eq(transactions.status, "completed"),
                gte(transactions.completedAt, since),
                lte(transactions.completedAt, before),
                isNull(fxConversions.id),
            ))
            .limit(50);
    }

    /** Admin: the latest GHS receipts at Fincra with their conversion, newest first */
    async listFincraGhsReceipts(limit = 50) {
        const rows = await exec()
            .select({
                id: transactions.id,
                reference: transactions.reference,
                status: transactions.status,
                amount: transactions.amount,
                createdAt: transactions.createdAt,
                completedAt: transactions.completedAt,
                purpose: transactions.purpose,
                firstName: users.firstName,
                lastName: users.lastName,
                email: users.email,
                creditedNgn: transactionDetails.fromAmount,
                providerStatus: transactionDetails.providerStatus,
                conversion: fxConversions,
            })
            .from(transactions)
            .leftJoin(users, eq(users.id, transactions.user))
            .leftJoin(transactionDetails, eq(transactionDetails.transactionId, transactions.id))
            .leftJoin(fxConversions, eq(fxConversions.transactionId, transactions.id))
            .where(and(eq(transactions.detailType, "fincra"), eq(transactions.fromCurrency, "GHS"), eq(transactions.currency, "NGN")))
            .orderBy(desc(transactions.createdAt))
            .limit(Math.min(Math.max(limit, 1), 200));
        return rows.map(({ conversion, ...row }) => ({
            ...stripNulls(row),
            amount: toNumber(row.amount),
            creditedNgn: row.creditedNgn === null ? null : toNumber(row.creditedNgn),
            conversion: conversion ? stripNulls(conversion) : null,
        }));
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
