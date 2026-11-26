import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import z from "zod";
import { accounts, fxConversions, payoutHolds, transactionDetails, transactions, treasuryExpenses, walletTransactions } from "../db/schema";
import { exec, isUuid } from "../repositories/utils";
import platformSettingsService from "./platform-settings.service";
import ycRateService from "./yc-rate.service";
import fincraService from "./fincra.service";
import yellowCardService from "./yellowcard.service";
import NotificationService from "../utils/notification.utils";
import { SYSTEM_ACCOUNT_CODES } from "../common/constant";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import config from "../config/env.config";
import logger from "../utils/logger.utils";
import type { ProfitRow } from "./admin-profit.service";
import { attentionService } from "./attention.service";
import { hasPermission } from "../common/permissions";

const r2 = (n: number) => Math.round(n * 100) / 100;
const n = (v: unknown) => Number(v) || 0;
const ALERT_EVERY_MS = 6 * 60 * 60 * 1000;

const ZExpense = z.object({
    amountNgn: z.coerce.number({ invalid_type_error: "Enter the amount in naira" }).positive("Enter the amount in naira").max(100_000_000_000),
    category: z.string().trim().min(2, "Say what it was for").max(60),
    note: z.string().trim().max(300).optional().transform((v) => v || undefined),
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the day it happened"),
});

export interface LiquidityLine {
    provider: "yellowcard" | "fincra";
    currency: string;
    /** What the provider says it holds now; null when it couldn't be reached */
    live: number | null;
    /** Payouts already on their way (or approved to go) that will come out of it */
    committedOut: number;
    /** Money already on its way in (collections and conversions not yet settled) */
    expectedIn: number;
    /** live − out + in: what's left once everything in motion settles */
    projected: number | null;
    /** The alert level (0 = none) */
    minimum: number;
    low: boolean;
}

/**
 * Treasury: revenue and net profit, the cost of moving money (expenses
 * admins record), whether provider balances can cover what's going out, and
 * the naira-per-USD used to show figures in USD.
 */
class TreasuryService {
    private notifications = new NotificationService();
    private lastAlert = new Map<string, number>();
    /** How many balances are below their alert level, kept briefly (reading them asks the providers) */
    private lowCache: { at: number; count: number } | null = null;

    /** Balances below their alert level right now (cached for 2 minutes); 0 when they can't be read */
    async lowLiquidityCount(): Promise<number> {
        if (this.lowCache && Date.now() - this.lowCache.at < 2 * 60_000) return this.lowCache.count;
        const count = (await this.liquidity().catch(() => [] as LiquidityLine[])).filter((l) => l.low).length;
        this.lowCache = { at: Date.now(), count };
        return count;
    }

    // ─────────────── Expenses ───────────────

    async addExpense(body: unknown, by: string) {
        const parsed = ZExpense.safeParse(body ?? {});
        if (!parsed.success) throw errorResponseMessage.createError(400, parsed.error.issues[0].message, ErrorSeverity.LOW);
        const [row] = await exec().insert(treasuryExpenses).values({ ...parsed.data, createdBy: by }).returning();
        logger.info("Treasury expense recorded", { id: row.id, by, amountNgn: parsed.data.amountNgn, category: parsed.data.category });
        return row;
    }

    async removeExpense(id: string, by: string) {
        if (!isUuid(id)) throw errorResponseMessage.resourceNotFound("Expense");
        const [row] = await exec().delete(treasuryExpenses).where(eq(treasuryExpenses.id, id)).returning();
        if (!row) throw errorResponseMessage.resourceNotFound("Expense");
        logger.info("Treasury expense removed", { id, by, amountNgn: row.amountNgn });
        return { id };
    }

    /** Expenses between two Lagos days (YYYY-MM-DD), newest first */
    async expenses(from?: string, to?: string) {
        return exec().select().from(treasuryExpenses)
            .where(and(from ? gte(treasuryExpenses.occurredOn, from) : undefined, to ? lte(treasuryExpenses.occurredOn, to) : undefined))
            .orderBy(desc(treasuryExpenses.occurredOn), desc(treasuryExpenses.createdAt))
            .limit(500);
    }

