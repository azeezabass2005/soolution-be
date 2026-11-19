import { inArray, like, or, sql } from "drizzle-orm";
import { accounts, fxConversions } from "../db/schema";
import { exec } from "../repositories/utils";
import fincraService from "./fincra.service";
import yellowCardService from "./yellowcard.service";
import { SYSTEM_ACCOUNT_CODES } from "../common/constant";
import logger from "../utils/logger.utils";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ProviderBalances {
    provider: "fincra" | "yellowcard";
    /** What the provider says it holds, per currency; null when it couldn't be reached */
    live: Array<{ currency: string; available: number }> | null;
    error?: string;
    /** What our books say we hold there, per currency */
    books: Array<{ currency: string; balance: number; accounts: string[]; bookedNgn?: number }>;
}

/**
 * Money at the payment providers: their live balances next to our books,
 * per provider and in total, so a gap shows up straight away.
 */
class AdminBalancesService {
    async report() {
        const rows = await exec()
            .select({ code: accounts.code, currency: accounts.currency, balance: accounts.balance })
            .from(accounts)
            .where(or(like(accounts.code, "CASH_FINCRA_%"), like(accounts.code, "CASH_YELLOWCARD_%"), inArray(accounts.code, [SYSTEM_ACCOUNT_CODES.YC_FLOAT_NGN, SYSTEM_ACCOUNT_CODES.USER_WALLETS_NGN_TOTAL])));

        const books = (prefix: (code: string) => boolean) => {
            const byCurrency = new Map<string, { currency: string; balance: number; accounts: string[] }>();
            for (const r of rows.filter((x) => prefix(x.code))) {
                const entry = byCurrency.get(r.currency) ?? { currency: r.currency, balance: 0, accounts: [] };
                entry.balance = r2(entry.balance + (Number(r.balance) || 0));
                entry.accounts.push(r.code);
                byCurrency.set(r.currency, entry);
            }
            return [...byCurrency.values()];
        };

        const fincra: ProviderBalances = { provider: "fincra", live: null, books: books((c) => c.startsWith("CASH_FINCRA_")) };
        // Foreign cash at Fincra is booked at its naira value; in its own currency it's what
        // was received and not yet converted to naira
        const unconverted = await exec()
            .select({ currency: fxConversions.sourceCurrency, amount: sql<string>`coalesce(sum(${fxConversions.sourceAmount}), 0)` })
            .from(fxConversions)
            .where(inArray(fxConversions.status, ["pending", "processing", "failed"]))
            .groupBy(fxConversions.sourceCurrency);
        for (const b of fincra.books) {
            if (b.currency === "NGN") continue;
            b.bookedNgn = b.balance;
            b.balance = r2(Number(unconverted.find((u) => u.currency === b.currency)?.amount) || 0);
        }
        try {
            fincra.live = (await fincraService.getBalances()).map((b) => ({ currency: b.currency, available: r2(b.available) }));
        } catch (error: any) {
            fincra.error = error?.message || "Fincra couldn't be reached";
            logger.warn("Admin balances: Fincra balance lookup failed", { error: fincra.error });
        }

        const yellowcard: ProviderBalances = { provider: "yellowcard", live: null, books: books((c) => c.startsWith("CASH_YELLOWCARD_") || c === SYSTEM_ACCOUNT_CODES.YC_FLOAT_NGN) };
        try {
            const account: any = await yellowCardService.getAccount();
            const list: any[] = Array.isArray(account?.accounts) ? account.accounts : Array.isArray(account?.balances) ? account.balances : [];
            yellowcard.live = list.length
                ? list.map((a) => ({ currency: String(a.currency || "USD").toUpperCase(), available: r2(Number(a.available ?? a.availableBalance ?? a.balance) || 0) }))
                : [{ currency: String(account?.currency || "USD").toUpperCase(), available: r2(Number(account?.available ?? account?.availableBalance ?? account?.balance) || 0) }];
        } catch (error: any) {
            yellowcard.error = error?.message || "YellowCard couldn't be reached";
        }

        // Together, per currency: live vs books
        const total = new Map<string, { currency: string; live: number; books: number; liveKnown: boolean }>();
        for (const p of [fincra, yellowcard]) {
            for (const b of p.books) {
                const t = total.get(b.currency) ?? { currency: b.currency, live: 0, books: 0, liveKnown: true };
                t.books = r2(t.books + b.balance);
                total.set(b.currency, t);
            }
            for (const l of p.live ?? []) {
                const t = total.get(l.currency) ?? { currency: l.currency, live: 0, books: 0, liveKnown: true };
                t.live = r2(t.live + l.available);
                total.set(l.currency, t);
            }
            if (!p.live) for (const b of p.books) total.get(b.currency)!.liveKnown = false;
        }

        const owedToUsers = Number(rows.find((r) => r.code === SYSTEM_ACCOUNT_CODES.USER_WALLETS_NGN_TOTAL)?.balance) || 0;
        return {
            at: new Date(),
            providers: [fincra, yellowcard],
            total: [...total.values()].map((t) => ({ ...t, difference: r2(t.live - t.books) })),
            /** Naira the platform owes users (all NGN wallets), to compare with what's held */
            owedToUsersNgn: r2(Math.abs(owedToUsers)),
        };
    }
}

export default new AdminBalancesService();
