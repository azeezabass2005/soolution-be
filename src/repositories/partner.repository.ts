import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { partners } from "../db/schema";
import type { Partner } from "../types/entities";
import type { PartnerRole, PartnerStatus } from "../types/enums";
import { pageWindow, toPage, type PageRequest, type Paginated } from "../db/pagination";
import { definedOnly, escapeLike, exec, isUuid, stripNulls } from "./utils";

export type NewPartner = typeof partners.$inferInsert;
export type PartnerUpdate = Partial<Omit<NewPartner, "id" | "createdAt" | "updatedAt">>;

/** Filters the listing accepts (a whitelist: never spread a request query into SQL) */
export interface PartnerFilter {
    role?: PartnerRole;
    status?: PartnerStatus;
    country?: string;
    city?: string;
    isVerified?: boolean;
    isAvailable?: boolean;
}

const ROLE_DATA_ARRAYS = ["skills", "specialties", "subjects", "talents"] as const;
const ROLE_DATA_TEXT = ["expertise", "bio", "title"] as const;

/** roleData.<key> is an array with an element matching `pattern` */
const roleDataArrayMatches = (key: string, pattern: string): SQL =>
    sql`exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(${partners.roleData} -> ${key}) = 'array' then ${partners.roleData} -> ${key} else '[]'::jsonb end) as element(value) where element.value ilike ${pattern})`;

const normalise = <T extends { email?: string }>(data: T): T =>
    data.email !== undefined ? { ...data, email: data.email.trim().toLowerCase() } : data;

class PartnerRepository {
    async create(data: NewPartner): Promise<Partner> {
        const values = normalise(data);
        // As the Mongoose pre-save hook did: an active partner is active now
        if (values.status === "active") values.lastActiveAt ??= new Date();
        const [row] = await exec().insert(partners).values(values).returning();
        return stripNulls(row);
    }

    async update(id: string, patch: PartnerUpdate): Promise<Partner | undefined> {
        if (!isUuid(id)) return undefined;
        const values = definedOnly(normalise(patch));
        if (!Object.keys(values).length) return this.findById(id);
        const [row] = await exec().update(partners).set(values).where(eq(partners.id, id)).returning();
        return row ? stripNulls(row) : undefined;
    }

    async findById(id: string): Promise<Partner | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec().select().from(partners).where(eq(partners.id, id)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /** Newest first; `search` matches name, description, location and role skills */
    async paginate(filter: PartnerFilter, request: PageRequest, search?: string): Promise<Paginated<Partner>> {
        const window = pageWindow(request);
        const where: SQL[] = [];
        if (filter.role) where.push(eq(partners.role, filter.role));
        if (filter.status) where.push(eq(partners.status, filter.status));
        if (filter.country) where.push(eq(partners.country, filter.country));
        if (filter.city) where.push(eq(partners.city, filter.city));
        if (filter.isVerified !== undefined) where.push(eq(partners.isVerified, filter.isVerified));
        if (filter.isAvailable !== undefined) where.push(eq(partners.isAvailable, filter.isAvailable));
        if (search?.trim()) {
            const pattern = `%${escapeLike(search.trim())}%`;
            where.push(
                or(
                    ilike(partners.name, pattern),
                    ilike(partners.description, pattern),
                    ilike(partners.city, pattern),
                    ilike(partners.country, pattern),
                    ...ROLE_DATA_ARRAYS.map((key) => roleDataArrayMatches(key, pattern)),
                    ...ROLE_DATA_TEXT.map((key) => sql`${partners.roleData} ->> ${key} ilike ${pattern}`)
                )!
            );
        }
        const condition = where.length ? and(...where) : undefined;
        const [rows, [{ n }]] = await Promise.all([
            exec().select().from(partners).where(condition).orderBy(desc(partners.createdAt), desc(partners.id)).limit(window.limit).offset(window.offset),
            exec().select({ n: count() }).from(partners).where(condition),
        ]);
        return toPage(rows.map(stripNulls), Number(n), window);
    }
}

export const partnerRepository = new PartnerRepository();
export default partnerRepository;