    /**
     * Revenue and profit from the profit rows, less recorded expenses:
     *   revenue      = fees charged + spread
     *   providerFees = the providers' part of the fees (passed on to users)
     *   gross        = revenue − provider fees (what we keep per transaction)
     *   net          = gross − the cost of moving money (expenses)
     * Transactions whose profit isn't known yet are left out (and counted).
     */
    summarize(rows: ProfitRow[], expensesNgn: number) {
        let fees = 0, spread = 0, gross = 0, volume = 0, pending = 0;
        for (const r of rows) {
            if (r.profitNgn === null || r.spreadNgn === null) { pending += 1; continue; }
            fees += r.feeNgn;
            spread += r.spreadNgn;
            gross += r.profitNgn;
            volume += r.volumeNgn ?? 0;
        }
        const revenue = r2(fees + spread);
        return {
            amountTransactedNgn: r2(volume),
            revenueNgn: revenue,
            feesNgn: r2(fees),
            spreadNgn: r2(spread),
            providerFeesNgn: r2(revenue - gross),
            grossProfitNgn: r2(gross),
            expensesNgn: r2(expensesNgn),
            netProfitNgn: r2(gross - expensesNgn),
            notKnownYet: pending,
        };
    }

    // ─────────────── USD ───────────────

    /** Naira per USD for showing figures in USD: our selling rate when set, else YellowCard's */
    async ngnPerUsd(): Promise<{ rate: number | null; source: "ours" | "yellowcard" | null }> {
        const pricing = await platformSettingsService.getPricing();
        if (pricing.usd?.mode === "ours" && pricing.usd.sellNgn > 0) return { rate: pricing.usd.sellNgn, source: "ours" };
        try {
            const quotes = await ycRateService.usdQuotes();
            const ngn = quotes.get("NGN");
            return ngn ? { rate: ngn.sell, source: "yellowcard" } : { rate: null, source: null };
        } catch {
            return { rate: null, source: null };
        }
    }

    // ─────────────── Liquidity ───────────────

    async liquidity(): Promise<LiquidityLine[]> {
        const { liquidity } = await platformSettingsService.getOperations();
        const inProgress = ["pending", "processing", "awaiting_approval"];

        // YellowCard now settles in naira: sends are paid from our NGN balance there and collections credit it
        const [yc] = await exec()
            .select({
                out: sql<string>`coalesce(sum(case when ${transactions.fromCurrency} = 'NGN' then coalesce(${transactionDetails.fromAmount}, 0) - coalesce(${transactionDetails.feeAmount}, 0) end), 0)`,
                in: sql<string>`coalesce(sum(case when ${transactions.currency} = 'NGN' and ${transactions.fromCurrency} <> 'NGN' then coalesce(${transactionDetails.fromAmount}, 0) + coalesce(${transactionDetails.feeAmount}, 0) end), 0)`,
            })
            .from(transactions)
            .leftJoin(transactionDetails, eq(transactionDetails.transactionId, transactions.id))
            .where(and(eq(transactions.detailType, "yellowcard" as any), inArray(transactions.status, inProgress as any)));
        let ycLive: number | null = null;
        try {
            const account: any = await yellowCardService.getAccount();
            const list: any[] = Array.isArray(account?.accounts) ? account.accounts : Array.isArray(account?.balances) ? account.balances : [account];
            const ngnRow = list.find((a) => String(a?.currency || "").toUpperCase() === "NGN");
            ycLive = ngnRow ? r2(n(ngnRow.available ?? ngnRow.availableBalance ?? ngnRow.balance)) : null;
        } catch (error: any) {
            logger.warn("Liquidity: YellowCard balance unavailable", { error: error?.message });
        }
        const ycOut = r2(n(yc?.out));
        const ycIn = r2(n(yc?.in));

        // Fincra NGN pays withdrawals and GHS sends; GHS received is on its way to naira
        const [withdrawals] = await exec().select({ total: sql<string>`coalesce(sum(${walletTransactions.amount}), 0)` }).from(walletTransactions)
            .where(and(eq(walletTransactions.type, "withdrawal" as any), inArray(walletTransactions.status, ["pending", "processing"] as any)));
        const [ghsSends] = await exec().select({ total: sql<string>`coalesce(sum(coalesce(${transactionDetails.providerCost}, ${transactionDetails.fromAmount})), 0)` })
            .from(transactions).leftJoin(transactionDetails, eq(transactionDetails.transactionId, transactions.id))
            .where(and(eq(transactions.detailType, "fincra" as any), eq(transactions.currency, "GHS"), inArray(transactions.status, inProgress as any)));
        const [converting] = await exec().select({ total: sql<string>`coalesce(sum(${fxConversions.bookedNgn}), 0)` }).from(fxConversions)
            .where(inArray(fxConversions.status, ["pending", "processing"]));
        let fincraLive: number | null = null;
        try {
            fincraLive = r2((await fincraService.getBalances()).find((b) => b.currency === "NGN")?.available ?? 0);
        } catch (error: any) {
            logger.warn("Liquidity: Fincra balance unavailable", { error: error?.message });
        }
        const fincraOut = r2(n(withdrawals?.total) + n(ghsSends?.total));
        const fincraIn = r2(n(converting?.total));

        const line = (provider: LiquidityLine["provider"], currency: string, live: number | null, out: number, inn: number, minimum: number): LiquidityLine => {
            const projected = live === null ? null : r2(live - out + inn);
            return { provider, currency, live, committedOut: out, expectedIn: inn, projected, minimum, low: minimum > 0 && projected !== null && projected < minimum };
        };
        return [
            line("yellowcard", "NGN", ycLive, ycOut, ycIn, liquidity.yellowcardNgnMin),
            line("fincra", "NGN", fincraLive, fincraOut, fincraIn, liquidity.fincraNgnMin),
        ];
    }

