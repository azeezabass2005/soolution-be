import type { PricingConfig } from "../common/pricing";
import type { IdentityAddressParts, IdentityProofOfAddress } from "../common/identity.constants";
import type {
    accounts,
    auditLogs,
    bankAccountDetails,
    beneficiaries,
    exchangeRates,
    fxQuotes,
    idempotencyKeys,
    journalEntries,
    kycApplications,
    ledgerAlerts,
    partners,
    paymentLinks,
    posts,
    reconciliationReports,
    refreshTokens,
    tags,
    transactionDetails,
    transactions,
    users,
    userTierHistory,
    verifications,
    walletTransactions,
    wallets,
    webhookEvents,
} from "../db/schema";
import type { IdentityStatus } from "../common/identity.constants";

/**
 * Domain entities returned by the repositories.
 *
 * Columns that are NULL in Postgres come back as `undefined` (the field is
 * left off), the way Mongo omitted unset fields, so `field !== undefined`
 * checks and the JSON the frontend receives behave as before.
 */
type NullableKeys<T> = { [K in keyof T]-?: null extends T[K] ? K : never }[keyof T];
export type NullToOptional<T> = { [K in Exclude<keyof T, NullableKeys<T>>]: T[K] } & {
    [K in NullableKeys<T>]?: Exclude<T[K], null>;
};

// ───────────── Users ─────────────

type UserRow = typeof users.$inferSelect;
type IdentityColumn = Extract<keyof UserRow, `identity${string}`>;

export interface UserIdentity {
    status: IdentityStatus;
    /** Secret: only present when loaded with `withSecrets` */
    bvnHash?: string;
    bvnLast4?: string;
    /** Secret: encrypted BVN */
    bvnEnc?: string;
    /** Secret: encrypted NIN */
    ninEnc?: string;
    /** Secret */
    ninHash?: string;
    ninLast4?: string;
    /** YYYY-MM-DD */
    dob?: string;
    /** Phone on the BVN record */
    idPhone?: string;
    address?: string;
    /** The address as typed: street, city, state, LGA (Nigeria) and country */
    addressParts?: IdentityAddressParts;
    /** The proof-of-address file the user uploaded */
    proofOfAddress?: IdentityProofOfAddress;
    detailsUpdatedAt?: Date;
    verifiedName?: string;
    verifiedAt?: Date;
    method?: string;
    failureReason?: string;
}

export type User = NullToOptional<Omit<UserRow, IdentityColumn | "password" | "transactionPinHash">> & {
    identity: UserIdentity;
    /** Only present when loaded with secrets (login / password checks) */
    password?: string;
    /** Only present when loaded with secrets (PIN checks) */
    transactionPinHash?: string;
    /** PIN is locked after too many wrong attempts */
    isTransactionPinLocked: boolean;
};

/** What other records embed when they "populate" a user: never secrets */
export type PublicUser = Pick<
    User,
    | "id" | "email" | "firstName" | "lastName" | "phoneNumber" | "whatsappNumber" | "role" | "status" | "tier"
    | "isVerified" | "isKYCDone" | "isKYCRejected" | "countryOfOrigin" | "countryOfResidence" | "createdAt" | "updatedAt"
>;

export type UserTierHistoryEntry = NullToOptional<typeof userTierHistory.$inferSelect>;
export type RefreshToken = NullToOptional<typeof refreshTokens.$inferSelect>;

// ───────────── Content ─────────────

export type Tag = NullToOptional<typeof tags.$inferSelect>;
export type Post = NullToOptional<typeof posts.$inferSelect>;
export type Partner = NullToOptional<typeof partners.$inferSelect>;

// ───────────── Transactions ─────────────

type TransactionRow = typeof transactions.$inferSelect;
export type Transaction = NullToOptional<Omit<TransactionRow, "payerName" | "payerEmail" | "payerPhone">> & {
    /** Who paid through the payment link, as they entered it */
    payer?: { name?: string; email?: string; phone?: string };
};
export type TransactionDetail = NullToOptional<typeof transactionDetails.$inferSelect>;

/**
 * A transaction as the API returns it: `user` is the owner's public profile
 * (what Mongoose's populate("user") produced) and `details` its detail row.
 */
export type TransactionView = Omit<Transaction, "user"> & { user: PublicUser | string; details?: TransactionDetail };

export type PaymentLink = NullToOptional<typeof paymentLinks.$inferSelect>;
export type IdempotencyKey = NullToOptional<typeof idempotencyKeys.$inferSelect>;
export type AuditLog = NullToOptional<typeof auditLogs.$inferSelect>;

// ───────────── Wallets ─────────────

export type Wallet = NullToOptional<typeof wallets.$inferSelect>;
export type WalletTransaction = NullToOptional<typeof walletTransactions.$inferSelect>;
export type FxQuote = NullToOptional<typeof fxQuotes.$inferSelect>;

// ───────────── Ledger ─────────────

export type Account = NullToOptional<typeof accounts.$inferSelect>;

type JournalRow = typeof journalEntries.$inferSelect;
export type JournalEntry = NullToOptional<Omit<JournalRow, "externalRefProvider" | "externalRefId">> & {
    externalRef?: { provider: string; id: string };
};

export type WebhookEvent = NullToOptional<typeof webhookEvents.$inferSelect>;
export type ReconciliationReport = NullToOptional<typeof reconciliationReports.$inferSelect>;
export type LedgerAlert = NullToOptional<typeof ledgerAlerts.$inferSelect>;

// ───────────── Accounts, KYC, misc ─────────────

export type ExchangeRate = NullToOptional<typeof exchangeRates.$inferSelect>;

export interface PlatformSettings {
    id: string;
    kind: "singleton";
    /** Daily transaction limits in NGN per tier (Tier 3 is unlimited) */
    tierDailyLimitNgn: { tier1: number; tier2: number };
    /** % the platform adds on top of the provider's FX rate */
    rateMarkupPercent: number;
    /** % the platform charges on top of the provider's base fee */
    additionalFeePercent: number;
    /** The rails' own fees; editable to track provider changes */
    providerBaseFeePercent: { ogateway: number; yellowcard: number; fincra: number };
    /** Stored pricing (partial); read it through platformSettingsService.getPricing() */
    pricing?: Partial<PricingConfig>;
    updatedBy?: string;
    createdAt: Date;
    updatedAt: Date;
}

export type BankAccountDetails = NullToOptional<typeof bankAccountDetails.$inferSelect>;
export type Verification = NullToOptional<typeof verifications.$inferSelect>;
export type KycApplication = NullToOptional<typeof kycApplications.$inferSelect>;
export type Beneficiary = NullToOptional<typeof beneficiaries.$inferSelect>;

export type { KycDocument, KycReviewEvent } from "../db/schema";
