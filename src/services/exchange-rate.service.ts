import exchangeRateRepository, { type ExchangeRateUpdate } from "../repositories/exchange-rate.repository";
import type { ExchangeRate } from "../types/entities";
import type { CurrencyCode } from "../types/enums";
import errorResponseMessage from "../common/messages/error-response-message";
import { isUniqueViolation } from "../db/errors";

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
