import { and, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { kycApplications } from "../db/schema";
import type { KycApplication, KycReviewEvent } from "../types/entities";
import type { KycStatus, KycType } from "../common/kyc.constants";
import type { UserTier } from "../common/tier.constants";
import { pageWindow, toPage, type PageRequest, type Paginated } from "../db/pagination";
import { definedOnly, escapeLike, exec, isUuid, stripNulls } from "./utils";

export type NewKycApplication = typeof kycApplications.$inferInsert;
export type KycApplicationUpdate = Partial<Omit<NewKycApplication, "id" | "user" | "createdAt" | "updatedAt" | "history" | "archive">>;

export interface KycAdminFilter {
    tier?: UserTier;
    status?: KycStatus;
    type?: KycType;
    /** Matches the display name, or any of these applicants */
    search?: { text: string; userIds: string[] };
}

class KycApplicationRepository {
    async create(data: NewKycApplication): Promise<KycApplication> {
        const [row] = await exec().insert(kycApplications).values(data).returning();
        return stripNulls(row);
    }

    async findById(id: string): Promise<KycApplication | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec().select().from(kycApplications).where(eq(kycApplications.id, id)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    async findByUser(userId: string): Promise<KycApplication | undefined> {
        if (!isUuid(userId)) return undefined;
        const [row] = await exec().select().from(kycApplications).where(eq(kycApplications.user, userId)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /**
     * Set fields (`null` clears one) and optionally append to the review
     * history / archive in the same statement.
     */
    async update(
        id: string,
        patch: KycApplicationUpdate,
        append: { history?: KycReviewEvent; archive?: Record<string, unknown> } = {}
    ): Promise<KycApplication | undefined> {
        if (!isUuid(id)) return undefined;
        const values: Record<string, unknown> = definedOnly(patch as Record<string, unknown>);
        if (append.history) {
            values.history = sql`${kycApplications.history} || ${JSON.stringify([append.history])}::jsonb`;
        }
        if (append.archive) {
            values.archive = sql`coalesce(${kycApplications.archive}, '[]'::jsonb) || ${JSON.stringify([append.archive])}::jsonb`;
        }
        if (!Object.keys(values).length) return this.findById(id);
        const [row] = await exec().update(kycApplications).set(values).where(eq(kycApplications.id, id)).returning();
        return row ? stripNulls(row) : undefined;
    }

    /** Most recently updated first */
    async paginate(filter: KycAdminFilter, request: PageRequest): Promise<Paginated<KycApplication>> {
        const window = pageWindow(request, { limit: 20, maxLimit: 100 });
        const where: SQL[] = [];
        if (filter.tier !== undefined) where.push(eq(kycApplications.tier, filter.tier));
        if (filter.status) where.push(eq(kycApplications.status, filter.status));
        if (filter.type) where.push(eq(kycApplications.type, filter.type));
        if (filter.search) {
            const matches: SQL[] = [ilike(kycApplications.displayName, `%${escapeLike(filter.search.text)}%`)];
            const ids = filter.search.userIds.filter(isUuid);
            if (ids.length) matches.push(inArray(kycApplications.user, ids));
            where.push(or(...matches)!);
        }
        const condition = where.length ? and(...where) : undefined;
        const [rows, [{ n }]] = await Promise.all([
            exec().select().from(kycApplications).where(condition).orderBy(desc(kycApplications.updatedAt), desc(kycApplications.id)).limit(window.limit).offset(window.offset),
            exec().select({ n: count() }).from(kycApplications).where(condition),
        ]);
        return toPage(rows.map(stripNulls), Number(n), window);
    }

    async countByStatus(): Promise<Record<string, number>> {
        const rows = await exec().select({ status: kycApplications.status, n: count() }).from(kycApplications).groupBy(kycApplications.status);
        return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]));
    }
}

export const kycApplicationRepository = new KycApplicationRepository();
export default kycApplicationRepository;
