import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { decimal, id, timestamps, timestamptz } from "../columns";
import { users } from "./users";
import type { AlipayPlatform, DetailType, InstitutionType, PaymentLinkCollectField, PaymentLinkUsage, TransactionStatus } from "../../types/enums";

export const paymentLinks = pgTable(
    "payment_links",
    {
        id: id(),
        user: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        /** Public, unguessable id used in the link URL */
        slug: text("slug").notNull().unique("payment_links_slug_key"),
        currency: text("currency").notNull(),
        /** For a currency several countries share (XOF, XAF): where the payer pays from; null means the default */
        country: text("country"),
        toCurrency: text("to_currency").notNull().default("NGN"),
        amount: decimal("amount"),
        title: text("title"),
        description: text("description"),
        active: boolean("active").notNull().default(true),
        usage: text("usage").$type<PaymentLinkUsage>().notNull().default("reusable"),
        /** Where the payer is sent after a successful payment (optional) */
        redirectUrl: text("redirect_url"),
        /** Details the payer must give: "name", "email", "phone" */
        collectFields: jsonb("collect_fields").$type<PaymentLinkCollectField[]>().notNull().default([]),
        ...timestamps(),
    },
    (t) => [
        index("payment_links_user_idx").on(t.user, t.createdAt),
        check("payment_links_amount_check", sql`${t.amount} is null or ${t.amount} >= 0`),
    ]
);

export const transactions = pgTable(
    "transactions",
    {
        id: id(),
        user: uuid("user_id").notNull().references(() => users.id),
        reference: text("reference").notNull().unique("transactions_reference_key"),
        /** Opaque, non-enumerable token backing the public receipt verify page */
        receiptToken: text("receipt_token").unique("transactions_receipt_token_key"),
        amount: decimal("amount").notNull(),
        currency: text("currency").notNull(),
        fromCurrency: text("from_currency").notNull(),
        detailType: text("detail_type").$type<DetailType>().notNull(),
        status: text("status").$type<TransactionStatus>().notNull().default("pending"),
        initiatedAt: timestamptz("initiated_at").notNull().defaultNow(),
        completedAt: timestamptz("completed_at"),
        failedAt: timestamptz("failed_at"),
        cancelReason: text("cancel_reason"),
        // FX snapshot captured when the transaction is created
        lockedRate: decimal("locked_rate"),
        /** USD value at creation; counts towards the user's daily tier limit */
        /** Old USD valuation, no longer used */
        usdValue: decimal("usd_value"),
        /** Value in NGN, counted against the owner's daily tier limit */
        ngnValue: decimal("ngn_value"),
        lockedRateFromCurrency: text("locked_rate_from_currency"),
        lockedRateToCurrency: text("locked_rate_to_currency"),
        lockedRateAt: timestamptz("locked_rate_at"),
        /** The payment link the payer used, for collections started from one */
        paymentLink: uuid("payment_link_id").references(() => paymentLinks.id, { onDelete: "set null" }),
        payerName: text("payer_name"),
        payerEmail: text("payer_email"),
        payerPhone: text("payer_phone"),
        /** Why the money moved, where the type alone doesn't say: "top_up" = the user paid GHS in themselves */
        purpose: text("purpose").$type<"top_up">(),
        ...timestamps(),
    },
    (t) => [
        index("transactions_user_status_idx").on(t.user, t.status, t.detailType),
        index("transactions_user_created_idx").on(t.user, t.createdAt),
        index("transactions_status_initiated_idx").on(t.status, t.initiatedAt),
        index("transactions_detail_type_initiated_idx").on(t.detailType, t.initiatedAt),
        index("transactions_currency_created_idx").on(t.currency, t.createdAt),
        index("transactions_payment_link_idx").on(t.paymentLink, t.status),
        check("transactions_amount_check", sql`${t.amount} > 0`),
        check("transactions_currency_check", sql`${t.currency} ~ '^[A-Z]{3,4}$' and ${t.fromCurrency} ~ '^[A-Z]{3,4}$'`),
    ]
);

/** Snapshot of a company bank account shown to the payer of a manual transfer */
export interface BankAccountSnapshot {
    id?: string;
    currency?: string;
    accountNumber?: string;
    accountName?: string;
    bankName?: string;
    bankCode?: string | null;
    isDefault?: boolean;
    [key: string]: unknown;
}

