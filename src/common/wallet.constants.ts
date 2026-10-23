/** Funding (Paystack) and withdrawals happen in this wallet; every other wallet is filled by exchange */
export const BASE_WALLET_CURRENCY = "NGN" as const;

/** Currencies a user can hold a wallet in: the ones we can pay out */
export const WALLET_CURRENCIES = [
    "NGN", "RMB", "GHS", "KES", "XAF", "ZAR", "TZS", "UGX", "XOF", "RWF", "BWP", "ZMW", "MWK",
] as const;
export type WalletCurrency = (typeof WALLET_CURRENCIES)[number];

export const isWalletCurrency = (value: unknown): value is WalletCurrency =>
    typeof value === "string" && (WALLET_CURRENCIES as readonly string[]).includes(value);

/** Manual (ops-paid) sends that can be paid from the matching wallet */
export const MANUAL_PAYOUT_CURRENCIES = ["RMB", "GHS", "KES", "XAF"] as const;

/** How long an exchange quote can be accepted */
export const FX_QUOTE_TTL_MS = 60 * 1000;

/**
 * Net position per currency: what users exchanged into (or out of) that
 * currency. A credit balance on the NGN side is naira taken in exchange; a
 * debit balance on e.g. GHS is cedis owed to users that treasury still has to
 * source. Sends from a currency wallet close the position.
 */
export const fxPositionCode = (currency: string): string => `FX_POSITION_${currency}`;

/** Wallet money committed to a manual payout that ops hasn't paid yet */
export const manualPayoutPendingCode = (currency: string): string => `MANUAL_PAYOUT_PENDING_${currency}`;
