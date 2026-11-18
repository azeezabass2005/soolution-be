import { randomUUID } from "crypto";
import userRepository from "../repositories/user.repository";
import transactionRepository from "../repositories/transaction.repository";
import transactionLimitLockRepository from "../repositories/transaction-limit-lock.repository";
import yellowCardService from "./yellowcard.service";
import fincraService from "./fincra.service";
import platformSettingsService from "./platform-settings.service";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { TRANSACTION_STATUS } from "../common/constant";
import { LIMIT_DAY_UTC_OFFSET_HOURS, TIER_NAME, USER_TIER, UserTier, isUserTier } from "../common/tier.constants";
import { IDENTITY_REQUIRED_CODE } from "../common/identity.constants";
import logger from "../utils/logger.utils";

/** YellowCard per-USD rates (only for currencies other than NGN/GHS) are cached briefly */
const RATE_CACHE_MS = 10 * 60 * 1000;

/** How long a lock may be held (creation calls payment providers) and how long a second request waits */
const LOCK_TTL_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 20 * 1000;
const LOCK_POLL_MS = 150;

/** Statuses that no longer count towards the daily limit */
const RELEASED_STATUSES = [TRANSACTION_STATUS.FAILED, TRANSACTION_STATUS.CANCELLED] as ("failed" | "cancelled")[];

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
    /** In NGN; null = unlimited */
    limitNgn: number | null;
    usedNgn: number;
    /** null = unlimited */
    remainingNgn: number | null;
    /** When today's usage resets (midnight Lagos time) */
    resetsAt: string;
    /** The next tier up, if any */
    nextTier: { tier: UserTier; name: string; limitNgn: number | null } | null;
}

export interface TierLimitCheck extends TierLimitStatus {
    /** null when the amount couldn't be valued in NGN */
    ngnValue: number | null;
    allowed: boolean;
    reason?: "limit_exceeded" | "unvalued" | "identity_required";
}

let rateCache: { at: number; unitsPerUsd: Map<string, number> } | null = null;

const roundNgn = (value: number) => Math.round(value * 100) / 100;
const formatNgn = (value: number) => `₦${Math.floor(value).toLocaleString("en-NG")}`;

/**
 * Daily transaction limits per account tier, in NGN.
 *
 * Every send and receive is valued in NGN when it's created and stored on the
 * transaction (`ngnValue`); a user's usage is the sum for the current day
 * (midnight to midnight, Lagos time), excluding failed and cancelled ones.
 * NGN counts as is and GHS at Fincra's rate; other currencies (not offered
 * at the moment) go through YellowCard's USD rates. Unverified accounts can't
 * transact until they verify their BVN, and Tier 3 is unlimited. If a
 * transaction can't be valued for a limited tier, it's refused: the limit
 * fails closed.
 */
class TransactionLimitService {
    /** Start of the current limit day */
    private dayStart(now = Date.now()): Date {
        return new Date(Math.floor((now + OFFSET_MS) / DAY_MS) * DAY_MS - OFFSET_MS);
    }

    /** Units of each currency per 1 USD (YellowCard) */
    private async unitsPerUsd(): Promise<Map<string, number>> {
        if (rateCache && Date.now() - rateCache.at < RATE_CACHE_MS) return rateCache.unitsPerUsd;

        const data = await yellowCardService.getRates();
        const rates = data?.rates || (Array.isArray(data) ? data : []);
        const unitsPerUsd = new Map<string, number>();
        for (const rate of rates) {
            const code = String(rate.code || rate.currency || rate.currencyCode || "").toUpperCase();
            const quote = Math.min(...[Number(rate.buy), Number(rate.sell)].filter((n) => isFinite(n) && n > 0));
            if (code && isFinite(quote)) unitsPerUsd.set(code, quote);
        }
        rateCache = { at: Date.now(), unitsPerUsd };
        return unitsPerUsd;
    }

    /** NGN value of an amount, or null if the currency can't be valued */
    async toNgn(amount: number, currency: string): Promise<number | null> {
        const code = currency.toUpperCase();
        if (code === "NGN") return amount;
        try {
            // Fincra's NGN cost of buying GHS: the higher of its two rates, so amounts count fully
            if (code === "GHS") return amount * (await fincraService.ngnPerGhs("send"));
            const rates = await this.unitsPerUsd();
            const ngnPerUsd = rates.get("NGN");
            if (!ngnPerUsd) return null;
            if (code === "USD" || code === "USDT" || code === "USDC") return amount * ngnPerUsd;
            const unitsPerUsd = rates.get(code);
            return unitsPerUsd ? (amount / unitsPerUsd) * ngnPerUsd : null;
        } catch (error: any) {
            logger.warn("Transaction limit: could not value amount in NGN", { currency: code, error: error?.message });
            return null;
        }
    }

    /** Values the first amount that can be converted (the NGN side when there is one) */
    async valueInNgn(amounts: AmountInCurrency[]): Promise<number | null> {
        const ordered = [...amounts].sort((a, b) => Number(String(b.currency).toUpperCase() === "NGN") - Number(String(a.currency).toUpperCase() === "NGN"));
        for (const { amount, currency } of ordered) {
            if (!amount || amount <= 0 || !currency) continue;
            const ngn = await this.toNgn(amount, currency);
            if (ngn !== null) return roundNgn(ngn);
        }
        return null;
    }

