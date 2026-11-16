import { and, asc, count, eq, isNull, type SQL } from "drizzle-orm";
import { bankAccountDetails } from "../db/schema";
import type { Executor } from "../db/client";
import type { BankAccountDetails } from "../types/entities";
import { definedOnly, exec, isUuid, stripNulls, upper } from "./utils";

export type NewBankAccount = typeof bankAccountDetails.$inferInsert;
export type BankAccountUpdate = Partial<Pick<NewBankAccount, "currency" | "accountNumber" | "accountName" | "bankName" | "bankCode" | "isDefault">>;

/** `null` owner = a company account; a user id = that user's saved account */
export type BankAccountOwner = string | null;

const ownerIs = (owner: BankAccountOwner): SQL =>
    owner === null ? isNull(bankAccountDetails.user) : eq(bankAccountDetails.user, owner);

const normalise = <T extends { currency?: string; accountNumber?: string; bankCode?: string | null }>(data: T): T => ({
    ...data,
    ...(data.currency !== undefined ? { currency: upper(data.currency) } : {}),
    ...(data.accountNumber !== undefined ? { accountNumber: data.accountNumber.trim() } : {}),
    ...(typeof data.bankCode === "string" ? { bankCode: data.bankCode.trim() } : {}),
});

class BankAccountRepository {
    async create(data: NewBankAccount, tx?: Executor): Promise<BankAccountDetails> {
        const [row] = await exec(tx).insert(bankAccountDetails).values(normalise(data)).returning();
        return stripNulls(row);
    }

    /** Oldest first */
    async list(owner: BankAccountOwner, filter: { currency?: string } = {}): Promise<BankAccountDetails[]> {
        if (owner !== null && !isUuid(owner)) return [];
        const where = [ownerIs(owner)];
        if (filter.currency) where.push(eq(bankAccountDetails.currency, filter.currency.toUpperCase()));
        const rows = await exec().select().from(bankAccountDetails).where(and(...where)).orderBy(asc(bankAccountDetails.createdAt));
        return rows.map(stripNulls);
    }

    async findOwned(id: string, owner: BankAccountOwner, tx?: Executor): Promise<BankAccountDetails | undefined> {
        if (!isUuid(id) || (owner !== null && !isUuid(owner))) return undefined;
        const [row] = await exec(tx).select().from(bankAccountDetails).where(and(eq(bankAccountDetails.id, id), ownerIs(owner))).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findCompanyDefault(currency: string, tx?: Executor): Promise<BankAccountDetails | undefined> {
        const [row] = await exec(tx)
            .select()
            .from(bankAccountDetails)
            .where(and(isNull(bankAccountDetails.user), eq(bankAccountDetails.isDefault, true), eq(bankAccountDetails.currency, currency.toUpperCase())))
            .limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /** A user's saved account with the same number at the same bank */
    async findUserDuplicate(userId: string, fields: { currency: string; accountNumber: string; bankCode?: string; bankName?: string }) {
        const where = [
            eq(bankAccountDetails.user, userId),
            eq(bankAccountDetails.currency, fields.currency.toUpperCase()),
            eq(bankAccountDetails.accountNumber, fields.accountNumber.trim()),
            fields.bankCode ? eq(bankAccountDetails.bankCode, fields.bankCode.trim()) : eq(bankAccountDetails.bankName, fields.bankName ?? ""),
        ];
        const [row] = await exec().select().from(bankAccountDetails).where(and(...where)).limit(1);
        return row ? (stripNulls(row) as BankAccountDetails) : undefined;
    }

    async count(owner: BankAccountOwner, currency: string, tx?: Executor): Promise<number> {
        const [row] = await exec(tx)
            .select({ n: count() })
            .from(bankAccountDetails)
            .where(and(ownerIs(owner), eq(bankAccountDetails.currency, currency.toUpperCase())));
        return Number(row?.n ?? 0);
    }

    async update(id: string, patch: BankAccountUpdate, tx?: Executor): Promise<BankAccountDetails | undefined> {
        if (!isUuid(id)) return undefined;
        const values = definedOnly(normalise(patch));
        if (!Object.keys(values).length) return this.findById(id, tx);
        const [row] = await exec(tx).update(bankAccountDetails).set(values).where(eq(bankAccountDetails.id, id)).returning();
        return row ? stripNulls(row) : undefined;
    }

    async findById(id: string, tx?: Executor): Promise<BankAccountDetails | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec(tx).select().from(bankAccountDetails).where(eq(bankAccountDetails.id, id)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /** Clears the company default for a currency (before setting a new one) */
    async clearCompanyDefault(currency: string, tx: Executor): Promise<void> {
        await tx
            .update(bankAccountDetails)
            .set({ isDefault: false })
            .where(and(isNull(bankAccountDetails.user), eq(bankAccountDetails.currency, currency.toUpperCase()), eq(bankAccountDetails.isDefault, true)));
    }

    async delete(id: string): Promise<BankAccountDetails | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec().delete(bankAccountDetails).where(eq(bankAccountDetails.id, id)).returning();
        return row ? stripNulls(row) : undefined;
    }
}

export const bankAccountRepository = new BankAccountRepository();
export default bankAccountRepository;
