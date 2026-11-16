import { and, desc, eq } from "drizzle-orm";
import { exchangeRates } from "../db/schema";
import type { ExchangeRate } from "../types/entities";
import type { CurrencyCode } from "../types/enums";
import { definedOnly, exec, isUuid, stripNulls } from "./utils";

export type NewExchangeRate = typeof exchangeRates.$inferInsert;
export type ExchangeRateUpdate = Partial<Pick<NewExchangeRate, "from" | "to" | "rate" | "isActive">>;

class ExchangeRateRepository {
    async create(data: NewExchangeRate): Promise<ExchangeRate> {
        const [row] = await exec().insert(exchangeRates).values(data).returning();
        return stripNulls(row);
    }

    async findById(id: string): Promise<ExchangeRate | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await exec().select().from(exchangeRates).where(eq(exchangeRates.id, id)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /** The rate for a pair; with `activeOnly`, only if it's active */
    async findPair(from: string, to: string, options: { activeOnly?: boolean } = {}): Promise<ExchangeRate | undefined> {
        const where = [eq(exchangeRates.from, from as CurrencyCode), eq(exchangeRates.to, to as CurrencyCode)];
        if (options.activeOnly) where.push(eq(exchangeRates.isActive, true));
        const [row] = await exec().select().from(exchangeRates).where(and(...where)).limit(1);
        return row ? stripNulls(row) : undefined;
    }

    /** Newest first */
    async list(filter: { isActive?: boolean } = {}, limit = 300): Promise<ExchangeRate[]> {
        const where = filter.isActive !== undefined ? eq(exchangeRates.isActive, filter.isActive) : undefined;
        const rows = await exec().select().from(exchangeRates).where(where).orderBy(desc(exchangeRates.createdAt)).limit(limit);
        return rows.map(stripNulls);
    }

    async update(id: string, patch: ExchangeRateUpdate): Promise<ExchangeRate | undefined> {
        if (!isUuid(id)) return undefined;
        const values = definedOnly(patch);
        if (!Object.keys(values).length) return this.findById(id);
        const [row] = await exec().update(exchangeRates).set(values).where(eq(exchangeRates.id, id)).returning();
        return row ? stripNulls(row) : undefined;
    }
}

export const exchangeRateRepository = new ExchangeRateRepository();
export default exchangeRateRepository;
