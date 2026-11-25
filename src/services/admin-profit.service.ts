import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { fxConversions, fxQuotes, transactionDetails, transactions, users, walletTransactions } from "../db/schema";
import { exec } from "../repositories/utils";
import platformSettingsService from "./platform-settings.service";

const r2 = (n: number) => Math.round(n * 100) / 100;
/** Rates keep four places (naira per cedi is small enough that cents matter) */
const rate = (v: number) => Math.round(v * 10_000) / 10_000;
const n = (v: unknown) => Number(v) || 0;

export type ProfitKind = "fund" | "send" | "receive" | "withdraw" | "exchange";
export const PROFIT_KINDS: ProfitKind[] = ["fund", "send", "receive", "withdraw", "exchange"];

/** One money movement and what SolutionPay made on it, in naira */
export interface ProfitRow {
    id: string;
    kind: ProfitKind;
    userId: string;
    userName: string;
    userEmail: string;
    reference: string;
    at: Date;
    /** In the currency the user dealt in */
    amount: number;
    currency: string;
    /** Fee the user was charged (all of it, including any provider fee passed on) */
    feeNgn: number;
    /** What we made on the rate; null when it can't be known yet */
    spreadNgn: number | null;
    /** What SolutionPay keeps: our share of the fee plus the spread; null while unknown */
    profitNgn: number | null;
    /** Why profit isn't known, when it isn't */
    note?: string;
    /**
     * Naira per unit of `currency`. userRate: what the user got (sends: what
     * they paid, less the fee; receives: what the payment was worth before the
     * fee). providerRate: what it cost or fetched us (sends: Fincra's charge;
     * receives: the GHS→NGN conversion). Null where there's no exchange or it
     * isn't known yet.
     */
    userRate?: number | null;
    providerRate?: number | null;
    /** The transaction's whole value in naira (what the user paid, or what the payment was worth) */
    volumeNgn?: number;
    /** profitNgn as a % of volumeNgn */
    profitPercent?: number | null;
}

export interface ProfitFilter {
    from?: Date;
    to?: Date;
    userId?: string;
    kinds?: ProfitKind[];
}

/**
 * Profit per transaction and per end-to-end flow:
 *   fund       NGN bank deposit: SolutionPay's part of the deposit fee
 *   send       NGN → GHS through Fincra: what the user paid less what Fincra charged
 *   receive    GHS → NGN (links, accounts, top-ups): the naira from converting
 *              the cedis less what the user was credited (known once converted)
 *   withdraw   NGN to a bank: the fee less the provider's part
 * Fund + Send and Receive + Withdraw are summed per user as flows.
 */
