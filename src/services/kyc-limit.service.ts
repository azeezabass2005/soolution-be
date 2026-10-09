import config from "../config/env.config";
import User from "../models/user.model";
import yellowCardService from "./yellowcard.service";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import logger from "../utils/logger.utils";

/** YellowCard per-USD rates are cached briefly; the limit check doesn't need tick-level precision */
const RATE_CACHE_MS = 10 * 60 * 1000;

/** Error code the frontend uses to offer "Verify now" */
export const KYC_REQUIRED_CODE = "KYC_REQUIRED";

export interface AmountInCurrency {
    amount?: number | null;
    currency?: string | null;
}

export interface KycLimitResult {
    kycDone: boolean;
    limitUsd: number;
    /** null when no amount could be valued in USD */
    usdValue: number | null;
    requiresKyc: boolean;
}

let rateCache: { at: number; unitsPerUsd: Map<string, number> } | null = null;

/**
 * Lets unverified users transact below KYC_FREE_LIMIT_USD (default $5,000); at or above it,
 * KYC is required. Amounts are valued in USD via YellowCard's per-USD quotes. If no amount can
 * be valued (e.g. rates unavailable), KYC is required: compliance fails closed.
 */
class KycLimitService {
    get limitUsd(): number {
        return config.KYC_FREE_LIMIT_USD;
    }

    /** Units of each currency per 1 USD */
    private async unitsPerUsd(): Promise<Map<string, number>> {
        if (rateCache && Date.now() - rateCache.at < RATE_CACHE_MS) return rateCache.unitsPerUsd;

        const data = await yellowCardService.getRates();
        const rates = data?.rates || (Array.isArray(data) ? data : []);
        const unitsPerUsd = new Map<string, number>();
        for (const rate of rates) {
            const code = String(rate.code || rate.currency || rate.currencyCode || "").toUpperCase();
            // The smaller quote gives the larger USD value, so borderline amounts lean towards verifying
            const quote = Math.min(...[Number(rate.buy), Number(rate.sell)].filter((n) => isFinite(n) && n > 0));
            if (code && isFinite(quote)) unitsPerUsd.set(code, quote);
        }
        rateCache = { at: Date.now(), unitsPerUsd };
        return unitsPerUsd;
    }

    /** USD value of an amount, or null if the currency can't be valued */
    async toUsd(amount: number, currency: string): Promise<number | null> {
        const code = currency.toUpperCase();
        if (code === "USD" || code === "USDT") return amount;
        try {
            const rate = (await this.unitsPerUsd()).get(code);
            return rate ? amount / rate : null;
        } catch (error: any) {
            logger.warn("KYC limit: could not load USD rates", { error: error?.message });
            return null;
        }
    }

    /** Values the first amount that can be converted (e.g. the NGN side when the other is RMB) */
    async valueInUsd(amounts: AmountInCurrency[]): Promise<number | null> {
        for (const { amount, currency } of amounts) {
            if (!amount || amount <= 0 || !currency) continue;
            const usd = await this.toUsd(amount, currency);
            if (usd !== null) return Math.round(usd * 100) / 100;
        }
        return null;
    }

    async check(userId: string, amounts: AmountInCurrency[]): Promise<KycLimitResult> {
        const user = await User.findById(userId).select("isKYCDone").lean();
        const kycDone = !!user?.isKYCDone;
        const usdValue = await this.valueInUsd(amounts);
        const requiresKyc = !kycDone && (usdValue === null || usdValue >= this.limitUsd);
        return { kycDone, limitUsd: this.limitUsd, usdValue, requiresKyc };
    }

    /** Throws a 403 KYC_REQUIRED error when this transaction needs a verified user */
    async assertAllowed(userId: string, amounts: AmountInCurrency[]): Promise<void> {
        const result = await this.check(userId, amounts);
        if (!result.requiresKyc) return;
        const limit = `$${result.limitUsd.toLocaleString("en-US")}`;
        throw errorResponseMessage.createError(
            403,
            result.usdValue === null
                ? `We couldn't confirm this transaction's value right now, so identity verification is required. Verify your identity, or try again shortly.`
                : `Transactions of ${limit} or more (this one is about $${Math.round(result.usdValue).toLocaleString("en-US")}) require identity verification. Please verify your identity to continue.`,
            ErrorSeverity.LOW,
            { code: KYC_REQUIRED_CODE, limitUsd: result.limitUsd, usdValue: result.usdValue },
        );
    }
}

export default new KycLimitService();
