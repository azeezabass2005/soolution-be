/**
 * Payment links: the user shares a link, the payer opens it (no account
 * needed), fills in how they'll pay, and that starts a collection that
 * credits the user's NGN wallet.
 */

/** Currencies a payer can pay a link in. GHS goes through Fincra's checkout, the rest through YellowCard. */
export const PAYMENT_LINK_CURRENCIES = ["GHS", "KES", "XAF", "ZAR", "TZS", "UGX", "XOF", "RWF", "BWP", "ZMW", "MWK", "CDF"] as const;
export type PaymentLinkCurrency = (typeof PAYMENT_LINK_CURRENCIES)[number];

/** Single-use links stop after one completed payment; reusable ones keep going until turned off */
export const PAYMENT_LINK_USAGE = { SINGLE: "single", REUSABLE: "reusable" } as const;
export type PaymentLinkUsage = (typeof PAYMENT_LINK_USAGE)[keyof typeof PAYMENT_LINK_USAGE];

/** Details the link's owner can ask the payer for */
export const PAYMENT_LINK_COLLECT_FIELDS = ["name", "email", "phone"] as const;
export const PAYMENT_LINK_REDIRECT_MAX = 500;

/** Links always credit the owner's NGN wallet */
export const PAYMENT_LINK_TO_CURRENCY = "NGN";

/** Payers in these currencies can only pay by mobile money (used only when YellowCard cannot be asked) */
export const PAYMENT_LINK_MOMO_ONLY = ["GHS"];

/**
 * Currencies YellowCard sends to and collects in for our users. Sends are paid
 * from the NGN wallet and receipts credit it in naira (no wallet in these
 * currencies). Each is offered only while YellowCard has that direction on.
 */
export const YELLOWCARD_FLOW_CURRENCIES = ["KES", "XAF", "ZAR", "TZS", "UGX", "XOF", "RWF", "BWP", "ZMW", "MWK", "CDF"] as const;

export const CURRENCY_COUNTRY: Record<string, string> = {
    NGN: "NG", GHS: "GH", KES: "KE", XAF: "CM", ZAR: "ZA", TZS: "TZ", UGX: "UG",
    XOF: "SN", RWF: "RW", BWP: "BW", ZMW: "ZM", MWK: "MW", CDF: "CD",
};

export const COUNTRY_DIAL_CODE: Record<string, string> = {
    NG: "+234", GH: "+233", KE: "+254", CM: "+237", ZA: "+27", TZ: "+255", UG: "+256",
    SN: "+221", RW: "+250", BW: "+267", ZM: "+260", MW: "+265",
    CI: "+225", BJ: "+229", ML: "+223", BF: "+226", TG: "+228", GA: "+241", CG: "+242", CD: "+243",
};

/**
 * The CFA francs are shared by several countries, each its own YellowCard
 * market. The first one is the default (CURRENCY_COUNTRY); the rest are
 * offered wherever YellowCard has them on.
 */
export const MULTI_COUNTRY_CURRENCIES: Record<string, string[]> = {
    XOF: ["SN", "CI", "BJ", "ML", "BF", "TG"],
    XAF: ["CM", "GA", "CG"],
};

/** The YellowCard country for a currency: the one asked for when the currency is used there, else its default */
export const ycCountryFor = (currency: string, country?: string | null): string => {
    const cur = String(currency || "").toUpperCase();
    const asked = String(country || "").toUpperCase();
    if (asked && (MULTI_COUNTRY_CURRENCIES[cur] ?? [CURRENCY_COUNTRY[cur]]).includes(asked)) return asked;
    return CURRENCY_COUNTRY[cur];
};

/** Characters in a link's public id (base62, ~71 bits) */
export const PAYMENT_LINK_SLUG_LENGTH = 12;

/** Active links a user can hold at once */
export const MAX_ACTIVE_PAYMENT_LINKS = 50;

/**
 * Payments on one link that can be waiting at the same time. Each pending
 * payment counts towards the owner's daily limit, so this stops a stranger
 * with the link from using the limit up.
 */
export const MAX_PENDING_PAYMENTS_PER_LINK = 3;

/** Pending payments older than this no longer count towards the cap above */
export const PENDING_PAYMENT_WINDOW_MS = 30 * 60 * 1000;

export const PAYMENT_LINK_DESCRIPTION_MAX = 140;
export const PAYMENT_LINK_TITLE_MAX = 80;
