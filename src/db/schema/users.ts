import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, smallint, text, uniqueIndex, uuid, jsonb } from "drizzle-orm/pg-core";
import { decimal, id, timestamps, timestamptz } from "../columns";
import type { UserTier } from "../../common/tier.constants";
import type { IdentityAddressParts, IdentityProofOfAddress, IdentityStatus } from "../../common/identity.constants";
import { ROLE_MAP } from "../../common/constant";

export const USER_PURPOSES = ["business", "personal", "travel", "investment", "savings", "others", "spending"] as const;
export const USER_BUSINESS_TYPES = ["creators", "retail-sales", "software", "services", "entertainment", "media", "payments", "others"] as const;
export const USER_HEAR_ABOUT_US = [
    "friends", "ads", "search-engines", "social-media", "referrals", "events", "youtube",
    "instagram", "x-twitter", "facebook", "tiktok", "google", "others",
] as const;
export const USER_ACCOUNT_STATUSES = ["active", "inactive", "suspended", "pending", "deactivated"] as const;

/**
 * Money restrictions an admin can put on a user:
 *   balance: nothing can leave (no sends, withdrawals or exchanges)
 *   account: nothing moves; money that still arrives is credited but stays locked
 */
export const USER_FREEZE_STATES = ["none", "balance", "account"] as const;
export type UserFreeze = (typeof USER_FREEZE_STATES)[number];

/**
 * Users. The identity (BVN/NIN) record that used to be a nested Mongo object
 * is stored as `identity_*` columns so the one-BVN/NIN-per-account rule is a
 * real unique index; the repository maps them back to `user.identity`.
 */
export const users = pgTable(
    "users",
    {
        id: id(),
        email: text("email").notNull(),
        password: text("password").notNull(),
        firstName: text("first_name").notNull(),
        lastName: text("last_name").notNull(),
        isVerified: boolean("is_verified").notNull().default(false),
        tier: smallint("tier").$type<UserTier>().notNull().default(0),

        identityStatus: text("identity_status").$type<IdentityStatus>().notNull().default("unverified"),
        identityBvnHash: text("identity_bvn_hash"),
        identityBvnLast4: text("identity_bvn_last4"),
        identityBvnEnc: text("identity_bvn_enc"),
        identityNinEnc: text("identity_nin_enc"),
        identityNinHash: text("identity_nin_hash"),
        identityNinLast4: text("identity_nin_last4"),
        identityDob: text("identity_dob"),
        identityIdPhone: text("identity_id_phone"),
        identityAddress: text("identity_address"),
        /** The home address as typed: { street, city, state, lga?, country } */
        identityAddressParts: jsonb("identity_address_parts").$type<IdentityAddressParts>(),
        /** Proof of address the user uploaded (kept for review, not verified): { key, name, mimeType, size, uploadedAt } */
        identityProofOfAddress: jsonb("identity_proof_of_address").$type<IdentityProofOfAddress>(),
        identityDetailsUpdatedAt: timestamptz("identity_details_updated_at"),
        identityVerifiedName: text("identity_verified_name"),
        identityVerifiedAt: timestamptz("identity_verified_at"),
        identityMethod: text("identity_method"),
        identityFailureReason: text("identity_failure_reason"),

        isKYCDone: boolean("is_kyc_done").notNull().default(false),
        isKYCRejected: boolean("is_kyc_rejected").notNull().default(false),
        kycRejectionReason: text("kyc_rejection_reason"),
        isCompleted: boolean("is_completed").notNull().default(false),
        role: integer("role").notNull().default(ROLE_MAP.USER),
        status: text("status").$type<(typeof USER_ACCOUNT_STATUSES)[number]>().notNull().default("active"),
        freeze: text("freeze").$type<UserFreeze>().notNull().default("none"),
        freezeReason: text("freeze_reason"),
        /** A daily limit (NGN) for this user that replaces their tier's; null = the tier's */
        dailyLimitOverrideNgn: decimal("daily_limit_override_ngn"),
        sessionsValidAfter: timestamptz("sessions_valid_after"),
        lastLogin: text("last_login"),
        phoneNumber: text("phone_number"),
        whatsappNumber: text("whatsapp_number"),
        countryOfOrigin: text("country_of_origin"),
        countryOfResidence: text("country_of_residence"),
        purpose: text("purpose").$type<(typeof USER_PURPOSES)[number]>(),
        typeOfBusiness: text("type_of_business").$type<(typeof USER_BUSINESS_TYPES)[number]>(),
        monthlyVolume: text("monthly_volume"),
        hearAboutUs: text("hear_about_us").$type<(typeof USER_HEAR_ABOUT_US)[number]>(),
        hearAboutUsOther: text("hear_about_us_other"),

        transactionPinHash: text("transaction_pin_hash"),
        isTransactionPinSet: boolean("is_transaction_pin_set").notNull().default(false),
        transactionPinAttempts: integer("transaction_pin_attempts").notNull().default(0),
        transactionPinLockedUntil: timestamptz("transaction_pin_locked_until"),
        ...timestamps(),
    },
    (t) => [
        uniqueIndex("users_email_key").on(sql`lower(${t.email})`),
        index("users_tier_idx").on(t.tier),
        // One BVN / NIN per account
        uniqueIndex("users_identity_bvn_hash_key").on(t.identityBvnHash).where(sql`${t.identityBvnHash} is not null`),
        uniqueIndex("users_identity_nin_hash_key").on(t.identityNinHash).where(sql`${t.identityNinHash} is not null`),
    ]
);

/** Tier changes (approvals, BVN verification, admin overrides). Was `user.tierHistory`. */
export const userTierHistory = pgTable(
    "user_tier_history",
    {
        id: id(),
        user: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        tier: smallint("tier").$type<UserTier>().notNull(),
        reason: text("reason").notNull(),
        by: uuid("by_user_id"),
        at: timestamptz("at").notNull().defaultNow(),
    },
    (t) => [index("user_tier_history_user_idx").on(t.user, t.at)]
);

export const refreshTokens = pgTable(
    "refresh_tokens",
    {
        id: id(),
        userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        token: text("token").notNull().unique("refresh_tokens_token_key"),
        expiresAt: timestamptz("expires_at").notNull(),
        isRevoked: boolean("is_revoked").notNull().default(false),
        revokedAt: timestamptz("revoked_at"),
        userAgent: text("user_agent"),
        ipAddress: text("ip_address"),
        ...timestamps(),
    },
    (t) => [index("refresh_tokens_user_idx").on(t.userId, t.isRevoked)]
);

/**
 * Sign-in codes. After the password checks out, a 6-digit code is emailed and
 * the session is only issued once it's entered. The id is what the browser
 * holds between the two steps; only a hash of the code is stored.
 */
export const loginChallenges = pgTable(
    "login_challenges",
    {
        id: id(),
        userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        codeHash: text("code_hash").notNull(),
        expiresAt: timestamptz("expires_at").notNull(),
        /** Wrong codes entered for the current code */
        attempts: integer("attempts").notNull().default(0),
        /** Codes emailed for this sign-in (the first one included) */
        sendCount: integer("send_count").notNull().default(1),
        lastSentAt: timestamptz("last_sent_at").notNull().defaultNow(),
        /** Set once the code is accepted, or when a newer sign-in replaces this one */
        consumedAt: timestamptz("consumed_at"),
        rememberMe: boolean("remember_me").notNull().default(false),
        ipAddress: text("ip_address"),
        userAgent: text("user_agent"),
        ...timestamps(),
    },
    (t) => [index("login_challenges_user_idx").on(t.userId, t.createdAt)]
);