    private async getTier(userId: string): Promise<UserTier> {
        const user = await userRepository.findById(userId);
        if (!user) throw errorResponseMessage.resourceNotFound("User");
        return isUserTier(user.tier) ? user.tier : USER_TIER.UNVERIFIED;
    }

    /** NGN already used today */
    async getUsedTodayNgn(userId: string): Promise<number> {
        const transactions = await transactionRepository.listForLimit(userId, this.dayStart(), RELEASED_STATUSES);

        let used = 0;
        for (const transaction of transactions) {
            if (typeof transaction.ngnValue === "number") {
                used += transaction.ngnValue;
            } else if (transaction.amount && transaction.currency) {
                used += (await this.toNgn(transaction.amount, transaction.currency)) ?? 0;
            }
        }
        return roundNgn(used);
    }

    async getStatus(userId: string): Promise<TierLimitStatus> {
        const tier = await this.getTier(userId);
        const [limitNgn, usedNgn, allLimits] = await Promise.all([
            platformSettingsService.getTierDailyLimitNgn(tier),
            this.getUsedTodayNgn(userId),
            platformSettingsService.getTierDailyLimits(),
        ]);
        const next = (tier + 1) as UserTier;
        return {
            tier,
            tierName: TIER_NAME[tier],
            limitNgn,
            usedNgn,
            remainingNgn: limitNgn === null ? null : roundNgn(Math.max(0, limitNgn - usedNgn)),
            resetsAt: new Date(this.dayStart().getTime() + DAY_MS).toISOString(),
            nextTier: isUserTier(next) ? { tier: next, name: TIER_NAME[next], limitNgn: allLimits[next] } : null,
        };
    }

    async check(userId: string, amounts: AmountInCurrency[]): Promise<TierLimitCheck> {
        const [status, ngnValue] = await Promise.all([this.getStatus(userId), this.valueInNgn(amounts)]);
        if (status.tier < USER_TIER.INDIVIDUAL) return { ...status, ngnValue, allowed: false, reason: "identity_required" };
        if (status.limitNgn === null) return { ...status, ngnValue, allowed: true };
        if (ngnValue === null) return { ...status, ngnValue, allowed: false, reason: "unvalued" };
        // A kobo of tolerance for rounding
        const allowed = status.usedNgn + ngnValue <= status.limitNgn + 0.01;
        return { ...status, ngnValue, allowed, ...(allowed ? {} : { reason: "limit_exceeded" as const }) };
    }

    /**
     * Throws a 403 TIER_LIMIT_EXCEEDED error when this transaction would take the
     * user over today's limit. Returns the NGN value to store on the transaction.
     * Call inside `withUserLock` so parallel requests can't both pass.
     */
    async assertAllowed(userId: string, amounts: AmountInCurrency[]): Promise<{ ngnValue: number | null }> {
        await this.assertCanTransact(userId);
        const result = await this.check(userId, amounts);
        if (result.allowed) return { ngnValue: result.ngnValue };

        const details = {
            code: TIER_LIMIT_CODE,
            reason: result.reason,
            tier: result.tier,
            limitNgn: result.limitNgn,
            usedNgn: result.usedNgn,
            remainingNgn: result.remainingNgn,
            ngnValue: result.ngnValue,
            resetsAt: result.resetsAt,
        };
        const message = result.reason === "unvalued"
            ? "We couldn't confirm this transaction's value against your daily limit right now. Please try again shortly."
            : `This transaction (about ${formatNgn(result.ngnValue!)}) is over your Tier ${result.tier} daily limit of ${formatNgn(result.limitNgn!)}. `
                + (result.remainingNgn! > 0 ? `You have ${formatNgn(result.remainingNgn!)} left today. ` : "You've used today's limit. ")
                + "Upgrade your tier to transact more.";
        throw errorResponseMessage.createError(403, message, ErrorSeverity.LOW, details);
    }

    /**
     * Throws a 403 IDENTITY_REQUIRED error for accounts that haven't verified
     * their BVN yet; every send, receive and exchange calls this first.
     */
    async assertCanTransact(userId: string): Promise<void> {
        if ((await this.getTier(userId)) >= USER_TIER.INDIVIDUAL) return;
        throw errorResponseMessage.createError(
            403,
            "Verify your identity to start sending and receiving money. It takes about 2 minutes.",
            ErrorSeverity.LOW,
            { code: IDENTITY_REQUIRED_CODE }
        );
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
            await transactionLimitLockRepository.release(key, token).catch((error) =>
                logger.warn("Transaction limit: failed to release lock", { userId: key, error: error?.message }));
        }
    }

    /** Takes the lock if it's free or its holder's time ran out (one atomic upsert) */
    private async tryLock(key: string, token: string): Promise<boolean> {
        return transactionLimitLockRepository.tryAcquire(key, token, LOCK_TTL_MS);
    }
}

export default new TransactionLimitService();
