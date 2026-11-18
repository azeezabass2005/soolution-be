/**
 * Ghana's universal banks (Bank of Ghana list), offered when the payout
 * provider's own list can't be loaded so the bank is still picked, not typed.
 * The code is the name: at payout time it's matched to the provider's list.
 */
export const GHANA_BANKS: string[] = [
    "Absa Bank Ghana",
    "Access Bank Ghana",
    "Agricultural Development Bank",
    "ARB Apex Bank",
    "Bank of Africa Ghana",
    "CalBank",
    "Consolidated Bank Ghana",
    "Ecobank Ghana",
    "FBNBank Ghana",
    "Fidelity Bank Ghana",
    "First Atlantic Bank",
    "First National Bank Ghana",
    "GCB Bank",
    "Guaranty Trust Bank Ghana",
    "National Investment Bank",
    "OmniBSIC Bank",
    "Prudential Bank",
    "Republic Bank Ghana",
    "Societe Generale Ghana",
    "Stanbic Bank Ghana",
    "Standard Chartered Bank Ghana",
    "United Bank for Africa Ghana",
    "Universal Merchant Bank",
    "Zenith Bank Ghana",
];

const NOISE = /\b(ghana|gh|limited|ltd|plc|bank|company|co)\b|[^a-z0-9 ]/g;

/** "GCB Bank Limited" and "GCB BANK" compare equal */
export const bankNameKey = (name: string) =>
    String(name || "").toLowerCase().replace(/&/g, " and ").replace(NOISE, " ").replace(/\s+/g, " ").trim();

/** Common short names people and providers use */
const ALIASES: Record<string, string> = {
    adb: "agricultural development",
    nib: "national investment",
    umb: "universal merchant",
    uba: "united for africa",
    gtbank: "guaranty trust",
    "gt": "guaranty trust",
    cbg: "consolidated",
    sg: "societe generale",
    fnb: "first national",
    boa: "of africa",
};

/** The key with well-known abbreviations spelled out */
export const canonicalBankKey = (name: string) => {
    const key = bankNameKey(name);
    return ALIASES[key] ?? key;
};
