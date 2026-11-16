import { and, count, desc, eq, sql } from "drizzle-orm";
import { beneficiaries } from "../db/schema";
import type { Beneficiary } from "../types/entities";
import type { BeneficiaryKind } from "../types/enums";
import { exec, isUuid, stripNulls } from "./utils";

export type NewBeneficiary = typeof beneficiaries.$inferInsert;

class BeneficiaryRepository {
    /** Most recently used first (never-used ones last, newest first) */
    async listForUser(userId: string, currency?: string): Promise<Beneficiary[]> {
        if (!isUuid(userId)) return [];
        const where = [eq(beneficiaries.user, userId)];
        if (currency) where.push(eq(beneficiaries.currency, currency.toUpperCase()));
        const rows = await exec()
            .select()
            .from(beneficiaries)
            .where(and(...where))
            .orderBy(sql`${beneficiaries.lastUsedAt} desc nulls last`, desc(beneficiaries.createdAt));
        return rows.map(stripNulls);
    }

    async listForUserOfKind(userId: string, currency: string, kind: BeneficiaryKind): Promise<Beneficiary[]> {
        if (!isUuid(userId)) return [];
        const rows = await exec()
            .select()
            .from(beneficiaries)
            .where(and(eq(beneficiaries.user, userId), eq(beneficiaries.currency, currency), eq(beneficiaries.kind, kind)));
        return rows.map(stripNulls);
    }

    async findOwned(id: string, userId: string): Promise<Beneficiary | undefined> {
        if (!isUuid(id) || !isUuid(userId)) return undefined;
        const [row] = await exec().select().from(beneficiaries).where(and(eq(beneficiaries.id, id), eq(beneficiaries.user, userId))).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async countForUser(userId: string): Promise<number> {
        const [row] = await exec().select({ n: count() }).from(beneficiaries).where(eq(beneficiaries.user, userId));
        return Number(row?.n ?? 0);
    }

    async create(data: NewBeneficiary): Promise<Beneficiary> {
        const [row] = await exec().insert(beneficiaries).values(data).returning();
        return stripNulls(row);
    }

    async delete(id: string): Promise<void> {
        await exec().delete(beneficiaries).where(eq(beneficiaries.id, id));
    }

    async touchLastUsed(id: string): Promise<void> {
        if (!isUuid(id)) return;
        await exec().update(beneficiaries).set({ lastUsedAt: new Date() }).where(eq(beneficiaries.id, id));
    }
}

export const beneficiaryRepository = new BeneficiaryRepository();
export default beneficiaryRepository;
