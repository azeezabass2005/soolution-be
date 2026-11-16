import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, smallint, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { decimal, id, timestamps, timestamptz } from "../columns";
import { users } from "./users";
import type { UserTier } from "../../common/tier.constants";
import type { KycStatus, KycStep, KycType } from "../../common/kyc.constants";
import type { BeneficiaryKind, CurrencyCode, VerificationKind, VerificationStatus } from "../../types/enums";

/** Admin-managed rates: units of `to` per 1 `from` */
export const exchangeRates = pgTable(
    "exchange_rates",
    {
        id: id(),
        from: text("from_currency").$type<CurrencyCode>().notNull(),
        to: text("to_currency").$type<CurrencyCode>().notNull(),
        rate: decimal("rate").notNull(),
        isActive: boolean("is_active").notNull(),
        ...timestamps(),
    },
    (t) => [uniqueIndex("exchange_rates_pair_key").on(t.from, t.to)]
);

/** Universal pricing knobs; a single row (kind = 'singleton') */
export const platformSettings = pgTable(
    "platform_settings",
    {
        id: id(),
        kind: text("kind").$type<"singleton">().notNull().default("singleton").unique("platform_settings_kind_key"),
        rateMarkupPercent: decimal("rate_markup_percent").notNull().default(0),
        additionalFeePercent: decimal("additional_fee_percent").notNull().default(0),
        providerFeeOgatewayPercent: decimal("provider_fee_ogateway_percent").notNull().default(1.5),
        providerFeeYellowcardPercent: decimal("provider_fee_yellowcard_percent").notNull().default(0),
        tier1DailyLimitUsd: decimal("tier1_daily_limit_usd").notNull(),
        tier2DailyLimitUsd: decimal("tier2_daily_limit_usd").notNull(),
        updatedBy: uuid("updated_by"),
        ...timestamps(),
    },
    (t) => [
        check("platform_settings_kind_check", sql`${t.kind} = 'singleton'`),
        check("platform_settings_markup_check", sql`${t.rateMarkupPercent} between 0 and 50`),
        check("platform_settings_fee_check", sql`${t.additionalFeePercent} between 0 and 10`),
        check(
            "platform_settings_provider_fee_check",
            sql`${t.providerFeeOgatewayPercent} between 0 and 10 and ${t.providerFeeYellowcardPercent} between 0 and 10`
        ),
        check("platform_settings_limits_check", sql`${t.tier1DailyLimitUsd} >= 0 and ${t.tier2DailyLimitUsd} >= 0`),
    ]
);

/**
 * Two kinds of bank account that must never mix:
 *  - company accounts (user_id null): where customers pay us for manual transfers
 *  - a user's own saved accounts (user_id set)
 */
export const bankAccountDetails = pgTable(
    "bank_account_details",
    {
        id: id(),
        user: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
        currency: text("currency").notNull(),
        /** Text, so leading zeros survive */
        accountNumber: text("account_number").notNull(),
        accountName: text("account_name").notNull(),
        bankName: text("bank_name").notNull(),
        bankCode: text("bank_code"),
        isDefault: boolean("is_default").notNull().default(false),
        ...timestamps(),
    },
    (t) => [
        index("bank_account_details_user_idx").on(t.user),
        index("bank_account_details_currency_idx").on(t.currency),
        // At most one default company account per currency
        uniqueIndex("bank_account_details_company_default_key")
            .on(t.currency)
            .where(sql`${t.user} is null and ${t.isDefault}`),
        check("bank_account_details_currency_check", sql`${t.currency} ~ '^[A-Z]{3,4}$'`),
    ]
);

