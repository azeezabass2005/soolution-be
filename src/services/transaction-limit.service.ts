import { randomUUID } from "crypto";
import { Types } from "mongoose";
import User from "../models/user.model";
import Transaction from "../models/transaction.model";
import TransactionLimitLock from "../models/transaction-limit-lock.model";
import yellowCardService from "./yellowcard.service";
import platformSettingsService from "./platform-settings.service";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { TRANSACTION_STATUS } from "../common/constant";
import { LIMIT_DAY_UTC_OFFSET_HOURS, TIER_NAME, USER_TIER, UserTier, isUserTier } from "../common/tier.constants";
import logger from "../utils/logger.utils";

/** YellowCard per-USD rates are cached briefly; the limit check doesn't need tick-level precision */
const RATE_CACHE_MS = 10 * 60 * 1000;

/** How long a lock may be held (creation calls payment providers) and how long a second request waits */
const LOCK_TTL_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 20 * 1000;
const LOCK_POLL_MS = 150;

/** Statuses that no longer count towards the daily limit */
const RELEASED_STATUSES = [TRANSACTION_STATUS.FAILED, TRANSACTION_STATUS.CANCELLED];

/** Error code the frontend uses to offer "Upgrade tier" */
export const TIER_LIMIT_CODE = "TIER_LIMIT_EXCEEDED";

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFSET_MS = LIMIT_DAY_UTC_OFFSET_HOURS * 60 * 60 * 1000;

export interface AmountInCurrency {
    amount?: number | null;
    currency?: string | null;
}

export interface TierLimitStatus {
    tier: UserTier;
    tierName: string;
    /** null = unlimited */
    limitUsd: number | null;
    usedUsd: number;
    /** null = unlimited */
    remainingUsd: number | null;
    /** When today's usage resets (midnight Lagos time) */
    resetsAt: string;
    /** The next tier up, if any */
    nextTier: { tier: UserTier; name: string; limitUsd: number | null } | null;
}

export interface TierLimitCheck extends TierLimitStatus {
    /** null when the amount couldn't be valued in USD */
    usdValue: number | null;
    allowed: boolean;
    reason?: "limit_exceeded" | "unvalued";
}

let rateCache: { at: number; unitsPerUsd: Map<string, number> } | null = null;

const roundUsd = (value: number) => Math.round(value * 100) / 100;
const formatUsd = (value: number) => `$${Math.floor(value).toLocaleString("en-US")}`;

/**
 * Daily transaction limits per account tier.
 *
 * Every send and receive is valued in USD when it's created and stored on the
 * transaction (`usdValue`); a user's usage is the sum for the current day
 * (midnight to midnight, Lagos time), excluding failed and cancelled ones.
 * Tier 3 is unlimited. If a transaction can't be valued for a limited tier,
 * it's refused: the limit fails closed.
 */
class TransactionLimitService {
    /** Start of the current limit day */
    private dayStart(now = Date.now()): Date {
        return new Date(Math.floor((now + OFFSET_MS) / DAY_MS) * DAY_MS - OFFSET_MS);
    }

    /** Units of each currency per 1 USD */
    private async unitsPerUsd(): Promise<Map<string, number>> {
        if (rateCache && Date.now() - rateCache.at < RATE_CACHE_MS) return rateCache.unitsPerUsd;

        const data = await yellowCardService.getRates();
        const rates = data?.rates || (Array.isArray(data) ? data : []);
        const unitsPerUsd = new Map<string, number>();
        for (const rate of rates) {
            const code = String(rate.code || rate.currency || rate.currencyCode || "").toUpperCase();
            // The smaller quote gives the larger USD value, so borderline amounts count fully
            const quote = Math.min(...[Number(rate.buy), Number(rate.sell)].filter((n) => isFinite(n) && n > 0));
            if (code && isFinite(quote)) unitsPerUsd.set(code, quote);
        }
        rateCache = { at: Date.now(), unitsPerUsd };
        return unitsPerUsd;
    }

    /** USD value of an amount, or null if the currency can't be valued */
    async toUsd(amount: number, currency: string): Promise<number | null> {
        const code = currency.toUpperCase();
        if (code === "USD" || code === "USDT" || code === "USDC") return amount;
        try {
            const rate = (await this.unitsPerUsd()).get(code);
            return rate ? amount / rate : null;
        } catch (error: any) {
            logger.warn("Transaction limit: could not load USD rates", { error: error?.message });
            return null;
        }
    }

    /** Values the first amount that can be converted (e.g. the NGN side when the other is RMB) */
    async valueInUsd(amounts: AmountInCurrency[]): Promise<number | null> {
        for (const { amount, currency } of amounts) {
            if (!amount || amount <= 0 || !currency) continue;
            const usd = await this.toUsd(amount, currency);
            if (usd !== null) return roundUsd(usd);
        }
        return null;
    }

