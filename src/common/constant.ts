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
}

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
    "XOF", // Benin, Mali, Ivory Coast, Burkina Faso
    "XAF", // Cameroon
    "RWF", // Rwanda
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
    // TODO: I will add other detail types here e.g all the GHS transaction and the likes.
}

export const ALIPAY_PLATFORM = {
    NIGERIAN: 'nigerian',
    CHINESE: 'chinese',
}