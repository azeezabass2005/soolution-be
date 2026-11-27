import errorResponseMessage, { ErrorSeverity } from "./messages/error-response-message";

/**
 * YellowCard's accepted /payments reason enum
 * (https://docs.yellowcard.engineering/docs/payment-reasons-api).
 */
export const YELLOWCARD_PAYMENT_REASONS = [
    "gift",
    "bills",
    "groceries",
    "travel",
    "health",
    "entertainment",
    "housing",
    "school-fees",
    "other",
] as const;
export type YellowCardPaymentReason = (typeof YELLOWCARD_PAYMENT_REASONS)[number];

/**
 * Why money is being sent or received. Sends must carry one for compliance.
 * Business and family/friends options are stored as-is on our transaction and
 * mapped to a YellowCard-accepted value via `yellowCardReasonOf` when routing
 * through YellowCard.
 */
export const PAYMENT_REASONS = [
    { value: "family-friends", label: "Family & Friends", yc: "gift" },
    { value: "business", label: "Business", yc: "other" },
    { value: "supplier-payment", label: "Supplier payment", yc: "other" },
    { value: "customer-payment", label: "Customer payment", yc: "other" },
    { value: "goods-restock", label: "Goods restock", yc: "other" },
    { value: "staff-payment", label: "Staff payment", yc: "other" },
    { value: "gift", label: "Gift", yc: "gift" },
    { value: "bills", label: "Bills", yc: "bills" },
    { value: "groceries", label: "Groceries", yc: "groceries" },
    { value: "travel", label: "Travel", yc: "travel" },
    { value: "health", label: "Health", yc: "health" },
    { value: "entertainment", label: "Entertainment", yc: "entertainment" },
    { value: "housing", label: "Housing", yc: "housing" },
    { value: "school-fees", label: "School fees", yc: "school-fees" },
    { value: "other", label: "Other", yc: "other" },
] as const satisfies readonly { value: string; label: string; yc: YellowCardPaymentReason }[];
export type PaymentReason = (typeof PAYMENT_REASONS)[number]["value"];
const VALUES = PAYMENT_REASONS.map((r) => r.value) as readonly string[];
export const NARRATION_MAX = 100;

/**
 * The reason and optional note from a request body. Sends need a reason;
 * receives may leave it out. Notes are trimmed, plain text, ≤ 100 characters.
 */
export const paymentReasonOf = (body: any, options: { required: boolean }): { reason: PaymentReason | null; narration: string | null } => {
    const raw = typeof body?.reason === "string" ? body.reason.trim().toLowerCase() : "";
    if (!raw) {
        if (options.required) throw errorResponseMessage.createError(400, "Choose a reason for this payment", ErrorSeverity.LOW, { issues: [{ path: "reason", message: "Choose a reason" }] });
    } else if (!VALUES.includes(raw)) {
        throw errorResponseMessage.createError(400, "Choose one of the listed reasons", ErrorSeverity.LOW, { issues: [{ path: "reason", message: "Choose one of the listed reasons" }] });
    }
    const note = typeof body?.narration === "string" ? body.narration.replace(/<[^>]*>/g, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, NARRATION_MAX) : "";
    return { reason: (raw || null) as PaymentReason | null, narration: note || null };
};

export const paymentReasonLabel = (value?: string | null) => PAYMENT_REASONS.find((r) => r.value === value)?.label ?? null;

/** Maps a stored payment reason to a value accepted by YellowCard's /payments API */
export const yellowCardReasonOf = (value?: string | null): YellowCardPaymentReason =>
    PAYMENT_REASONS.find((r) => r.value === value)?.yc ?? "other";
