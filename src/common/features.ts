/**
 * User-facing features an admin can turn on for everyone, keep to beta
 * users, or turn off. The routes listed are refused (for non-admins) when the
 * feature isn't on for that user; reads stay open so history keeps working.
 */
export type FeatureMode = "on" | "beta" | "off";
export const FEATURE_MODES: FeatureMode[] = ["on", "beta", "off"];

export interface FeatureDef {
    key: string;
    label: string;
    description: string;
    routes: Array<{ method: string; path: RegExp }>;
}

export const FEATURES: FeatureDef[] = [
    {
        key: "payment_links",
        label: "Payment links",
        description: "Creating a link a payer opens to pay the user.",
        routes: [{ method: "POST", path: /^\/payment-links\/?$/ }],
    },
    {
        key: "african_sends",
        label: "Sends to other African currencies",
        description: "Paying out in KES, ZAR, XOF and the other YellowCard currencies.",
        routes: [{ method: "POST", path: /^\/yellowcard\/?$/ }],
    },
    {
        key: "african_receives",
        label: "Receiving other African currencies",
        description: "Collecting KES, ZAR, XOF and the other YellowCard currencies into the naira wallet.",
        routes: [{ method: "POST", path: /^\/yellowcard\/collect\/?$/ }],
    },
    {
        key: "wallet_exchange",
        label: "Wallet exchange",
        description: "Converting between the user's own wallets.",
        routes: [{ method: "POST", path: /^\/wallet\/exchange(\/quote)?\/?$/ }],
    },
    {
        key: "marketplace",
        label: "Marketplace",
        description: "The Marketplace page in the user's menu.",
        routes: [],
    },
];

export const FEATURE_KEYS = FEATURES.map((f) => f.key);

/** The feature a request belongs to, if any */
export const featureOfRoute = (method: string, path: string): FeatureDef | undefined =>
    FEATURES.find((f) => f.routes.some((r) => r.method === method && r.path.test(path)));