class AdminProfitService {
    async rows(filter: ProfitFilter = {}): Promise<ProfitRow[]> {
        const kinds = filter.kinds?.length ? filter.kinds : PROFIT_KINDS;
        const out: ProfitRow[] = [];
        const people = new Map<string, { name: string; email: string }>();
        const person = (id: string) => people.get(id) ?? { name: "", email: "" };

        // Transactions: GHS through Fincra, and YellowCard currencies
        if (kinds.includes("send") || kinds.includes("receive")) {
            const tx = transactions;
            const rows = await exec()
                .select({ t: tx, d: transactionDetails })
                .from(tx)
                .leftJoin(transactionDetails, eq(transactionDetails.transactionId, tx.id))
                .where(and(
                    eq(tx.status, "completed" as any),
                    filter.userId ? eq(tx.user, filter.userId) : undefined,
                    filter.from ? gte(tx.createdAt, filter.from) : undefined,
                    filter.to ? lte(tx.createdAt, filter.to) : undefined,
                    // Naira on one side: sends from NGN, receives into NGN
                    sql`(${tx.fromCurrency} = 'NGN' or ${tx.currency} = 'NGN')`,
                ))
                .orderBy(desc(tx.createdAt))
                .limit(5_000);
            const receiveIds = rows.filter((r) => r.t.fromCurrency === "GHS").map((r) => r.t.id);
            const conversions = receiveIds.length
                ? await exec().select().from(fxConversions).where(inArray(fxConversions.transactionId, receiveIds))
                : [];
            const converted = new Map(conversions.map((c) => [c.transactionId, c]));

            for (const { t, d } of rows) {
                const fee = n(d?.feeAmount);
                // YellowCard: priced at the provider's rate (stored, or worked back from the old global markup)
                if (t.detailType === "yellowcard" && (d?.type ?? "yellowcard") === "yellowcard") {
                    const units = n(t.amount);
                    const markup = n(d?.markupPercent) / 100;
                    // Paid from a wallet in the send's own currency: nothing was converted here (the
                    // spread was earned when the user exchanged into it), so only the wallet fee counts
                    if (kinds.includes("send") && d?.fundingCurrency && d.fundingCurrency !== "NGN") {
                        const unitCost = n(d?.providerRate);
                        const walletFee = n(d?.fundingFee);
                        const feeNgn = r2(walletFee * unitCost);
                        out.push({ ...this.base(t, "send"), feeNgn, spreadNgn: 0, profitNgn: unitCost > 0 ? feeNgn : null, userRate: null, providerRate: unitCost > 0 ? rate(unitCost) : null, volumeNgn: unitCost > 0 ? r2(units * unitCost) : undefined, note: `Paid from ${d.fundingCurrency} wallet: no conversion` });
                        continue;
                    }
                    if (t.fromCurrency === "NGN" && t.currency !== "NGN" && kinds.includes("send")) {
                        const charged = n(d?.fromAmount);
                        const subtotal = charged - fee;
                        const userRate = units > 0 ? subtotal / units : 0;
                        const providerRate = n(d?.providerRate) || (userRate > 0 ? userRate / (1 + markup) : 0);
                        if (!(units > 0 && providerRate > 0 && charged > 0)) {
                            out.push({ ...this.base(t, "send"), feeNgn: fee, spreadNgn: null, profitNgn: null, userRate: userRate || null, providerRate: null, note: "Rate not recorded" });
                            continue;
                        }
                        const providerFee = subtotal * n(d?.providerFeePercent) / 100;
                        const profit = r2(charged - (units * providerRate + providerFee));
                        out.push({ ...this.base(t, "send"), feeNgn: fee, spreadNgn: r2(profit - r2(fee - providerFee)), profitNgn: profit, userRate: rate(userRate), providerRate: rate(providerRate), volumeNgn: r2(charged) });
                    } else if (t.currency === "NGN" && t.fromCurrency !== "NGN" && kinds.includes("receive")) {
                        const credited = n(d?.fromAmount);
                        const gross = credited + fee;
                        const userRate = units > 0 ? gross / units : 0;
                        const providerRate = n(d?.providerRate) || (userRate > 0 && markup < 1 ? userRate / (1 - markup) : 0);
                        if (!(units > 0 && providerRate > 0)) {
                            out.push({ ...this.base(t, "receive"), feeNgn: fee, spreadNgn: null, profitNgn: null, userRate: userRate || null, providerRate: null, note: "Rate not recorded" });
                            continue;
                        }
                        const providerFee = gross * n(d?.providerFeePercent) / 100;
                        const profit = r2(units * providerRate - providerFee - credited);
                        out.push({ ...this.base(t, "receive"), feeNgn: fee, spreadNgn: r2(profit - r2(fee - providerFee)), profitNgn: profit, userRate: rate(userRate), providerRate: rate(providerRate), volumeNgn: r2(gross) });
                    }
                    continue;
                }
                if (t.fromCurrency === "NGN" && t.currency === "GHS" && kinds.includes("send")) {
                    const charged = n(d?.fromAmount);
                    const cost = n(d?.providerCost);
                    const units = n(t.amount);
                    const ngnAmount = charged - fee;
                    const userRate = units > 0 && ngnAmount > 0 ? rate(ngnAmount / units) : null;
                    if (!(cost > 0)) {
                        out.push({ ...this.base(t, "send"), feeNgn: fee, spreadNgn: null, profitNgn: null, userRate, providerRate: null, note: "Paid by our team (manual): no provider cost recorded" });
                        continue;
                    }
                    const providerFee = ngnAmount * n(d?.providerFeePercent) / 100;
                    const profit = r2(charged - cost);
                    const platformFee = r2(fee - providerFee);
                    out.push({ ...this.base(t, "send"), feeNgn: fee, spreadNgn: r2(profit - platformFee), profitNgn: profit, userRate, providerRate: units > 0 ? rate(cost / units) : null, volumeNgn: r2(charged) });
                } else if (t.fromCurrency === "GHS" && t.currency === "NGN" && kinds.includes("receive")) {
                    const credited = n(d?.fromAmount);
                    const gross = credited + fee;
                    const providerFee = gross * n(d?.providerFeePercent) / 100;
                    const platformFee = r2(fee - providerFee);
                    const c = converted.get(t.id);
                    const units = n(t.amount);
                    const userRate = units > 0 && gross > 0 ? rate(gross / units) : null;
                    if (!c || c.status !== "successful" || !(n(c.amountReceived) > 0)) {
                        out.push({ ...this.base(t, "receive"), feeNgn: fee, spreadNgn: null, profitNgn: null, userRate, providerRate: null, note: c ? "Converting to naira" : "Not converted to naira" });
                        continue;
                    }
                    const profit = r2(n(c.amountReceived) - credited);
                    // What Fincra gave per cedi converted
                    const converted_ = n(c.sourceAmount);
                    const providerRate = converted_ > 0 ? rate(n(c.amountReceived) / converted_) : n(c.rate) > 0 ? rate(n(c.rate)) : null;
                    out.push({ ...this.base(t, "receive"), feeNgn: fee, spreadNgn: r2(profit - platformFee), profitNgn: profit, userRate, providerRate, volumeNgn: r2(gross) });
                }
            }
        }

        // Wallet entries: bank deposits and withdrawals
        if (kinds.includes("fund") || kinds.includes("withdraw")) {
            const wt = walletTransactions;
            const types = [kinds.includes("fund") ? "funding" : null, kinds.includes("withdraw") ? "withdrawal" : null].filter(Boolean) as string[];
            const entries = await exec()
                .select()
                .from(wt)
                .where(and(
                    eq(wt.status, "successful" as any),
                    inArray(wt.type, types as any),
                    // Deposits only: collections credited to the wallet are counted as receives
                    types.includes("funding") && !types.includes("withdrawal") ? isNull(wt.transactionId) : undefined,
                    filter.userId ? eq(wt.user, filter.userId) : undefined,
                    filter.from ? gte(wt.createdAt, filter.from) : undefined,
                    filter.to ? lte(wt.createdAt, filter.to) : undefined,
                ))
                .orderBy(desc(wt.createdAt))
                .limit(5_000);
            for (const e of entries) {
                if (e.type === "funding" && e.transactionId) continue;
                const fee = n(e.fee);
                const base = { id: e.id, userId: e.user, userName: "", userEmail: "", reference: e.reference, at: e.createdAt, amount: n(e.amount), currency: e.currency || "NGN" };
                if (e.type === "funding") {
                    // The stored fee is already SolutionPay's part (the provider kept theirs)
                    out.push({ ...base, kind: "fund", feeNgn: fee, spreadNgn: 0, profitNgn: r2(fee), volumeNgn: r2(n(e.amount) + fee) });
                } else {
                    const providerFee = fee > 0 ? (await platformSettingsService.priceFees("withdrawal", n(e.amount))).providerFee : 0;
                    out.push({ ...base, kind: "withdraw", feeNgn: fee, spreadNgn: 0, profitNgn: r2(Math.max(0, fee - providerFee)), volumeNgn: r2(n(e.amount)) });
                }
            }
        }

        // Wallet exchanges: the spread between our rate and the provider's, on the naira side
        if (kinds.includes("exchange")) {
            const quotes = await exec()
                .select({ q: fxQuotes, w: walletTransactions })
                .from(walletTransactions)
                .innerJoin(fxQuotes, eq(fxQuotes.id, walletTransactions.fxQuoteId))
                .where(and(
                    eq(walletTransactions.type, "exchange" as any),
                    eq(walletTransactions.status, "successful" as any),
                    // One row per exchange: the money leaving
                    sql`${walletTransactions.reference} like '%-OUT'`,
                    filter.userId ? eq(walletTransactions.user, filter.userId) : undefined,
                    filter.from ? gte(walletTransactions.createdAt, filter.from) : undefined,
                    filter.to ? lte(walletTransactions.createdAt, filter.to) : undefined,
                ))
                .orderBy(desc(walletTransactions.createdAt))
                .limit(5_000);
            for (const { q, w } of quotes) {
                const userRate = n(q.rate);
                const providerRate = n(q.providerRate);
                const buying = q.fromCurrency === "NGN";
                const foreignUnits = buying ? n(q.toAmount) : n(q.fromAmount);
                const ngn = buying ? n(q.fromAmount) : n(q.toAmount);
                // Rates are naira per foreign unit: buying, the user paid more than it cost us; selling, got less than it was worth
                const profit = providerRate > 0 ? r2(buying ? ngn - foreignUnits * providerRate : foreignUnits * providerRate - ngn) : null;
                out.push({
                    id: w.id, userId: w.user, userName: "", userEmail: "", reference: w.reference.replace(/-OUT$/, ""), at: w.createdAt,
                    // Shown on the foreign side, so the rates read "₦ per unit"
                    amount: foreignUnits, currency: buying ? q.toCurrency : q.fromCurrency, kind: "exchange",
                    feeNgn: 0, spreadNgn: profit, profitNgn: profit,
                    userRate: userRate > 0 ? rate(userRate) : null, providerRate: providerRate > 0 ? rate(providerRate) : null,
                    volumeNgn: r2(ngn),
                } as ProfitRow);
            }
        }

        // Names and emails
        const ids = [...new Set(out.map((r) => r.userId))];
        if (ids.length) {
            const found = await exec().select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email }).from(users).where(inArray(users.id, ids));
            for (const u of found) people.set(u.id, { name: `${u.firstName} ${u.lastName}`.trim(), email: u.email });
        }
        for (const r of out) {
            Object.assign(r, { userName: person(r.userId).name, userEmail: person(r.userId).email });
            r.profitPercent = r.profitNgn !== null && r.volumeNgn ? Math.round((r.profitNgn / r.volumeNgn) * 100 * 100) / 100 : null;
        }
        return out.sort((a, b) => b.at.getTime() - a.at.getTime());
    }

    /** Per user: Fund + Send and Receive + Withdraw, with their combined fees, spread and profit */
    flows(rows: ProfitRow[]) {
        type Flow = { userId: string; userName: string; userEmail: string; flow: "fund_send" | "receive_withdraw"; count: number; volumeNgn: number; feeNgn: number; spreadNgn: number; profitNgn: number; pending: number };
        const map = new Map<string, Flow>();
        for (const r of rows) {
            // Exchanges are neither flow
            if (r.kind === "exchange") continue;
            const flow = r.kind === "fund" || r.kind === "send" ? "fund_send" : "receive_withdraw";
            const key = `${r.userId}:${flow}`;
            const f = map.get(key) ?? { userId: r.userId, userName: r.userName, userEmail: r.userEmail, flow, count: 0, volumeNgn: 0, feeNgn: 0, spreadNgn: 0, profitNgn: 0, pending: 0 };
            f.count += 1;
            f.volumeNgn = r2(f.volumeNgn + (r.currency === "NGN" ? r.amount : 0));
            f.feeNgn = r2(f.feeNgn + r.feeNgn);
            f.spreadNgn = r2(f.spreadNgn + (r.spreadNgn ?? 0));
            f.profitNgn = r2(f.profitNgn + (r.profitNgn ?? 0));
            if (r.profitNgn === null) f.pending += 1;
            map.set(key, f);
        }
        return [...map.values()].sort((a, b) => b.profitNgn - a.profitNgn);
    }

    /**
     * Totals, and average profit per day, week and calendar month. Each
     * period's profit % is its profit over its volume; the averages are over
     * the periods that had anything (Lagos dates; weeks start on Monday).
     */
    totals(rows: ProfitRow[]) {
        const t = { count: rows.length, feeNgn: 0, spreadNgn: 0, profitNgn: 0, pending: 0, volumeNgn: 0, profitPercent: 0 as number | null };
        for (const r of rows) {
            t.feeNgn = r2(t.feeNgn + r.feeNgn);
            t.spreadNgn = r2(t.spreadNgn + (r.spreadNgn ?? 0));
            t.profitNgn = r2(t.profitNgn + (r.profitNgn ?? 0));
            if (r.profitNgn === null) t.pending += 1;
            else t.volumeNgn = r2(t.volumeNgn + (r.volumeNgn ?? 0));
        }
        t.profitPercent = t.volumeNgn > 0 ? Math.round((t.profitNgn / t.volumeNgn) * 100 * 100) / 100 : null;
        return { ...t, averages: { daily: this.average(rows, "day"), weekly: this.average(rows, "week"), monthly: this.average(rows, "month") } };
    }

    private average(rows: ProfitRow[], period: "day" | "week" | "month") {
        const buckets = new Map<string, { profit: number; volume: number }>();
        for (const r of rows) {
            if (r.profitNgn === null) continue;
            const lagos = new Date(r.at.getTime() + 60 * 60 * 1000);
            let key: string;
            if (period === "month") key = lagos.toISOString().slice(0, 7);
            else if (period === "day") key = lagos.toISOString().slice(0, 10);
            else {
                const monday = new Date(lagos);
                monday.setUTCDate(lagos.getUTCDate() - ((lagos.getUTCDay() + 6) % 7));
                key = monday.toISOString().slice(0, 10);
            }
            const b = buckets.get(key) ?? { profit: 0, volume: 0 };
            b.profit += r.profitNgn;
            b.volume += r.volumeNgn ?? 0;
            buckets.set(key, b);
        }
        const list = [...buckets.values()];
        if (!list.length) return { periods: 0, profitNgn: 0, profitPercent: null as number | null };
        const percents = list.filter((b) => b.volume > 0).map((b) => (b.profit / b.volume) * 100);
        return {
            periods: list.length,
            profitNgn: r2(list.reduce((sum, b) => sum + b.profit, 0) / list.length),
            profitPercent: percents.length ? Math.round((percents.reduce((a, b) => a + b, 0) / percents.length) * 100) / 100 : null,
        };
    }

    private base(t: typeof transactions.$inferSelect, kind: ProfitKind) {
        return { id: t.id, kind, userId: t.user, userName: "", userEmail: "", reference: t.reference, at: t.createdAt, amount: n(t.amount), currency: kind === "send" ? t.currency : t.fromCurrency };
    }
}

export default new AdminProfitService();
