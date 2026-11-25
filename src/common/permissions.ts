/**
 * What an admin can see and do. A super admin (an ADMIN account with no
 * staff role) has everything. Staff have an admin role, and the role lists
 * the permissions they get; anything not listed is hidden from them in the
 * app AND refused by the server.
 *
 * `superAdminOnly` permissions can't be put in a role: only super admins
 * have them. Everything the super admin hasn't singled out (Technical,
 * Marketplace, roles and staff) is super admin only.
 *
 * Keep in step with the frontend copy in soolution-fe/src/shared/constants/permissions.ts.
 */
export interface PermissionInfo {
    key: string;
    label: string;
    /** Where it's listed in the role editor */
    group: string;
    description: string;
    superAdminOnly?: boolean;
}

export const PERMISSIONS = [
    // Dashboard
    { key: "dashboard", group: "Dashboard", label: "Dashboard", description: "The admin home page and its counts." },
    { key: "dashboard.platform_controls", group: "Dashboard", label: "Platform controls on the dashboard", description: "The pause switches shown on the dashboard." },
    { key: "dashboard.volume", group: "Dashboard", label: "Stats cards: transaction volume", description: "Amounts transacted, funded, sent and received." },

    // Transactions
    { key: "transactions", group: "Transactions", label: "Transaction history", description: "Every transaction and deposit; confirming or rejecting manual payments." },
    { key: "transactions.disputes", group: "Transactions", label: "Disputes", description: "Disputes users raise on their transactions." },

    // Single units, super admin only
    { key: "platform_controls", group: "Platform controls", label: "Platform controls", description: "The platform controls page.", superAdminOnly: true },
    { key: "profit_balances", group: "Profit & balances", label: "Profit & balances", description: "Profit, provider balances and our books.", superAdminOnly: true },

    // User management
    { key: "users.stats", group: "User management", label: "Stats cards: held in naira wallets", description: "How much users hold in their naira wallets." },
    { key: "users.directory", group: "User management", label: "Directory", description: "The list of users, and opening a user." },
    { key: "users.cards", group: "User management · inside a user", label: "Cards", description: "A user's funded, received, sent and withdrawn totals." },
    { key: "users.account_controls", group: "User management · inside a user", label: "Account controls", description: "Suspend, freeze and unfreeze." },
    { key: "users.balances", group: "User management · inside a user", label: "Balances", description: "A user's wallet balances." },
    { key: "users.repeat_signups", group: "User management · inside a user", label: "Repeat sign-ups", description: "Other accounts with the same phone or name and date of birth." },
    { key: "users.wallet_activity", group: "User management · inside a user", label: "Wallet activity", description: "Deposits, withdrawals and other wallet entries." },
    { key: "users.identity", group: "User management · inside a user", label: "Identity verification", description: "BVN/NIN details, and resetting a verification. Also hides them inside KYC." },
    { key: "users.daily_limit", group: "User management · inside a user", label: "Daily limit", description: "A user's own daily limit." },
    { key: "users.transactions", group: "User management · inside a user", label: "Transactions", description: "A user's transactions." },
    { key: "users.payment_links", group: "User management · inside a user", label: "Payment links", description: "The payment links a user has made, and what they've collected." },
    { key: "kyc", group: "User management", label: "KYC / KYB", description: "Reviewing KYC and KYB applications, and tier changes." },
    { key: "kyc.company", group: "User management", label: "Company information and all documents", description: "Business details and the documents uploaded with KYB." },

    // Pricing
    { key: "pricing.api_currencies", group: "Pricing", label: "API currencies", description: "Rates, buffers, fees and limits for every currency." },
    { key: "pricing.manual_payments", group: "Pricing", label: "Manual payments", description: "Manual payment hours and rates." },
    { key: "pricing.daily_limits", group: "Pricing", label: "Daily limits", description: "Daily limits per tier." },

    // Others
    { key: "support", group: "Support", label: "Support channel", description: "Answering users' support conversations." },
    { key: "labs", group: "Labs", label: "Labs", description: "The provider test pages (Fincra, Spotflow, HyperRails)." },

    // Not singled out: super admin only
    { key: "technical", group: "Technical", label: "Technical", description: "Reconciliation, ledger, webhooks, suspense and GHS conversions.", superAdminOnly: true },
    { key: "marketplace", group: "Marketplace", label: "Marketplace", description: "Marketplace administration.", superAdminOnly: true },
    { key: "roles", group: "Roles & staff", label: "Roles & staff", description: "Creating roles and adding or inviting staff.", superAdminOnly: true },
] as const satisfies readonly PermissionInfo[];

export type Permission = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_KEYS: Permission[] = PERMISSIONS.map((p) => p.key);

/** Permissions a role may include */
export const GRANTABLE_PERMISSIONS: Permission[] = PERMISSIONS.filter((p) => !("superAdminOnly" in p && p.superAdminOnly)).map((p) => p.key);

export const isPermission = (value: unknown): value is Permission => typeof value === "string" && (PERMISSION_KEYS as string[]).includes(value);

/** What a signed-in admin can do */
export interface AdminAccess {
    superAdmin: boolean;
    /** Everything they hold (all of them for a super admin) */
    permissions: Permission[];
    /** Their staff role, if they have one */
    role?: { id: string; name: string } | null;
}

export const NO_ACCESS: AdminAccess = { superAdmin: false, permissions: [], role: null };

export const hasPermission = (access: AdminAccess | null | undefined, permission: Permission) =>
    !!access && (access.superAdmin || access.permissions.includes(permission));
