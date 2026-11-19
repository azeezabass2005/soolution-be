import exchangeRateRepository, { type ExchangeRateUpdate } from "../repositories/exchange-rate.repository";
import type { ExchangeRate } from "../types/entities";
import type { CurrencyCode } from "../types/enums";
import errorResponseMessage from "../common/messages/error-response-message";
import { isUniqueViolation } from "../db/errors";
import fxRateService from "./fx-rate.service";
import logger from "../utils/logger.utils";

/** A rate as users see it: live from the provider where there is one, else the admin's */
export type PublicExchangeRate = ExchangeRate & { source: "fincra" | "admin" };

/**
 * Pairs priced live by Fincra, with the admin's buffer for that direction.
 * Like every row in the table, the rate is units of `to` per 1 `from`:
 * NGN→GHS is cedis per naira, GHS→NGN is naira per cedi.
 */
const LIVE_PAIRS: Array<{ from: CurrencyCode; to: CurrencyCode; side: "buy" | "sell" }> = [
    { from: "NGN" as CurrencyCode, to: "GHS" as CurrencyCode, side: "buy" },
    { from: "GHS" as CurrencyCode, to: "NGN" as CurrencyCode, side: "sell" },
];

/** Admin-managed exchange rates (units of `to` per 1 `from`) */
class ExchangeRateService {
    /** Whether a rate exists for the pair (active or not) */
    public async checkRateExistence(from: CurrencyCode, to: CurrencyCode): Promise<boolean> {
        return !!(await exchangeRateRepository.findPair(from, to));
    }

    /** The rate for a pair; with `activeOnly`, only when it's active */
    public async findPair(from: string, to: string, options: { activeOnly?: boolean } = {}): Promise<ExchangeRate | undefined> {
        return exchangeRateRepository.findPair(from, to, options);
    }

    /** Newest first; optionally only active ones */
    public async list(filter: { isActive?: boolean } = {}): Promise<ExchangeRate[]> {
        return exchangeRateRepository.list(filter);
    }

    /**
     * The rates users see. NGN↔GHS come live from Fincra with the admin's
     * buffer (the same rate sends and payment links are charged at); other
     * pairs, such as RMB, come from the admin's table. A pair the admin has
     * switched off stays hidden; if Fincra can't be reached, the admin's
     * rate for that pair is shown instead.
     */
    public async listForUsers(): Promise<PublicExchangeRate[]> {
        const rows = await exchangeRateRepository.list({});
        const isLive = (r: { from: string; to: string }) => LIVE_PAIRS.some((p) => p.from === r.from && p.to === r.to);
        const result: PublicExchangeRate[] = rows.filter((r) => r.isActive && !isLive(r)).map((r) => ({ ...r, source: "admin" as const }));

        const live = await Promise.all(LIVE_PAIRS.map(async (pair) => {
            const row = rows.find((r) => r.from === pair.from && r.to === pair.to);
            if (row && !row.isActive) return null;
            try {
                const { rate: ngnPerGhs } = await fxRateService.ngnPerUnit("GHS", pair.side);
                const rate = pair.to === "GHS" ? 1 / ngnPerGhs : ngnPerGhs;
                const now = new Date();
                return {
                    ...(row ?? { id: `live-${pair.from}-${pair.to}`, isActive: true, createdAt: now }),
                    from: pair.from,
                    to: pair.to,
                    rate: Number(rate.toPrecision(8)),
                    updatedAt: now,
                    source: "fincra" as const,
                } as PublicExchangeRate;
            } catch (error: any) {
                logger.warn("Live GHS rate unavailable; showing the admin rate", { pair: `${pair.from}-${pair.to}`, error: error?.message });
                return row ? { ...row, source: "admin" as const } : null;
            }
        }));
        return [...live.filter((r): r is PublicExchangeRate => !!r), ...result];
    }

    public async create(data: { from: CurrencyCode; to: CurrencyCode; rate: number; isActive?: boolean }): Promise<ExchangeRate> {
        if (typeof data.isActive !== "boolean") {
            throw errorResponseMessage.payloadIncorrect("isActive is required");
        }
        try {
            return await exchangeRateRepository.create({ from: data.from, to: data.to, rate: data.rate, isActive: data.isActive });
        } catch (error) {
            if (isUniqueViolation(error, "exchange_rates_pair_key")) {
                throw errorResponseMessage.resourceAlreadyExist("Exchange Rate");
            }
            throw error;
        }
    }

    /** Only the rate fields can change */
    public async update(id: string, patch: Record<string, unknown>): Promise<ExchangeRate | undefined> {
        const allowed: ExchangeRateUpdate = {};
        if (typeof patch.from === "string") allowed.from = patch.from as CurrencyCode;
        if (typeof patch.to === "string") allowed.to = patch.to as CurrencyCode;
        if (typeof patch.rate === "number") allowed.rate = patch.rate;
        if (typeof patch.isActive === "boolean") allowed.isActive = patch.isActive;
        try {
            return await exchangeRateRepository.update(id, allowed);
        } catch (error) {
            if (isUniqueViolation(error, "exchange_rates_pair_key")) {
                throw errorResponseMessage.resourceAlreadyExist("Exchange Rate");
            }
            throw error;
        }
    }

    /** Toggle the activeness of an exchange rate */
    public async toggleActiveness(exchangeRateId: string): Promise<ExchangeRate> {
        const exchangeRate = await exchangeRateRepository.findById(exchangeRateId);
        if (!exchangeRate) {
            throw errorResponseMessage.resourceNotFound("Exchange Rate");
        }
        const updated = await exchangeRateRepository.update(exchangeRateId, { isActive: !exchangeRate.isActive });
        if (!updated) throw errorResponseMessage.resourceNotFound("Exchange Rate");
        return updated;
    }
}

export default ExchangeRateService;
