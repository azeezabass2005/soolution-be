/**
 * Our payment and verification partners are never named to customers. This
 * matches any of their names (and YellowCard's collection-account name and
 * the networks it reports) so a message can be checked before it leaves.
 */
export const PROVIDER_NAME_PATTERN = /yellow[\s_-]*card|yellow[\s_-]*pay|o[\s_-]*gateway|paystack|smile[\s_-]*id(entity)?|sasapay|fincra|spot[\s_-]*flow|\bdaya\b/i;

export const mentionsProvider = (text: unknown): boolean =>
    typeof text === "string" && PROVIDER_NAME_PATTERN.test(text);

/** `text`, or `fallback` when it names a provider */
export const withoutProviderName = (text: string | undefined | null, fallback: string): string =>
    !text || mentionsProvider(text) ? fallback : text;

/**
 * Text for a customer, with any partner name replaced ("rate from
 * YellowCard" → "rate from our partner"). For messages built from provider
 * replies, where rewriting the whole message would lose what happened.
 */
export const scrubProviderNames = (text: string): string =>
    typeof text === "string" ? text.replace(new RegExp(PROVIDER_NAME_PATTERN.source, "gi"), "our partner") : text;

/** The same for every text field of a notification (title, message, notes) */
export const scrubNotification = <T extends Record<string, any>>(config: T): T => {
    const out: Record<string, any> = { ...config };
    for (const key of ["title", "message", "additionalInfo", "preheader", "eyebrow"]) {
        if (typeof out[key] === "string") out[key] = scrubProviderNames(out[key]);
    }
    return out as T;
};
