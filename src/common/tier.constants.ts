/**
 * Account tiers. Every user starts Unverified (no transactions); verifying
 * their BVN moves them to Tier 1, and they can apply for higher tiers.
 * Each tier has a daily transaction limit in USD.
 * Limits are admin-editable in platform settings; these are the defaults.
 */

export const USER_TIER = {
    UNVERIFIED: 0,
    INDIVIDUAL: 1,
    BUSINESS: 2,
    INSTITUTION: 3,
} as const;

export type UserTier = (typeof USER_TIER)[keyof typeof USER_TIER];

export const USER_TIERS: UserTier[] = [USER_TIER.UNVERIFIED, USER_TIER.INDIVIDUAL, USER_TIER.BUSINESS, USER_TIER.INSTITUTION];

/** Tiers a user can apply for (Tier 1 needs no application) */
export const UPGRADE_TIERS: UserTier[] = [USER_TIER.BUSINESS, USER_TIER.INSTITUTION];

export const TIER_NAME: Record<UserTier, string> = {
    0: "Unverified",
    1: "Individual",
    2: "Business",
    3: "Institution",
};

/** Default daily limits in USD; Unverified accounts can't transact and Tier 3 is unlimited */
export const DEFAULT_TIER_DAILY_LIMIT_USD = {
    tier1: 2_000,
    tier2: 100_000,
};

/**
 * The daily limit resets at midnight Lagos time (WAT, UTC+1, no daylight saving)
 */
export const LIMIT_DAY_UTC_OFFSET_HOURS = 1;

export const isUserTier = (value: unknown): value is UserTier => USER_TIERS.includes(value as UserTier);
