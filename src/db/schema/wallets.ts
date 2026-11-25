import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { decimal, id, timestamps, timestamptz } from "../columns";
import { users } from "./users";
import { transactions } from "./transactions";
import type { WalletCurrency } from "../../common/wallet.constants";
import type { FxRateSource, WalletStatus, WalletTransactionStatus, WalletTransactionType } from "../../types/enums";

export const wallets = pgTable(
    "wallets",
    {
        id: id(),
        user: uuid("user_id").notNull().references(() => users.id),
        currency: text("currency").$type<WalletCurrency>().notNull().default("NGN"),
        balance: decimal("balance").notNull().default(0),
        ledgerBalance: decimal("ledger_balance").notNull().default(0),
        status: text("status").$type<WalletStatus>().notNull().default("active"),

        // Paystack customer & dedicated virtual account (NGN wallet only)
        paystackCustomerCode: text("paystack_customer_code"),
        paystackCustomerId: bigint("paystack_customer_id", { mode: "number" }),
        dvaBankName: text("dva_bank_name"),
        dvaAccountNumber: text("dva_account_number"),
        dvaAccountName: text("dva_account_name"),
        dvaBankId: integer("dva_bank_id"),
        dvaId: bigint("dva_id", { mode: "number" }),
        isDVAProvisioned: boolean("is_dva_provisioned").notNull().default(false),
        // Who issued the virtual account ('fincra'), its id there, and its
        // state while Fincra reviews it (pending → approved | declined)
        dvaProvider: text("dva_provider"),
        dvaExternalId: text("dva_external_id"),
        dvaStatus: text("dva_status"),
        ...timestamps(),
    },
    (t) => [
        uniqueIndex("wallets_user_currency_key").on(t.user, t.currency),
        index("wallets_paystack_customer_idx").on(t.paystackCustomerCode),
        index("wallets_dva_account_idx").on(t.dvaAccountNumber),
        uniqueIndex("wallets_dva_external_key").on(t.dvaProvider, t.dvaExternalId).where(sql`${t.dvaExternalId} is not null`),
        index("wallets_user_created_idx").on(t.user, t.createdAt),
        // Every debit is guarded in SQL; this is the last line of defence
        check("wallets_balance_non_negative", sql`${t.balance} >= 0`),
    ]
);

export const fxQuotes = pgTable(
    "fx_quotes",
    {
        id: id(),
        user: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        fromCurrency: text("from_currency").$type<WalletCurrency>().notNull(),
        toCurrency: text("to_currency").$type<WalletCurrency>().notNull(),
        fromAmount: decimal("from_amount").notNull(),
        toAmount: decimal("to_amount").notNull(),
        rate: decimal("rate").notNull(),
        providerRate: decimal("provider_rate").notNull(),
        rateSource: text("rate_source").$type<FxRateSource>().notNull(),
        expiresAt: timestamptz("expires_at").notNull(),
        usedAt: timestamptz("used_at"),
        ...timestamps(),
    },
    (t) => [
        index("fx_quotes_user_idx").on(t.user),
        index("fx_quotes_created_idx").on(t.createdAt),
        check("fx_quotes_amounts_check", sql`${t.fromAmount} >= 0 and ${t.toAmount} >= 0 and ${t.rate} >= 0 and ${t.providerRate} >= 0`),
    ]
);

export const walletTransactions = pgTable(
    "wallet_transactions",
    {
        id: id(),
        wallet: uuid("wallet_id").notNull().references(() => wallets.id),
        user: uuid("user_id").notNull().references(() => users.id),
        type: text("type").$type<WalletTransactionType>().notNull(),
        status: text("status").$type<WalletTransactionStatus>().notNull().default("pending"),
        amount: decimal("amount").notNull(),
        reference: text("reference").notNull().unique("wallet_transactions_reference_key"),
        balanceBefore: decimal("balance_before").notNull(),
        balanceAfter: decimal("balance_after").notNull(),
        description: text("description"),

        // Paystack references (also links YellowCard / OGateway sends to their transaction)
        paystackReference: text("paystack_reference"),
        paystackTransferCode: text("paystack_transfer_code"),

        // Withdrawal recipient
        recipientBankCode: text("recipient_bank_code"),
        recipientBankName: text("recipient_bank_name"),
        recipientAccountNumber: text("recipient_account_number"),
        recipientAccountName: text("recipient_account_name"),
        paystackRecipientCode: text("paystack_recipient_code"),

        failureReason: text("failure_reason"),
        /** The last status the user was told about (the notifier tells them once per final status) */
        notifiedStatus: text("notified_status"),
        reversedTransactionId: uuid("reversed_transaction_id"),

        /** The wallet's currency */
        currency: text("currency"),

        // Exchanges: the other side of the conversion
        counterCurrency: text("counter_currency"),
        counterAmount: decimal("counter_amount"),
        /** NGN per 1 unit of the other currency, as quoted */
        rate: decimal("rate"),
        fxQuoteId: uuid("fx_quote_id").references(() => fxQuotes.id, { onDelete: "set null" }),

        // Sends paid from this wallet: the NGN figures posted to the provider side
        sendNgnAmount: decimal("send_ngn_amount"),
        sendNgnFee: decimal("send_ngn_fee"),
        sendFee: decimal("send_fee"),
        /** NGN fee charged on a funding or withdrawal, on top of `amount` (withdrawal) or out of the deposit (funding) */
        fee: decimal("fee"),
        providerAccountCode: text("provider_account_code"),
        transactionId: uuid("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
        ...timestamps(),
    },
    (t) => [
        index("wallet_transactions_wallet_idx").on(t.wallet, t.createdAt),
        index("wallet_transactions_user_type_idx").on(t.user, t.type, t.createdAt),
        index("wallet_transactions_paystack_reference_idx").on(t.paystackReference),
        index("wallet_transactions_paystack_transfer_idx").on(t.paystackTransferCode),
        index("wallet_transactions_transaction_idx").on(t.transactionId),
        // A Paystack charge (or a collection) credits a wallet at most once
        uniqueIndex("wallet_transactions_funding_reference_key")
            .on(t.paystackReference)
            .where(sql`${t.type} = 'funding' and ${t.paystackReference} is not null`),
        check("wallet_transactions_amount_check", sql`${t.amount} >= 0`),
    ]
);
