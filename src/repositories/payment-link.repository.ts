import { and, count, desc, eq } from "drizzle-orm";
import { paymentLinks } from "../db/schema";
import type { PaymentLink } from "../types/entities";
import { exec, isUuid, stripNulls } from "./utils";

export type NewPaymentLink = typeof paymentLinks.$inferInsert;

class PaymentLinkRepository {
    async create(data: NewPaymentLink): Promise<PaymentLink> {
        const [row] = await exec().insert(paymentLinks).values(data).returning();
        return stripNulls(row);
    }

    async findBySlug(slug: string): Promise<PaymentLink | undefined> {
        const [row] = await exec().select().from(paymentLinks).where(eq(paymentLinks.slug, slug)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findOwned(id: string, userId: string): Promise<PaymentLink | undefined> {
        if (!isUuid(id) || !isUuid(userId)) return undefined;
        const [row] = await exec().select().from(paymentLinks).where(and(eq(paymentLinks.id, id), eq(paymentLinks.user, userId))).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /** Newest first */
    async listForUser(userId: string, limit = 100): Promise<PaymentLink[]> {
        if (!isUuid(userId)) return [];
        const rows = await exec().select().from(paymentLinks).where(eq(paymentLinks.user, userId)).orderBy(desc(paymentLinks.createdAt)).limit(limit);
        return rows.map(stripNulls);
    }

    async countActive(userId: string): Promise<number> {
        if (!isUuid(userId)) return 0;
        const [row] = await exec().select({ n: count() }).from(paymentLinks).where(and(eq(paymentLinks.user, userId), eq(paymentLinks.active, true)));
        return Number(row?.n ?? 0);
    }

    async setActive(id: string, userId: string, active: boolean): Promise<PaymentLink | undefined> {
        if (!isUuid(id) || !isUuid(userId)) return undefined;
        const [row] = await exec()
            .update(paymentLinks)
            .set({ active })
            .where(and(eq(paymentLinks.id, id), eq(paymentLinks.user, userId)))
            .returning();
        return row ? stripNulls(row) : undefined;
    }
}

export const paymentLinkRepository = new PaymentLinkRepository();
export default paymentLinkRepository;
