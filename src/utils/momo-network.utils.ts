/**
 * Picks the YellowCard network that matches the provider the user chose
 * (e.g. "Mpesa" → YellowCard's "M-PESA" network) instead of whichever
 * active network the API lists first.
 */

/** Words a provider is known by, keyed by the values the forms send */
const PROVIDER_ALIASES: Record<string, string[]> = {
    "mpesa": ["mpesa", "safaricom"],
    "airtel kenya": ["airtel"],
    "telkom kenya": ["telkom"],
    "mtn momo": ["mtn"],
    "telecel (vodafone)": ["telecel", "vodafone"],
    "airteltigo": ["airteltigo", "tigo", "airtel"],
    "orange money": ["orange"],
    "wave": ["wave"],
    "airtel uganda": ["airtel"],
    "vodacom": ["vodacom", "mpesa"],
    "tigo": ["tigo", "mixx", "yas"],
    "airtel tanzania": ["airtel"],
    "airtel rwanda": ["airtel"],
    "fnb": ["fnb"],
    "airtel zambia": ["airtel"],
    "airtel congo": ["airtel"],
    "airtel malawi": ["airtel"],
    "tnm mpamba": ["tnm", "mpamba"],
    "africell": ["africell"],
    "telebirr": ["telebirr", "ethio"],
    "mascom myzaka": ["mascom", "myzaka"],
};

const squash = (value: unknown) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const aliasesFor = (provider: string) => {
    const known = PROVIDER_ALIASES[provider.trim().toLowerCase()];
    return (known || [provider]).map(squash).filter(Boolean);
};

const isType = (network: any, accountType: string) => {
    const kind = String(network?.accountNumberType || network?.type || "").toLowerCase();
    if (!kind) return true;
    if (accountType === "bank") return kind === "bank";
    return kind === "phone" || kind === "momo" || kind === "mobile";
};

/**
 * Best active network for this account type and provider. Falls back to the
 * first active network of the right type, then to the first active network,
 * so an unknown provider never blocks a payment that worked before.
 */
export const pickYellowCardNetwork = (
    networks: any[],
    options: { accountType: string; provider?: string },
): any | undefined => {
    const active = (networks || []).filter((n) => n?.status === "active");
    const ofType = active.filter((n) => isType(n, options.accountType));

    // A bank picked from our list sends YellowCard's network id itself
    const byId = options.provider ? active.find((n) => String(n.id) === options.provider) : undefined;
    if (byId) return byId;

    if (options.provider) {
        const aliases = aliasesFor(options.provider);
        const named = (n: any) => {
            const name = squash(n?.name) + "|" + squash(n?.code);
            return aliases.some((alias) => name.includes(alias));
        };
        const match = ofType.find(named) || active.find(named);
        if (match) return match;
    }
    return ofType[0] || active[0];
};