/** One row per transaction (was the `details` virtual on Transaction) */
export const transactionDetails = pgTable(
    "transaction_details",
    {
        id: id(),
        transactionId: uuid("transaction_id").notNull().references(() => transactions.id, { onDelete: "cascade" }),
        type: text("type").$type<DetailType>().notNull(),

        // Alipay / WeChat
        platform: text("platform").$type<AlipayPlatform>(),
        alipayNo: text("alipay_no"),
        alipayName: text("alipay_name"),
        qrCodeUrl: text("qr_code_url"),
        /** Receipt the admin uploads after paying out */
        payInReceiptUrl: text("pay_in_receipt_url"),
        /** Receipt the user uploads after paying in */
        payOutReceiptUrl: text("pay_out_receipt_url"),
        bankAccountDetails: jsonb("bank_account_details").$type<BankAccountSnapshot>().notNull().default({}),
        fromAmount: decimal("from_amount"),

        // Bank transfer / mobile money
        institutionType: text("institution_type").$type<InstitutionType | string>(),
        country: text("country"),
        bankName: text("bank_name"),
        accountNumber: text("account_number"),
        accountName: text("account_name"),
        momoNetwork: text("momo_network"),
        momoNumber: text("momo_number"),
        momoName: text("momo_name"),

        // YellowCard
        ycCollectionId: text("yc_collection_id"),
        ycPaymentId: text("yc_payment_id"),
        ycSequenceId: text("yc_sequence_id"),
        ycChannelId: text("yc_channel_id"),
        ycNetworkId: text("yc_network_id"),
        ycStatus: text("yc_status"),
        ycRawPayload: jsonb("yc_raw_payload").$type<unknown>(),

        // OGateway
        ogId: text("og_id"),
        ogReference: text("og_reference"),
        ogChannel: text("og_channel"),
        ogNetwork: text("og_network"),
        ogBank: text("og_bank"),
        ogStatus: text("og_status"),
        ogRawPayload: jsonb("og_raw_payload").$type<unknown>(),

        // Fincra (GHS payouts and payment-link checkouts). providerReference is
        // ours (payout customerReference / checkout reference), providerId Fincra's.
        providerReference: text("provider_reference"),
        providerId: text("provider_id"),
        providerStatus: text("provider_status"),
        providerQuoteReference: text("provider_quote_reference"),
        /** NGN Fincra deducts for an NGN→GHS payout (the quote's amountToCharge) */
        providerCost: decimal("provider_cost"),
        checkoutUrl: text("checkout_url"),
        providerPayload: jsonb("provider_payload").$type<unknown>(),

        // Fee / markup snapshot
        feeAmount: decimal("fee_amount").notNull().default(0),
        feePercent: decimal("fee_percent").notNull().default(0),
        providerFeePercent: decimal("provider_fee_percent").notNull().default(0),
        markupPercent: decimal("markup_percent").notNull().default(0),

        // Which wallet paid for a send
        fundingCurrency: text("funding_currency"),
        fundingAmount: decimal("funding_amount"),
        fundingFee: decimal("funding_fee"),
        ...timestamps(),
    },
    (t) => [
        uniqueIndex("transaction_details_transaction_key").on(t.transactionId),
        index("transaction_details_yc_sequence_idx").on(t.ycSequenceId),
        index("transaction_details_yc_collection_idx").on(t.ycCollectionId),
        index("transaction_details_yc_payment_idx").on(t.ycPaymentId),
        index("transaction_details_og_reference_idx").on(t.ogReference),
        index("transaction_details_og_id_idx").on(t.ogId),
        uniqueIndex("transaction_details_provider_reference_key").on(t.providerReference).where(sql`${t.providerReference} is not null`),
    ]
);

export const idempotencyKeys = pgTable(
    "idempotency_keys",
    {
        id: id(),
        key: text("key").notNull().unique("idempotency_keys_key_key"),
        userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        transactionId: uuid("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
        expiresAt: timestamptz("expires_at").notNull(),
        ...timestamps(),
    },
    (t) => [index("idempotency_keys_user_idx").on(t.userId, t.key), index("idempotency_keys_expires_idx").on(t.expiresAt)]
);

/** Per-user lock so one transaction at a time is checked against the daily limit */
export const transactionLimitLocks = pgTable("transaction_limit_locks", {
    key: text("key").primaryKey(),
    token: text("token").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
});

/**
 * Audit trail. No foreign keys on purpose: entries must survive whatever they
 * describe and can be written for rows created in a transaction that hasn't
 * committed yet.
 */
export const auditLogs = pgTable(
    "audit_logs",
    {
        id: id(),
        transactionId: uuid("transaction_id"),
        userId: uuid("user_id"),
        action: text("action").notNull(),
        beforeValue: jsonb("before_value").$type<unknown>(),
        afterValue: jsonb("after_value").$type<unknown>(),
        ipAddress: text("ip_address"),
        userAgent: text("user_agent"),
        metadata: jsonb("metadata").$type<Record<string, unknown>>(),
        ...timestamps(),
    },
    (t) => [
        index("audit_logs_transaction_idx").on(t.transactionId, t.createdAt),
        index("audit_logs_user_idx").on(t.userId, t.createdAt),
        index("audit_logs_action_idx").on(t.action, t.createdAt),
        index("audit_logs_created_idx").on(t.createdAt),
    ]
);

/**
 * Turning received foreign currency into naira at the provider: every GHS
 * payment-link receipt at Fincra is converted to NGN once it's confirmed.
 * One row per receipt; retried until Fincra reports it done, then booked.
 */
export const fxConversions = pgTable(
    "fx_conversions",
    {
        id: id(),
        transactionId: uuid("transaction_id").notNull().references(() => transactions.id),
        provider: text("provider").notNull(),
        sourceCurrency: text("source_currency").notNull(),
        destinationCurrency: text("destination_currency").notNull(),
        /** What's converted, in the source currency (what the provider settled to us) */
        sourceAmount: decimal("source_amount").notNull(),
        /** The NGN value the receipt was booked at in the provider's cash account */
        bookedNgn: decimal("booked_ngn").notNull(),
        /** pending (to start or retry) | processing (sent, awaiting the result) | successful | failed (gave up) */
        status: text("status").$type<"pending" | "processing" | "successful" | "failed">().notNull().default("pending"),
        /** Ours, unique per attempt: Fincra refuses a repeat */
        customerReference: text("customer_reference"),
        quoteReference: text("quote_reference"),
        providerReference: text("provider_reference"),
        amountReceived: decimal("amount_received"),
        rate: decimal("rate"),
        attempts: integer("attempts").notNull().default(0),
        lastError: text("last_error"),
        nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
        completedAt: timestamptz("completed_at"),
        ...timestamps(),
    },
    (t) => [
        uniqueIndex("fx_conversions_transaction_key").on(t.transactionId),
        uniqueIndex("fx_conversions_provider_reference_key").on(t.providerReference),
        index("fx_conversions_due_idx").on(t.status, t.nextAttemptAt),
    ]
);
