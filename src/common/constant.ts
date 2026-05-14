export const MODEL_NAME = {
    USER: "UserModel",
    POST: "PostModel",
    REFRESH_TOKEN: "RefreshTokenModel",
    TAG: "TagModel",
    EXCHANGE_RATE: "ExchangeRateModel",
    PARTNER: "PartnerModel",
    TRANSACTION: "TransactionModel",
    TRANSACTION_DETAIL: "Transaction DetailModel",
    BANK_ACCOUNT_DETAIL: "BankAccountDetailModel",
    VERIFICATION: "VerificationModel",
    IDEMPOTENCY_KEY: "IdempotencyKeyModel",
    AUDIT_LOG: "AuditLogModel",
    WALLET: "WalletModel",
    WALLET_TRANSACTION: "WalletTransactionModel",
    ACCOUNT: "AccountModel",
    JOURNAL_ENTRY: "JournalEntryModel",
    WEBHOOK_EVENT: "WebhookEventModel",
    RECONCILIATION_REPORT: "ReconciliationReportModel",
    LEDGER_ALERT: "LedgerAlertModel",
}

// ===================== LEDGER / CHART OF ACCOUNTS =====================
// Account types follow standard accounting convention.
// Direction semantics for the journal:
//   - asset/expense  → debit increases the balance
//   - liability/equity/revenue → credit increases the balance
export const ACCOUNT_TYPE = {
    ASSET: 'asset',
    LIABILITY: 'liability',
    EQUITY: 'equity',
    REVENUE: 'revenue',
    EXPENSE: 'expense',
} as const;

export const ACCOUNT_STATUS = {
    ACTIVE: 'active',
    FROZEN: 'frozen',
} as const;

export const JOURNAL_DIRECTION = {
    DEBIT: 'debit',
    CREDIT: 'credit',
} as const;

export const JOURNAL_SOURCE = {
    FUNDING: 'funding',
    WITHDRAWAL: 'withdrawal',
    YC_SEND: 'yc_send',
    YC_COLLECT: 'yc_collect',
    FEE: 'fee',
    REVERSAL: 'reversal',
    MANUAL_ATTRIBUTION: 'manual_attribution',
    FX: 'fx',
} as const;

// Fixed system account codes. Per-user wallet accounts use the dynamic
// pattern USER_WALLET_NGN:{userId} and are created on demand.
//
// Currency policy for this slice: every journal posting is in NGN. Cross-
// currency destinations (YC sends to KES/GHS/etc.) are tracked at NGN-equivalent
// in YC_FLOAT_NGN; the destination-currency amount is preserved on the
// transaction record (with lockedRate) for reporting. Per-currency YC accounts
// (ycCashAccountCode, etc.) remain in the chart of accounts for a future FX
// refactor but are not posted to today.
export const SYSTEM_ACCOUNT_CODES = {
    CASH_PAYSTACK_NGN: 'CASH_PAYSTACK_NGN',
    USER_WALLETS_NGN_TOTAL: 'USER_WALLETS_NGN_TOTAL',
    SUSPENSE_NGN: 'SUSPENSE_NGN',
    FEES_NGN: 'FEES_NGN',
    PAYSTACK_TRANSFER_INFLIGHT_NGN: 'PAYSTACK_TRANSFER_INFLIGHT_NGN',
    REVERSAL_CLEARING_NGN: 'REVERSAL_CLEARING_NGN',
    YC_FLOAT_NGN: 'YC_FLOAT_NGN',
} as const;

// Currencies supported on the YellowCard rail. Per-currency CASH and INFLIGHT
// accounts are derived from this list at bootstrap time.
export const YC_CURRENCIES = [
    'NGN', 'GHS', 'KES', 'ZAR', 'TZS', 'UGX',
    'XOF', 'XAF', 'RWF', 'BWP', 'ZMW', 'MWK',
] as const;

export const userWalletAccountCode = (userId: string, currency: string = 'NGN'): string =>
    `USER_WALLET_${currency}:${userId}`;