    private async getTier(userId: string): Promise<UserTier> {
        const user = await User.findById(userId).select("tier").lean();
        if (!user) throw errorResponseMessage.resourceNotFound("User");
        return isUserTier(user.tier) ? user.tier : USER_TIER.INDIVIDUAL;
    }

    /** USD already used today (transactions created before usdValue was stored are valued now) */
    async getUsedTodayUsd(userId: string): Promise<number> {
        const transactions = await Transaction.find({
            user: new Types.ObjectId(userId),
            createdAt: { $gte: this.dayStart() },
            status: { $nin: RELEASED_STATUSES },
        }).select("usdValue amount currency").lean();

        let used = 0;
        for (const transaction of transactions) {
            if (typeof transaction.usdValue === "number") {
                used += transaction.usdValue;
            } else if (transaction.amount && transaction.currency) {
                used += (await this.toUsd(transaction.amount, transaction.currency)) ?? 0;
            }
        }
        return roundUsd(used);
    }

    async getStatus(userId: string): Promise<TierLimitStatus> {
        const tier = await this.getTier(userId);
        const [limitUsd, usedUsd, allLimits] = await Promise.all([
            platformSettingsService.getTierDailyLimitUsd(tier),
            this.getUsedTodayUsd(userId),
            platformSettingsService.getTierDailyLimits(),
        ]);
        const next = (tier + 1) as UserTier;
        return {
            tier,
            tierName: TIER_NAME[tier],
            limitUsd,
            usedUsd,
            remainingUsd: limitUsd === null ? null : roundUsd(Math.max(0, limitUsd - usedUsd)),
            resetsAt: new Date(this.dayStart().getTime() + DAY_MS).toISOString(),
            nextTier: isUserTier(next) ? { tier: next, name: TIER_NAME[next], limitUsd: allLimits[next] } : null,
        };
    }

    async check(userId: string, amounts: AmountInCurrency[]): Promise<TierLimitCheck> {
        const [status, usdValue] = await Promise.all([this.getStatus(userId), this.valueInUsd(amounts)]);
        if (status.limitUsd === null) return { ...status, usdValue, allowed: true };
        if (usdValue === null) return { ...status, usdValue, allowed: false, reason: "unvalued" };
        // A cent of tolerance for rounding
        const allowed = status.usedUsd + usdValue <= status.limitUsd + 0.01;
        return { ...status, usdValue, allowed, ...(allowed ? {} : { reason: "limit_exceeded" as const }) };
    }

    /**
     * Throws a 403 TIER_LIMIT_EXCEEDED error when this transaction would take the
     * user over today's limit. Returns the USD value to store on the transaction.
     * Call inside `withUserLock` so parallel requests can't both pass.
     */
    async assertAllowed(userId: string, amounts: AmountInCurrency[]): Promise<{ usdValue: number | null }> {
        const result = await this.check(userId, amounts);
        if (result.allowed) return { usdValue: result.usdValue };

        const details = {
            code: TIER_LIMIT_CODE,
            reason: result.reason,
            tier: result.tier,
            limitUsd: result.limitUsd,
            usedUsd: result.usedUsd,
            remainingUsd: result.remainingUsd,
            usdValue: result.usdValue,
            resetsAt: result.resetsAt,
        };
        const message = result.reason === "unvalued"
            ? "We couldn't confirm this transaction's value against your daily limit right now. Please try again shortly."
            : `This transaction (about ${formatUsd(result.usdValue!)}) is over your Tier ${result.tier} daily limit of ${formatUsd(result.limitUsd!)}. `
                + (result.remainingUsd! > 0 ? `You have ${formatUsd(result.remainingUsd!)} left today. ` : "You've used today's limit. ")
                + "Upgrade your tier to transact more.";
        throw errorResponseMessage.createError(403, message, ErrorSeverity.LOW, details);
    }

    /**
     * Runs `fn` while holding the user's limit lock: one transaction is checked and
     * created at a time per user, so usage can't be exceeded by parallel requests.
     */
    async withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
        const key = String(userId);
        const token = randomUUID();
        const deadline = Date.now() + LOCK_WAIT_MS;

        while (!(await this.tryLock(key, token))) {
            if (Date.now() > deadline) {
                throw errorResponseMessage.createError(
                    429,
                    "Another transaction is still being processed. Please try again in a moment.",
                    ErrorSeverity.LOW
                );
            }
            await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
        }

        try {
            return await fn();
        } finally {
            await TransactionLimitLock.deleteOne({ _id: key, token }).catch((error) =>
                logger.warn("Transaction limit: failed to release lock", { userId: key, error: error?.message }));
        }
    }

    private async tryLock(key: string, token: string): Promise<boolean> {
        const now = new Date();
        try {
            // Takes the lock if it's free or expired; an unexpired lock makes the upsert collide
            await TransactionLimitLock.findOneAndUpdate(
                { _id: key, expiresAt: { $lte: now } },
                { $set: { token, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) } },
                { upsert: true }
            );
            return true;
        } catch (error: any) {
            if (error?.code === 11000) return false;
            throw error;
        }
    }
}

export default new TransactionLimitService();
