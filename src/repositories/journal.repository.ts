import { and, asc, count, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { journalEntries } from "../db/schema";
import type { Executor } from "../db/client";
import type { JournalEntry } from "../types/entities";
import type { JournalDirection, JournalSource } from "../types/enums";
import { pageWindow, toPage, type PageRequest, type Paginated } from "../db/pagination";
import { exec, isUuid, stripNulls, toNumber, upper } from "./utils";

type JournalRow = typeof journalEntries.$inferSelect;

export interface NewJournalEntry {
    txGroupId: string;
    accountCode: string;
    account: string;
    direction: JournalDirection;
    amount: number;
    currency: string;
    reference: string;
    source: JournalSource;
    description: string;
    externalRef?: { provider: string; id: string };
    metadata?: Record<string, unknown>;
    postedAt: Date;
    postedBy?: string;
}

export interface JournalFilter {
    accountCode?: string;
    source?: string;
    txGroupId?: string;
    externalProvider?: string;
    externalId?: string;
    postedFrom?: Date;
    postedTo?: Date;
}

export function toJournalEntry(row: JournalRow): JournalEntry {
    const { externalRefProvider, externalRefId, ...rest } = stripNulls(row);
    return externalRefProvider || externalRefId
        ? { ...rest, externalRef: { provider: externalRefProvider, id: externalRefId } }
        : rest;
}

function whereOf(filter: JournalFilter): SQL | undefined {
    const where: SQL[] = [];
    if (filter.accountCode) where.push(eq(journalEntries.accountCode, filter.accountCode));
    if (filter.source) where.push(eq(journalEntries.source, filter.source as JournalSource));
    if (filter.txGroupId) where.push(eq(journalEntries.txGroupId, filter.txGroupId));
    if (filter.externalProvider) where.push(eq(journalEntries.externalRefProvider, filter.externalProvider));
    if (filter.externalId) where.push(eq(journalEntries.externalRefId, filter.externalId));
    if (filter.postedFrom && !isNaN(filter.postedFrom.getTime())) where.push(gte(journalEntries.postedAt, filter.postedFrom));
    if (filter.postedTo && !isNaN(filter.postedTo.getTime())) where.push(lte(journalEntries.postedAt, filter.postedTo));
    return where.length ? and(...where) : undefined;
}

class JournalRepository {
    async insertMany(entries: NewJournalEntry[], tx: Executor): Promise<JournalEntry[]> {
        if (!entries.length) return [];
        const rows = await tx
            .insert(journalEntries)
            .values(
                entries.map(({ externalRef, ...entry }) => ({
                    ...entry,
                    currency: upper(entry.currency)!,
                    externalRefProvider: externalRef?.provider,
                    externalRefId: externalRef?.id,
                }))
            )
            .returning();
        return rows.map(toJournalEntry);
    }

    /** Debit and credit totals for an account, optionally up to a point in time */
    async totalsByDirection(accountCode: string, asOf?: Date, tx?: Executor): Promise<{ debits: number; credits: number }> {
        const where = asOf
            ? and(eq(journalEntries.accountCode, accountCode), lte(journalEntries.postedAt, asOf))
            : eq(journalEntries.accountCode, accountCode);
        const [row] = await exec(tx)
            .select({
                debits: sql<string>`coalesce(sum(${journalEntries.amount}) filter (where ${journalEntries.direction} = 'debit'), 0)`,
                credits: sql<string>`coalesce(sum(${journalEntries.amount}) filter (where ${journalEntries.direction} = 'credit'), 0)`,
            })
            .from(journalEntries)
            .where(where);
        return { debits: toNumber(row?.debits), credits: toNumber(row?.credits) };
    }

    /** Debit and credit totals for every posting (reconciliation) */
    async totalsByTxGroup(tx?: Executor): Promise<Array<{ txGroupId: string; debits: number; credits: number }>> {
        const rows = await exec(tx)
            .select({
                txGroupId: journalEntries.txGroupId,
                debits: sql<string>`coalesce(sum(${journalEntries.amount}) filter (where ${journalEntries.direction} = 'debit'), 0)`,
                credits: sql<string>`coalesce(sum(${journalEntries.amount}) filter (where ${journalEntries.direction} = 'credit'), 0)`,
            })
            .from(journalEntries)
            .groupBy(journalEntries.txGroupId);
        return rows.map((row) => ({ txGroupId: row.txGroupId, debits: toNumber(row.debits), credits: toNumber(row.credits) }));
    }

    /** Newest first */
    async paginate(filter: JournalFilter, request: PageRequest, defaults: { limit?: number; maxLimit?: number } = {}): Promise<Paginated<JournalEntry>> {
        const window = pageWindow(request, defaults);
        const where = whereOf(filter);
        const [rows, [{ n }]] = await Promise.all([
            exec().select().from(journalEntries).where(where).orderBy(desc(journalEntries.postedAt), desc(journalEntries.id)).limit(window.limit).offset(window.offset),
            exec().select({ n: count() }).from(journalEntries).where(where),
        ]);
        return toPage(rows.map(toJournalEntry), Number(n), window);
    }

    /** Every leg of one posting, in a stable order (direction, then account code) */
    async findByTxGroup(txGroupId: string): Promise<JournalEntry[]> {
        const rows = await exec()
            .select()
            .from(journalEntries)
            .where(eq(journalEntries.txGroupId, txGroupId))
            .orderBy(asc(journalEntries.direction), asc(journalEntries.accountCode));
        return rows.map(toJournalEntry);
    }

    /** Locks the entry until the transaction ends, so two admins can't attribute it twice */
    async findByIdForUpdate(id: string, tx: Executor): Promise<JournalEntry | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await tx.select().from(journalEntries).where(eq(journalEntries.id, id)).for("update").limit(1);
        return row ? toJournalEntry(row) : undefined;
    }

    async markReversed(id: string, reversedBy: string, tx: Executor): Promise<void> {
        await tx.update(journalEntries).set({ reversedBy }).where(eq(journalEntries.id, id));
    }

    /** Open suspense credits: credits to `accountCode` not yet reversed */
    async paginateOpenCredits(accountCode: string, request: PageRequest): Promise<Paginated<JournalEntry>> {
        const window = pageWindow(request, { limit: 25 });
        const where = and(
            eq(journalEntries.accountCode, accountCode),
            eq(journalEntries.direction, "credit"),
            isNull(journalEntries.reversedBy)
        );
        const [rows, [{ n }]] = await Promise.all([
            exec().select().from(journalEntries).where(where).orderBy(desc(journalEntries.postedAt), desc(journalEntries.id)).limit(window.limit).offset(window.offset),
            exec().select({ n: count() }).from(journalEntries).where(where),
        ]);
        return toPage(rows.map(toJournalEntry), Number(n), window);
    }

    /** Whether `accountCode` has an entry for this provider reference */
    async existsByExternalRef(accountCode: string, provider: string, externalId: string, tx?: Executor): Promise<boolean> {
        const [row] = await exec(tx)
            .select({ id: journalEntries.id })
            .from(journalEntries)
            .where(and(eq(journalEntries.accountCode, accountCode), eq(journalEntries.externalRefProvider, provider), eq(journalEntries.externalRefId, externalId)))
            .limit(1);
        return !!row;
    }

    async countOpenCredits(accountCode: string, tx?: Executor): Promise<number> {
        const [row] = await exec(tx)
            .select({ n: count() })
            .from(journalEntries)
            .where(and(eq(journalEntries.accountCode, accountCode), eq(journalEntries.direction, "credit"), isNull(journalEntries.reversedBy)));
        return Number(row?.n ?? 0);
    }
}

export const journalRepository = new JournalRepository();
export default journalRepository;
