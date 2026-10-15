/**
 * Saved recipients for sends. A beneficiary holds the destination details for
 * one currency, so the send form only needs an amount and a pick.
 */
export const BENEFICIARY_KIND = {
    BANK: "bank",
    MOMO: "momo",
    ALIPAY: "alipay",
    WECHAT: "wechat",
} as const;

export type BeneficiaryKind = (typeof BENEFICIARY_KIND)[keyof typeof BENEFICIARY_KIND];

/** RMB goes to Alipay / WeChat; every other currency to a bank or mobile money wallet */
export const RMB_KINDS: BeneficiaryKind[] = [BENEFICIARY_KIND.ALIPAY, BENEFICIARY_KIND.WECHAT];
export const PAYOUT_KINDS: BeneficiaryKind[] = [BENEFICIARY_KIND.BANK, BENEFICIARY_KIND.MOMO];

/** Currencies users can send to */
export const BENEFICIARY_CURRENCIES = [
    "RMB", "NGN", "GHS", "KES", "XAF", "XOF", "ZAR", "TZS", "UGX", "RWF", "BWP", "ZMW", "MWK", "ETB", "CDF", "SLL",
] as const;

/** Currencies that only pay out to mobile money */
export const MOMO_ONLY_CURRENCIES = ["XAF", "RWF", "SLL", "MWK"];

export const ALIPAY_TYPES = ["nigerian", "chinese"] as const;

/** Keeps the picker usable and stops a runaway client filling the collection */
export const MAX_BENEFICIARIES_PER_USER = 100;
