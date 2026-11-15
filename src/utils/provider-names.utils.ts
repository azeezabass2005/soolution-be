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
