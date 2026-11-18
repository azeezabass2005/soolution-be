import {
    ACCOUNT_STATUS,
    ACCOUNT_TYPE,
    ALIPAY_PLATFORM,
    DETAIL_TYPE,
    JOURNAL_DIRECTION,
    JOURNAL_SOURCE,
    PUBLICATION_STATUS,
    TRANSACTION_STATUS,
    TRANSACTION_TYPE,
    USER_STATUS,
    WALLET_STATUS,
    WALLET_TRANSACTION_STATUS,
    WALLET_TRANSACTION_TYPE,
    WEBHOOK_PROVIDER,
    WEBHOOK_STATUS,
} from "../common/constant";

/** String unions shared by the schema, repositories and services (no DB imports here). */

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];
export type PublicationStatus = (typeof PUBLICATION_STATUS)[keyof typeof PUBLICATION_STATUS];
export type TransactionStatus = (typeof TRANSACTION_STATUS)[keyof typeof TRANSACTION_STATUS];
export type TransactionType = (typeof TRANSACTION_TYPE)[keyof typeof TRANSACTION_TYPE];
export type DetailType = (typeof DETAIL_TYPE)[keyof typeof DETAIL_TYPE];
export type AlipayPlatform = (typeof ALIPAY_PLATFORM)[keyof typeof ALIPAY_PLATFORM];
export type WalletStatus = (typeof WALLET_STATUS)[keyof typeof WALLET_STATUS];
export type WalletTransactionType = (typeof WALLET_TRANSACTION_TYPE)[keyof typeof WALLET_TRANSACTION_TYPE];
export type WalletTransactionStatus = (typeof WALLET_TRANSACTION_STATUS)[keyof typeof WALLET_TRANSACTION_STATUS];
export type AccountType = (typeof ACCOUNT_TYPE)[keyof typeof ACCOUNT_TYPE];
export type AccountStatus = (typeof ACCOUNT_STATUS)[keyof typeof ACCOUNT_STATUS];
export type JournalDirection = (typeof JOURNAL_DIRECTION)[keyof typeof JOURNAL_DIRECTION];
export type JournalSource = (typeof JOURNAL_SOURCE)[keyof typeof JOURNAL_SOURCE];
export type WebhookProvider = (typeof WEBHOOK_PROVIDER)[keyof typeof WEBHOOK_PROVIDER];
export type WebhookStatus = (typeof WEBHOOK_STATUS)[keyof typeof WEBHOOK_STATUS];

export type CurrencyCode =
    | "RMB" | "GHS" | "NGN" | "KES" | "ZAR" | "TZS" | "UGX" | "XOF" | "XAF" | "RWF"
    | "BWP" | "ETB" | "ZMW" | "CDF" | "SLL" | "MWK" | "USDT";

export type PartnerRole = "LOGISTICS" | "SUPPLIER" | "CREATOR" | "SKILL" | "TALENT" | "TUTOR";
export type ExperienceLevel = "BEGINNER" | "INTERMEDIATE" | "EXPERT";
export type PartnerStatus = "active" | "inactive" | "pending" | "suspended";

export type InstitutionType = "bank" | "momo" | "mpesa";
export type VerificationStatus = "pending" | "failed" | "passed";
export type VerificationKind = "bvn" | "details";
export type FxRateSource = "yellowcard" | "fincra" | "ogateway" | "admin";
export type PaymentLinkUsage = "single" | "reusable";
/** Details a payment link can ask the payer for */
export type PaymentLinkCollectField = "name" | "email" | "phone";
export type BeneficiaryKind = "bank" | "momo" | "alipay" | "wechat";
export type LedgerAlertSeverity = "warning" | "critical";
export type ReconciliationRunMode = "on_demand" | "cron";
export type ReconciliationStatus = "clean" | "mismatch" | "error";
