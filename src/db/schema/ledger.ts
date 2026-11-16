import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { decimal, id, timestamps, timestamptz } from "../columns";
import { users } from "./users";
import { wallets } from "./wallets";
import type {
    AccountStatus,
    AccountType,
    JournalDirection,
    JournalSource,
    LedgerAlertSeverity,
    ReconciliationRunMode,
    ReconciliationStatus,
    WebhookProvider,
    WebhookStatus,
} from "../../types/enums";

/** Chart of accounts. `balance` is a cached projection of the journal. */
export const accounts = pgTable(
    "accounts",
    {
        id: id(),
        /** System accounts use fixed codes (SUSPENSE_NGN); user wallets use USER_WALLET_{CUR}:{userId} */
        code: text("code").notNull().unique("accounts_code_key"),
        type: text("type").$type<AccountType>().notNull(),
        currency: text("currency").notNull(),
        name: text("name").notNull(),
        ownerUser: uuid("owner_user_id").references(() => users.id),
        ownerWallet: uuid("owner_wallet_id").references(() => wallets.id),
        balance: decimal("balance").notNull().default(0),
        isSystem: boolean("is_system").notNull().default(false),
        status: text("status").$type<AccountStatus>().notNull().default("active"),
        description: text("description"),
        balanceUpdatedAt: timestamptz("balance_updated_at"),
        ...timestamps(),
    },
    (t) => [index("accounts_type_currency_idx").on(t.type, t.currency), index("accounts_owner_user_idx").on(t.ownerUser)]
);

/** Double-entry journal: every leg of one posting shares a txGroupId. Append-only. */
export const journalEntries = pgTable(
    "journal_entries",
    {
        id: id(),
        txGroupId: text("tx_group_id").notNull(),
        accountCode: text("account_code").notNull(),
        account: uuid("account_id").notNull().references(() => accounts.id),
        direction: text("direction").$type<JournalDirection>().notNull(),
        amount: decimal("amount").notNull(),
        currency: text("currency").notNull(),
        reference: text("reference").notNull(),
        source: text("source").$type<JournalSource>().notNull(),
        description: text("description").notNull(),
        externalRefProvider: text("external_ref_provider"),
        externalRefId: text("external_ref_id"),
        metadata: jsonb("metadata").$type<Record<string, unknown>>(),
        postedAt: timestamptz("posted_at").notNull().defaultNow(),
        postedBy: uuid("posted_by"),
        /** Set when a later posting reverses this leg */
        reversedBy: text("reversed_by"),
        ...timestamps(),
    },
    (t) => [
        index("journal_entries_tx_group_idx").on(t.txGroupId),
        index("journal_entries_account_posted_idx").on(t.accountCode, t.postedAt),
        index("journal_entries_reference_idx").on(t.reference),
        index("journal_entries_source_idx").on(t.source),
        index("journal_entries_posted_idx").on(t.postedAt),
        index("journal_entries_external_ref_idx").on(t.externalRefProvider, t.externalRefId),
        check("journal_entries_amount_check", sql`${t.amount} > 0`),
        check("journal_entries_direction_check", sql`${t.direction} in ('debit', 'credit')`),
    ]
);

/** Every inbound webhook, verbatim, before it is processed */
export const webhookEvents = pgTable(
    "webhook_events",
    {
        id: id(),
        provider: text("provider").$type<WebhookProvider>().notNull(),
        event: text("event"),
        externalId: text("external_id"),
        signature: text("signature"),
        signatureValid: boolean("signature_valid").notNull().default(false),
        headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
        payload: jsonb("payload").$type<any>().notNull(),
        receivedAt: timestamptz("received_at").notNull().defaultNow(),
        processedAt: timestamptz("processed_at"),
        status: text("status").$type<WebhookStatus>().notNull().default("received"),
        error: text("error"),
        txGroupId: text("tx_group_id"),
        replayOf: uuid("replay_of_id"),
        ...timestamps(),
    },
    (t) => [
        index("webhook_events_provider_status_idx").on(t.provider, t.status, t.receivedAt),
        index("webhook_events_event_idx").on(t.event),
        index("webhook_events_external_idx").on(t.externalId),
        index("webhook_events_received_idx").on(t.receivedAt),
        index("webhook_events_tx_group_idx").on(t.txGroupId),
    ]
);

export interface WalletProof {
    walletsChecked: number;
    mismatches: Array<{ walletId: string; userId?: string; expected: number; actual: number; delta: number }>;
}
export interface AccountProof {
    accountsChecked: number;
    mismatches: Array<{ code: string; expected: number; actual: number; delta: number }>;
}
export interface LedgerProof {
    txGroupsChecked: number;
    unbalancedGroups: Array<{ txGroupId: string; debits: number; credits: number; delta: number }>;
}
export interface ProviderProof {
    paystack?: { internalCashBalance: number; providerBalance?: number; delta?: number; fetchedAt: Date; error?: string };
    yellowcard?: { internalFloat: number; providerBalance?: number; delta?: number; fetchedAt: Date; error?: string };
}
export interface InFlightSummary {
    paystackTransfers: number;
    ycPayments: number;
    ycCollections: number;
}
export interface SuspenseSummary {
    totalUnattributed: number;
    count: number;
}

export const reconciliationReports = pgTable(
    "reconciliation_reports",
    {
        id: id(),
        startedAt: timestamptz("started_at").notNull().defaultNow(),
        finishedAt: timestamptz("finished_at"),
        runBy: uuid("run_by"),
        runMode: text("run_mode").$type<ReconciliationRunMode>().notNull().default("on_demand"),
        walletProof: jsonb("wallet_proof").$type<WalletProof>().notNull().default({ walletsChecked: 0, mismatches: [] }),
        accountProof: jsonb("account_proof").$type<AccountProof>().notNull().default({ accountsChecked: 0, mismatches: [] }),
        ledgerProof: jsonb("ledger_proof").$type<LedgerProof>().notNull().default({ txGroupsChecked: 0, unbalancedGroups: [] }),
        providerProof: jsonb("provider_proof").$type<ProviderProof>(),
        inFlight: jsonb("in_flight").$type<InFlightSummary>().notNull().default({ paystackTransfers: 0, ycPayments: 0, ycCollections: 0 }),
        suspense: jsonb("suspense").$type<SuspenseSummary>().notNull().default({ totalUnattributed: 0, count: 0 }),
        status: text("status").$type<ReconciliationStatus>().notNull().default("clean"),
        notes: text("notes"),
        ...timestamps(),
    },
    (t) => [index("reconciliation_reports_started_idx").on(t.startedAt), index("reconciliation_reports_status_idx").on(t.status)]
);

export const ledgerAlerts = pgTable(
    "ledger_alerts",
    {
        id: id(),
        severity: text("severity").$type<LedgerAlertSeverity>().notNull(),
        code: text("code").notNull(),
        accountCode: text("account_code"),
        txGroupId: text("tx_group_id"),
        expected: decimal("expected"),
        actual: decimal("actual"),
        delta: decimal("delta"),
        message: text("message").notNull(),
        metadata: jsonb("metadata").$type<Record<string, unknown>>(),
        acknowledgedAt: timestamptz("acknowledged_at"),
        acknowledgedBy: uuid("acknowledged_by"),
        ...timestamps(),
    },
    (t) => [
        index("ledger_alerts_severity_idx").on(t.severity, t.createdAt),
        index("ledger_alerts_code_idx").on(t.code),
        index("ledger_alerts_account_idx").on(t.accountCode),
        index("ledger_alerts_unacknowledged_idx").on(t.createdAt).where(sql`${t.acknowledgedAt} is null`),
    ]
);
