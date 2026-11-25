import errorResponseMessage, { ErrorSeverity } from "./messages/error-response-message";

/**
 * Why money is being sent or received. The values are YellowCard's own
 * (https://docs.yellowcard.engineering/docs/payment-reasons-api): sends must
 * carry one for compliance, so the same list is used everywhere.
 */
export const PAYMENT_REASONS = [
    { value: "gift", label: "Gift" },
    { value: "bills", label: "Bills" },
    { value: "groceries", label: "Groceries" },
    { value: "travel", label: "Travel" },
    { value: "health", label: "Health" },
    { value: "entertainment", label: "Entertainment" },
    { value: "housing", label: "Housing" },
    { value: "school-fees", label: "School fees" },
    { value: "other", label: "Other" },
] as const;
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
