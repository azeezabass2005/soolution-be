/**
 * Wallet system limits and configuration
 */
export const WALLET_LIMITS = {
    /** Minimum withdrawal amount in NGN (₦1,000) */
    MIN_WITHDRAWAL: 1000,

    /** Maximum single withdrawal amount in NGN (₦5,000,000) */
    MAX_WITHDRAWAL: 5_000_000,

    /** Maximum total withdrawals per day in NGN (₦10,000,000) */
    DAILY_WITHDRAWAL_LIMIT: 10_000_000,

    /** Number of wrong PIN attempts before lockout */
    MAX_PIN_ATTEMPTS: 5,

    /** PIN lockout duration in minutes */
    PIN_LOCKOUT_MINUTES: 30,

    /** PIN length (digits) */
    PIN_LENGTH: 4,

    /** Wallet currency */
    CURRENCY: 'NGN' as const,
};