    /** Alerts the team about any balance running low (at most every 6 hours per balance); run by the sweeper */
    async checkLiquidity(): Promise<number> {
        const lines = await this.liquidity();
        this.lowCache = { at: Date.now(), count: lines.filter((l) => l.low).length };
        let alerted = 0;
        for (const l of lines.filter((x) => x.low)) {
            const key = `${l.provider}:${l.currency}`;
            if (Date.now() - (this.lastAlert.get(key) ?? 0) < ALERT_EVERY_MS) continue;
            this.lastAlert.set(key, Date.now());
            alerted += 1;
            const name = l.provider === "yellowcard" ? "YellowCard" : "Fincra";
            const fmt = (v: number) => `${l.currency} ${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
            await this.notifications.notifyAdmins(config.ADMIN_EMAILS, {
                title: `${name} ${l.currency} balance is running low`,
                message: `${name} holds ${fmt(l.live ?? 0)}. After ${fmt(l.committedOut)} going out and ${fmt(l.expectedIn)} coming in, ${fmt(l.projected ?? 0)} is left, below the ${fmt(l.minimum)} alert level. Top it up before payouts start failing.`,
                type: "liquidity.low",
                permission: "profit_balances",
                actionUrl: `${config.FRONTEND_URL}/dashboard/admin/insights`,
                buttonText: "See balances",
            } as any, config.ADMIN_PHONE_NUMBERS).catch((error: any) => logger.warn("Liquidity alert failed", { error: error?.message }));
        }
        return alerted;
    }

    // ─────────────── Why the books differ ───────────────

    /**
     * Things we can measure that make a provider's live balance differ from
     * our books, in naira: payouts in flight (the provider may have taken the
     * money before confirming), deposits we couldn't match to a user
     * (suspense), held payouts, and GHS waiting to be converted.
     */
    async booksDifferenceReasons() {
        const codes = await exec().select({ code: accounts.code, balance: accounts.balance }).from(accounts)
            .where(sql`${accounts.code} like 'FINCRA_PAYOUT_INFLIGHT_%' or ${accounts.code} like 'YC_PAYMENT_INFLIGHT_%' or ${accounts.code} = ${SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN} or ${accounts.code} = ${SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN}`);
        const sum = (match: (code: string) => boolean) => r2(Math.abs(codes.filter((c) => match(c.code)).reduce((s, c) => s + n(c.balance), 0)));
        const [held] = await exec().select({ total: sql<string>`coalesce(sum(${payoutHolds.amountNgn}), 0)`, count: sql<number>`count(*)` }).from(payoutHolds)
            .where(inArray(payoutHolds.status, ["pending", "approving"] as any));
        const [converting] = await exec().select({ total: sql<string>`coalesce(sum(${fxConversions.bookedNgn}), 0)`, count: sql<number>`count(*)` }).from(fxConversions)
            .where(inArray(fxConversions.status, ["pending", "processing", "failed"]));
        return [
            { key: "payouts_in_flight", label: "Payouts on their way (taken by the provider, not yet confirmed to us)", amountNgn: sum((c) => c.startsWith("FINCRA_PAYOUT_INFLIGHT_") || c.startsWith("YC_PAYMENT_INFLIGHT_") || c === SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN) },
            { key: "suspense", label: "Deposits we couldn't match to a user (Technical → Suspense)", amountNgn: sum((c) => c === SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN) },
            { key: "held", label: `Payouts waiting for approval (${Number(held?.count ?? 0)})`, amountNgn: r2(n(held?.total)) },
            { key: "converting", label: `GHS received, not yet converted to naira (${Number(converting?.count ?? 0)})`, amountNgn: r2(n(converting?.total)) },
        ].filter((r) => r.amountNgn > 0);
    }
}

const treasuryService = new TreasuryService();

// Admins who see balances get a red dot on the bell while any balance is below its alert level
attentionService.register(async (access): Promise<Record<string, number>> =>
    (hasPermission(access, "profit_balances") ? { lowLiquidity: await treasuryService.lowLiquidityCount() } : {}));

export default treasuryService;