export const verifications = pgTable(
    "verifications",
    {
        id: id(),
        user: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        jobId: text("job_id"),
        status: text("status").$type<VerificationStatus>().notNull().default("pending"),
        reason: text("reason"),
        kind: text("kind").$type<VerificationKind>(),
        /** Keyed hash and last 4 of the BVN submitted (never the BVN itself) */
        idHash: text("id_hash"),
        idLast4: text("id_last4"),
        /** Encrypted BVN and NIN, held only until the check is decided */
        bvnEnc: text("bvn_enc"),
        ninEnc: text("nin_enc"),
        ninHash: text("nin_hash"),
        ninLast4: text("nin_last4"),
        smileJobId: text("smile_job_id"),
        resultCode: text("result_code"),
        resultText: text("result_text"),
        actions: jsonb("actions").$type<Record<string, unknown>>(),
        nameOnId: text("name_on_id"),
        resultSource: text("result_source").$type<"webhook" | "poll">(),
        completedAt: timestamptz("completed_at"),
        lastPolledAt: timestamptz("last_polled_at"),
        /** Set when an admin resets attempts, so the failure no longer counts */
        excludedFromAttempts: boolean("excluded_from_attempts").notNull().default(false),
        ...timestamps(),
    },
    (t) => [
        index("verifications_user_created_idx").on(t.user, t.createdAt),
        // At most one BVN check in flight per user
        uniqueIndex("verifications_pending_bvn_key").on(t.user).where(sql`${t.kind} = 'bvn' and ${t.status} = 'pending'`),
    ]
);

export interface KycDocument {
    slot: string;
    key: string;
    originalName: string;
    mimeType: string;
    size: number;
    issueDate?: Date | string;
    uploadedAt: Date | string;
}

export interface KycReviewEvent {
    status: KycStatus;
    note?: string;
    by?: string;
    at: Date | string;
}

export const kycApplications = pgTable(
    "kyc_applications",
    {
        id: id(),
        user: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        type: text("type").$type<KycType>().notNull(),
        /** Tier this application upgrades the user to */
        tier: smallint("tier").$type<UserTier>().notNull(),
        /** Earlier approved applications replaced by an upgrade of a different type */
        archive: jsonb("archive").$type<Record<string, any>[]>(),
        status: text("status").$type<KycStatus>().notNull().default("draft"),
        displayName: text("display_name"),
        completedSteps: text("completed_steps").array().$type<KycStep[]>().notNull().default(sql`'{}'::text[]`),
        general: jsonb("general").$type<Record<string, any>>().notNull().default({}),
        personal: jsonb("personal").$type<Record<string, any>>().notNull().default({}),
        ubos: jsonb("ubos").$type<Record<string, any>[]>().notNull().default([]),
        directors: jsonb("directors").$type<Record<string, any>[]>().notNull().default([]),
        questionnaire: jsonb("questionnaire").$type<Record<string, any>>().notNull().default({}),
        documents: jsonb("documents").$type<KycDocument[]>().notNull().default([]),
        rejectionReason: text("rejection_reason"),
        submittedAt: timestamptz("submitted_at"),
        reviewedAt: timestamptz("reviewed_at"),
        reviewedBy: uuid("reviewed_by"),
        history: jsonb("history").$type<KycReviewEvent[]>().notNull().default([]),
        ...timestamps(),
    },
    (t) => [
        uniqueIndex("kyc_applications_user_key").on(t.user),
        index("kyc_applications_status_idx").on(t.status, t.updatedAt),
        index("kyc_applications_tier_idx").on(t.tier),
    ]
);

export const beneficiaries = pgTable(
    "beneficiaries",
    {
        id: id(),
        user: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        currency: text("currency").notNull(),
        kind: text("kind").$type<BeneficiaryKind>().notNull(),
        nickname: text("nickname"),
        bankName: text("bank_name"),
        bankCode: text("bank_code"),
        accountNumber: text("account_number"),
        accountName: text("account_name"),
        momoNetwork: text("momo_network"),
        momoNumber: text("momo_number"),
        momoName: text("momo_name"),
        alipayType: text("alipay_type"),
        alipayNo: text("alipay_no"),
        alipayName: text("alipay_name"),
        qrCodeUrl: text("qr_code_url"),
        lastUsedAt: timestamptz("last_used_at"),
        ...timestamps(),
    },
    (t) => [index("beneficiaries_user_currency_idx").on(t.user, t.currency, t.updatedAt)]
);
