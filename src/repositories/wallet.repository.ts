import { and, asc, eq, gte, sql } from "drizzle-orm";
import { wallets } from "../db/schema";
import type { Executor } from "../db/client";
import type { Wallet } from "../types/entities";
import type { WalletCurrency } from "../common/wallet.constants";
import { WALLET_STATUS } from "../common/constant";
import { definedOnly, exec, isUuid, stripNulls } from "./utils";

export type WalletUpdate = Partial<Omit<typeof wallets.$inferInsert, "id" | "user" | "currency" | "balance" | "ledgerBalance" | "createdAt" | "updatedAt">>;

const n = (amount: number) => sql`${String(amount)}::numeric`;

class WalletRepository {
    async findById(id: string, tx?: Executor): Promise<Wallet | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec(tx).select().from(wallets).where(eq(wallets.id, id)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findByUserAndCurrency(userId: string, currency: string, tx?: Executor): Promise<Wallet | undefined> {
        if (!isUuid(userId)) return undefined;
        const [row] = await exec(tx)
            .select()
            .from(wallets)
            .where(and(eq(wallets.user, userId), eq(wallets.currency, currency as WalletCurrency)))
            .limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findByPaystackCustomerCode(code: string): Promise<Wallet | undefined> {
        const [row] = await exec().select().from(wallets).where(eq(wallets.paystackCustomerCode, code)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findByDvaAccountNumber(accountNumber: string): Promise<Wallet | undefined> {
        const [row] = await exec().select().from(wallets).where(eq(wallets.dvaAccountNumber, accountNumber)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /** The wallet a provider's virtual account (e.g. Fincra's 24-character id) belongs to */
    async findByDvaExternalId(provider: string, externalId: string): Promise<Wallet | undefined> {
        const [row] = await exec()
            .select()
            .from(wallets)
            .where(and(eq(wallets.dvaProvider, provider), eq(wallets.dvaExternalId, externalId)))
            .limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /** Oldest first */
    async listByUser(userId: string): Promise<Wallet[]> {
        if (!isUuid(userId)) return [];
        const rows = await exec().select().from(wallets).where(eq(wallets.user, userId)).orderBy(asc(wallets.createdAt));
        return rows.map(stripNulls);
    }

    async listAll(): Promise<Wallet[]> {
        const rows = await exec().select().from(wallets).orderBy(asc(wallets.createdAt));
        return rows.map(stripNulls);
    }

    /**
     * The user's wallet in `currency`, created (empty, active) if it doesn't
     * exist. Safe when two requests race: the unique (user, currency) index
     * keeps one and both get it.
     */
    async findOrCreate(userId: string, currency: WalletCurrency, tx?: Executor): Promise<{ wallet: Wallet; created: boolean }> {
        const inserted = await exec(tx)
            .insert(wallets)
            .values({ user: userId, currency })
            .onConflictDoNothing({ target: [wallets.user, wallets.currency] })
            .returning();
        if (inserted.length) return { wallet: stripNulls(inserted[0]), created: true };
        const existing = await this.findByUserAndCurrency(userId, currency, tx);
        if (!existing) throw new Error(`Wallet for ${userId}/${currency} vanished after a conflicting insert`);
        return { wallet: existing, created: false };
    }

    async update(id: string, patch: WalletUpdate, tx?: Executor): Promise<Wallet | undefined> {
        const [row] = await exec(tx).update(wallets).set(definedOnly(patch)).where(eq(wallets.id, id)).returning();
        return row ? stripNulls(row) : undefined;
    }

    /**
     * Take `amount` from an active wallet that has enough. Atomic: the check and
     * the debit are one statement. Undefined when the wallet is inactive or
     * short. `alsoLedger` moves ledgerBalance by the same amount.
     */
    async debit(id: string, amount: number, tx?: Executor, options: { alsoLedger?: boolean } = {}): Promise<Wallet | undefined> {
        const [row] = await exec(tx)
            .update(wallets)
            .set({
                balance: sql`${wallets.balance} - ${n(amount)}`,
                ...(options.alsoLedger ? { ledgerBalance: sql`${wallets.ledgerBalance} - ${n(amount)}` } : {}),
            })
            .where(and(eq(wallets.id, id), eq(wallets.status, WALLET_STATUS.ACTIVE as "active"), gte(wallets.balance, amount)))
            .returning();
        return row ? stripNulls(row) : undefined;
    }

    /**
     * Add `amount` to the wallet. With `requireActive` the credit only happens
     * on an active wallet. Undefined when no wallet matched.
     */
    async credit(
        id: string,
        amount: number,
        tx?: Executor,
        options: { alsoLedger?: boolean; requireActive?: boolean } = {}
    ): Promise<Wallet | undefined> {
        const where = options.requireActive
            ? and(eq(wallets.id, id), eq(wallets.status, WALLET_STATUS.ACTIVE as "active"))
            : eq(wallets.id, id);
        const [row] = await exec(tx)
            .update(wallets)
            .set({
                balance: sql`${wallets.balance} + ${n(amount)}`,
                ...(options.alsoLedger ? { ledgerBalance: sql`${wallets.ledgerBalance} + ${n(amount)}` } : {}),
            })
            .where(where)
            .returning();
        return row ? stripNulls(row) : undefined;
    }

    /** Move ledgerBalance (after a confirmed settlement) */
    async adjustLedgerBalance(id: string, delta: number, tx?: Executor): Promise<Wallet | undefined> {
        const [row] = await exec(tx)
            .update(wallets)
            .set({ ledgerBalance: sql`${wallets.ledgerBalance} + ${n(delta)}` })
            .where(eq(wallets.id, id))
            .returning();
        return row ? stripNulls(row) : undefined;
    }
}

export const walletRepository = new WalletRepository();
export default walletRepository;