export const ycCashAccountCode = (currency: string): string => `CASH_YELLOWCARD_${currency}`;
export const ycPaymentInflightCode = (currency: string): string => `YC_PAYMENT_INFLIGHT_${currency}`;
export const ycCollectionInflightCode = (currency: string): string => `YC_COLLECTION_INFLIGHT_${currency}`;

export const WEBHOOK_PROVIDER = {
    PAYSTACK: 'paystack',
    YELLOWCARD: 'yellowcard',
    SMILE_ID: 'smile_id',
} as const;

export const WEBHOOK_STATUS = {
    RECEIVED: 'received',
    PROCESSED: 'processed',
    FAILED: 'failed',
    REPLAYED: 'replayed',
    IGNORED: 'ignored',
} as const;

export const ROLE_MAP = {
    USER: 6483,
    ADMIN: 7832,
    // COORDINATOR: 5730,
    // VOLUNTEER: 9293,
    // ORGANIZATION_ADMIN: 2085,
}

export const USER_STATUS = {
    ACTIVE: "active",
    INACTIVE: "inactive",
    PENDING: "pending"
}

export const PUBLICATION_STATUS = {
    DRAFT: "draft",
    PUBLISHED: "published",
    ARCHIVED: "archived",
    DELETED: "deleted"
}

export const CURRENCY_CODES = [
    "RMB", // China
    "GHS", // Ghana
    "NGN", // Nigeria
    "KES", // Kenya
    "ZAR", // South Africa
    "TZS", // Tanzania
    "UGX", // Uganda
    "XOF", // Benin, Mali, Ivory Coast, Burkina Faso, Senegal
    "XAF", // Cameroon, Chad, Congo, Gabon
    "RWF", // Rwanda
    "BWP", // Botswana
    "ETB", // Ethiopia
    "ZMW", // Zambia
    "CDF", // Congo (DRC)
    "SLL", // Sierra Leone
    "MWK", // Malawi
    "USDT" // Crypto
]

export const TRANSACTION_STATUS = {
    PENDING: "pending",
    SUCCESSFUL: "successful",
    FAILED: "failed",
    CANCELLED: "cancelled",
    // ALIPAY SPECIFIC STATUS
    PENDING_INPUT: "pending_input",
    AWAITING_CONFIRMATION: "awaiting_confirmation",
    AWAITING_KYC_VERIFICATION: "awaiting_kyc_verification",
    PROCESSING: "processing",
    COMPLETED: "completed",
};

export const PAYMENT_METHOD = {
    CARD: "card",
    BANK_TRANSFER: "bank_transfer",
    USSD: "ussd",
    MOBILE_MONEY: "mobile_money",
};

export const TRANSACTION_TYPE = {
    CREDIT: "credit",
    DEBIT: "debit",
}

export const DETAIL_TYPE = {
    ALIPAY: 'alipay',
    WECHAT: 'wechat',
    BANK_TRANSFER: 'bank_transfer',
    MOBILE_MONEY: 'mobile_money',
    YELLOWCARD: 'yellowcard',
}

export const YELLOWCARD_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    EXPIRED: 'expired',
    REFUNDED: 'refunded',
}

export const ALIPAY_PLATFORM = {
    NIGERIAN: 'nigerian',
    CHINESE: 'chinese',
}

export const INSTITUTION_TYPE = {
    BANK: 'bank',
    MOMO: 'momo', // For GHS and XAF
    MPESA: 'mpesa', // For KES
}

export const WALLET_TRANSACTION_TYPE = {
    FUNDING: 'funding',
    WITHDRAWAL: 'withdrawal',
    TRANSFER: 'transfer',
    REVERSAL: 'reversal',
}

export const WALLET_TRANSACTION_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    SUCCESSFUL: 'successful',
    FAILED: 'failed',
    REVERSED: 'reversed',
}

export const WALLET_STATUS = {
    ACTIVE: 'active',
    FROZEN: 'frozen',
    CLOSED: 'closed',
}