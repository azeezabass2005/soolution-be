import { and, count, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import transactionRepository from "../repositories/transaction.repository";
import userRepository from "../repositories/user.repository";
import { transactionDetails, transactions, walletTransactions } from "../db/schema";
import { exec } from "../repositories/utils";
import { DETAIL_TYPE, TRANSACTION_STATUS } from "../common/constant";
import type { TransactionStatus } from "../types/enums";
import type { DateRange } from "../utils/date-range.utils";

const num = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;

/** Paid out by our team rather than a provider's API */
export const MANUAL_DETAIL_TYPES = [DETAIL_TYPE.ALIPAY, DETAIL_TYPE.WECHAT, DETAIL_TYPE.BANK_TRANSFER, DETAIL_TYPE.MOBILE_MONEY];

/** Not finished yet: waiting on the user, on us, or on a provider */
export const IN_PROGRESS_STATUSES = ["pending", "pending_input", "awaiting_confirmation", "awaiting_kyc_verification", "processing"] as TransactionStatus[];

/** Naira in and out of user wallets, from the wallet ledger (successful NGN entries) */
export interface WalletFlows {
    /** Bank deposits into wallets */
    fundedNgn: number;
    /** Payments received (collections and payment links) and top-ups, credited as naira */
    receivedNgn: number;
    /** Sends paid from wallets */
    sentNgn: number;
    /** Withdrawals to Nigerian banks */
    paidOutNgn: number;
    counts: { funded: number; received: number; sent: number; paidOut: number };
}

/** Admin dashboard metrics */
class DashboardService {
    /** Every successful NGN wallet movement in the window, by kind */
    async walletFlows(range: DateRange = {}): Promise<WalletFlows> {
        const wt = walletTransactions;
        const where: SQL[] = [eq(wt.status, "successful"), sql`coalesce(${wt.currency}, 'NGN') = 'NGN'`];
        if (range.from) where.push(gte(wt.createdAt, range.from));
        if (range.to) where.push(lte(wt.createdAt, range.to));
        const deposit = sql`${wt.type} = 'funding' and ${wt.transactionId} is null`;
        const credit = sql`${wt.type} = 'funding' and ${wt.transactionId} is not null`;
        const [row] = await exec()
            .select({
                funded: sql<string>`coalesce(sum(case when ${deposit} then ${wt.amount} end), 0)`,
                received: sql<string>`coalesce(sum(case when ${credit} then ${wt.amount} end), 0)`,
                sent: sql<string>`coalesce(sum(case when ${wt.type} = 'transfer' then ${wt.amount} end), 0)`,
                paidOut: sql<string>`coalesce(sum(case when ${wt.type} = 'withdrawal' then ${wt.amount} end), 0)`,
                fundedCount: sql<number>`count(*) filter (where ${deposit})`,
                receivedCount: sql<number>`count(*) filter (where ${credit})`,
                sentCount: sql<number>`count(*) filter (where ${wt.type} = 'transfer')`,
                paidOutCount: sql<number>`count(*) filter (where ${wt.type} = 'withdrawal')`,
            })
            .from(wt)
            .where(and(...where));
        return {
            fundedNgn: num(row?.funded),
            receivedNgn: num(row?.received),
            sentNgn: num(row?.sent),
            paidOutNgn: num(row?.paidOut),
            counts: { funded: Number(row?.fundedCount ?? 0), received: Number(row?.receivedCount ?? 0), sent: Number(row?.sentCount ?? 0), paidOut: Number(row?.paidOutCount ?? 0) },
        };
    }

    /** Completed manual payments in the window: how many, and their naira value */
    async manualTotals(range: DateRange = {}) {
        const t = transactions;
        const where: SQL[] = [inArray(t.detailType, MANUAL_DETAIL_TYPES as any), eq(t.status, TRANSACTION_STATUS.COMPLETED as TransactionStatus)];
        if (range.from) where.push(gte(t.createdAt, range.from));
        if (range.to) where.push(lte(t.createdAt, range.to));
        // The naira the user paid (fromAmount) when they paid in naira, else the value booked against their limit
        const ngn = sql`case when ${t.fromCurrency} = 'NGN' then coalesce(${transactionDetails.fromAmount}, ${t.ngnValue}, 0) else coalesce(${t.ngnValue}, 0) end`;
        const [row] = await exec()
            .select({ n: count(), volume: sql<string>`coalesce(sum(${ngn}), 0)` })
            .from(t)
            .leftJoin(transactionDetails, eq(transactionDetails.transactionId, t.id))
            .where(and(...where));
        return { count: Number(row?.n ?? 0), volumeNgn: num(row?.volume) };
    }

    /** Transactions not finished yet, right now (whatever dates are picked), and how many are manual */
    async pendingNow() {
        const [row] = await exec()
            .select({
                n: count(),
                manual: sql<number>`count(*) filter (where ${inArray(transactions.detailType, MANUAL_DETAIL_TYPES as any)})`,
                awaitingUs: sql<number>`count(*) filter (where ${transactions.status} = 'awaiting_confirmation')`,
            })
            .from(transactions)
            .where(inArray(transactions.status, IN_PROGRESS_STATUSES));
        return { count: Number(row?.n ?? 0), manual: Number(row?.manual ?? 0), awaitingConfirmation: Number(row?.awaitingUs ?? 0) };
    }

    /**
     * The dashboard. With a range, everything except "pending" is for that
     * window (users who signed up in it, and of those how many are verified;
     * money that moved in it). Pending is always what's open right now.
     *
     * - flows: naira funded, received, sent and paid out through user wallets
     * - amountTransactedNgn: all four added up (the platform's volume, funding included)
     * - transactionsCount: how many of those movements, plus completed manual payments made outside the wallet
     * - manual: completed manual payments (count and naira value)
     * - pending: transactions still in progress now
     */
    async getAdminDashboard(range: DateRange = {}) {
        const created = { createdFrom: range.from, createdTo: range.to };
        const [totalUsers, totalKYCVerified, flows, manual, pending, recentTransactions, outsideWallet] = await Promise.all([
            userRepository.count(created),
            // Verified identity (Tier 1+): a BVN check verifies without an application, so isKYCDone misses them
            userRepository.count({ verified: true, ...created }),
            this.walletFlows(range),
            this.manualTotals(range),
            this.pendingNow(),
            transactionRepository.recentWithOwner(10, range),
            this.manualOutsideWallet(range),
        ]);
        const c = flows.counts;
        const amountTransactedNgn = num(flows.fundedNgn + flows.receivedNgn + flows.sentNgn + flows.paidOutNgn);

        return {
            totalUsers,
            totalKYCVerified,
            flows,
            amountTransactedNgn,
            transactionsCount: c.funded + c.received + c.sent + c.paidOut + outsideWallet,
            manual,
            pending,
            // Kept for older screens: the transaction volume, funding included
            totalAmountCompleted: amountTransactedNgn,
            totalTransactionsCompleted: c.funded + c.received + c.sent + c.paidOut + outsideWallet,
            pendingPayments: pending.awaitingConfirmation,
            recentTransactions,
        };
    }

    /** Completed manual payments the user paid for by bank transfer, not from their wallet (no wallet entry to count) */
    private async manualOutsideWallet(range: DateRange) {
        const t = transactions;
        const where: SQL[] = [
            inArray(t.detailType, MANUAL_DETAIL_TYPES as any),
            eq(t.status, TRANSACTION_STATUS.COMPLETED as TransactionStatus),
            isNull(walletTransactions.id),
        ];
        if (range.from) where.push(gte(t.createdAt, range.from));
        if (range.to) where.push(lte(t.createdAt, range.to));
        const [row] = await exec()
            .select({ n: count() })
            .from(t)
            .leftJoin(walletTransactions, eq(walletTransactions.transactionId, t.id))
            .where(and(...where));
        return Number(row?.n ?? 0);
    }
}

export default new DashboardService();
