import exchangeRateRepository, { type ExchangeRateUpdate } from "../repositories/exchange-rate.repository";
import type { ExchangeRate } from "../types/entities";
import type { CurrencyCode } from "../types/enums";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { isUniqueViolation } from "../db/errors";
import fxRateService from "./fx-rate.service";
import platformSettingsService from "./platform-settings.service";
import { YELLOWCARD_FLOW_CURRENCIES } from "../common/payment-link.constants";
import logger from "../utils/logger.utils";

/** A rate as users see it: live from the provider where there is one, else the admin's */
export type PublicExchangeRate = ExchangeRate & { source: "live" | "admin" };

/**
 * Currencies priced live, the same way a wallet exchange quote prices them
 * (fxRateService: GHS from Fincra, the rest from YellowCard, each with the
 * admin's buffer), so the rates users read are the rates they get. Like every
 * row in the table, a rate is units of `to` per 1 `from`: NGN→GHS is cedis per
 * naira (we sell cedis: "buy" side), GHS→NGN is naira per cedi ("sell" side).
 */
const LIVE_CURRENCIES = ["GHS", ...YELLOWCARD_FLOW_CURRENCIES] as const;
const LIVE_PAIRS: Array<{ from: CurrencyCode; to: CurrencyCode; side: "buy" | "sell"; currency: string }> = LIVE_CURRENCIES.flatMap((c) => [
    { from: "NGN" as CurrencyCode, to: c as CurrencyCode, side: "buy" as const, currency: c },
    { from: c as CurrencyCode, to: "NGN" as CurrencyCode, side: "sell" as const, currency: c },
]);

/** GHS and YellowCard currencies are priced live (Pricing sets the buffer); manual rates are for the rest, such as RMB */
const isLiveCurrency = (code: string) => (LIVE_CURRENCIES as readonly string[]).includes(String(code).toUpperCase());
const assertNotLive = (pair: { from: string; to: string }) => {
    const live = [pair.from, pair.to].find(isLiveCurrency);
    if (live) throw errorResponseMessage.createError(400, `${live} is priced live with your buffer (Pricing). Manual rates are only for currencies without a provider, such as RMB.`, ErrorSeverity.LOW);
};

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
     * pairs, such as RMB, come from the admin's table. Live currencies never
     * show a manual rate: if the provider can't be reached the pair is left
     * out (the calculator says so) rather than showing an old number. A
     * currency the admin turned off (Platform controls) isn't offered.
     */
    public async listForUsers(): Promise<PublicExchangeRate[]> {
        // RMB (no provider): the admin's manual RMB rate, the one RMB sends are charged at
        const ops = await platformSettingsService.getOperations();
        const rmbRate = Number(ops.manual.rates.RMB) || 0;
        const now = new Date();
        const result: PublicExchangeRate[] = rmbRate > 0 && !ops.currencies.off.includes("RMB")
            ? [{ id: "manual-NGN-RMB", from: "NGN" as CurrencyCode, to: "RMB" as CurrencyCode, rate: Number((1 / rmbRate).toPrecision(8)), isActive: true, createdAt: now, updatedAt: now, source: "admin" } as PublicExchangeRate]
            : [];

        // Currencies the admin turned off for everyone aren't offered
        const live = await Promise.all(LIVE_PAIRS.filter((p) => !ops.currencies.off.includes(p.currency)).map(async (pair) => {
            try {
                const { rate: ngnPerUnit, source } = await fxRateService.ngnPerUnit(pair.currency, pair.side);
                if (!(ngnPerUnit > 0)) throw new Error("no rate");
                const rate = pair.from === "NGN" ? 1 / ngnPerUnit : ngnPerUnit;
                const now = new Date();
                return {
                    id: `live-${pair.from}-${pair.to}`, isActive: true, createdAt: now,
                    from: pair.from,
                    to: pair.to,
                    rate: Number(rate.toPrecision(8)),
                    updatedAt: now,
                    // Provider names never reach customers
                    source: source === "admin" ? "admin" : "live",
                } as PublicExchangeRate;
            } catch (error: any) {
                logger.warn("Live rate unavailable; pair left out", { pair: `${pair.from}-${pair.to}`, error: error?.message });
                return null;
            }
        }));
        return [...live.filter((r): r is PublicExchangeRate => !!r), ...result];
    }

    public async create(data: { from: CurrencyCode; to: CurrencyCode; rate: number; isActive?: boolean }): Promise<ExchangeRate> {
        assertNotLive(data);
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
        if (typeof patch.from === "string" || typeof patch.to === "string") assertNotLive({ from: String(patch.from ?? ""), to: String(patch.to ?? "") });
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
