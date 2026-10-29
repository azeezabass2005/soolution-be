import z from "zod";
import { PAYMENT_LINK_CURRENCIES, PAYMENT_LINK_DESCRIPTION_MAX, PAYMENT_LINK_TITLE_MAX, PAYMENT_LINK_USAGE } from "../common/payment-link.constants";

const optionalText = (max = 100) => z.string().trim().max(max).optional().transform((v) => v || undefined);
const optionalAmount = z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
    z.number({ invalid_type_error: "Enter a valid amount" }).positive("Enter an amount above zero").max(1_000_000_000, "That amount is too large").optional(),
);

/** A new payment link. Leaving out `amount` lets the payer choose it. */
export const ZCreatePaymentLink = z.object({
    currency: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.enum(PAYMENT_LINK_CURRENCIES, {
        errorMap: () => ({ message: "Choose a supported currency" }),
    })),
    amount: optionalAmount,
    title: optionalText(PAYMENT_LINK_TITLE_MAX),
    description: optionalText(PAYMENT_LINK_DESCRIPTION_MAX),
    usage: z.enum([PAYMENT_LINK_USAGE.SINGLE, PAYMENT_LINK_USAGE.REUSABLE], {
        errorMap: () => ({ message: "Choose single-use or reusable" }),
    }).default(PAYMENT_LINK_USAGE.REUSABLE),
});

export const ZUpdatePaymentLink = z.object({
    active: z.boolean({ required_error: "active is required", invalid_type_error: "active must be true or false" }),
});

/** What the payer fills in on the public link page */
export const ZPayPaymentLink = z
    .object({
        amount: optionalAmount,
        method: z.enum(["momo", "bank"], { errorMap: () => ({ message: "Choose how you'll pay" }) }),
        momoNetwork: optionalText(60),
        momoNumber: optionalText(30),
        momoName: optionalText(),
        bankName: optionalText(),
        bankCode: optionalText(40),
        accountNumber: optionalText(40),
        accountName: optionalText(),
        email: z.string().trim().email("Enter a valid email").max(120).optional().or(z.literal("").transform(() => undefined)),
    })
    .superRefine((data, ctx) => {
        const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
        if (data.method === "momo") {
            if (!data.momoNetwork) issue("momoNetwork", "Choose your provider");
            if (!data.momoNumber) issue("momoNumber", "Enter your mobile money number");
            else if (!/^\+?[0-9 ]{6,20}$/.test(data.momoNumber)) issue("momoNumber", "Enter a valid phone number");
            if (!data.momoName) issue("momoName", "Enter the name on your mobile money account");
        } else {
            if (!data.bankName) issue("bankName", "Enter your bank");
            if (!data.accountNumber) issue("accountNumber", "Enter your account number");
            else if (!/^[0-9A-Za-z -]{4,40}$/.test(data.accountNumber)) issue("accountNumber", "Enter a valid account number");
            if (!data.accountName) issue("accountName", "Enter the name on your account");
        }
    });

export type PayPaymentLinkInput = z.infer<typeof ZPayPaymentLink>;
