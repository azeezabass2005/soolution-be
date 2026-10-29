import z from "zod";
import {
    ALIPAY_TYPES,
    BENEFICIARY_CURRENCIES,
    BENEFICIARY_KIND,
    MOMO_ONLY_CURRENCIES,
    PAYOUT_KINDS,
    RMB_KINDS,
} from "../common/beneficiary.constants";

const text = (label: string, max = 100) =>
    z.string({ required_error: `${label} is required` }).trim().min(1, `${label} is required`).max(max, `${label} is too long`);
const optionalText = (max = 100) => z.string().trim().max(max).optional().transform((v) => v || undefined);

/**
 * A new beneficiary. Accepts JSON or multipart (Alipay / WeChat carry a QR code
 * image), so every field arrives as a string. Unknown fields are dropped.
 */
export const ZCreateBeneficiary = z
    .object({
        currency: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.enum(BENEFICIARY_CURRENCIES, {
            errorMap: () => ({ message: "Choose a supported currency" }),
        })),
        kind: z.enum(Object.values(BENEFICIARY_KIND) as [string, ...string[]], {
            errorMap: () => ({ message: "Choose how the beneficiary gets paid" }),
        }),
        nickname: optionalText(60),
        bankName: optionalText(),
        bankCode: optionalText(40),
        accountNumber: optionalText(40),
        accountName: optionalText(),
        momoNetwork: optionalText(60),
        momoNumber: optionalText(30),
        momoName: optionalText(),
        alipayType: optionalText(30),
        alipayNo: optionalText(50),
        alipayName: optionalText(),
    })
    .superRefine((data, ctx) => {
        const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
        const kind = data.kind as (typeof RMB_KINDS)[number];

        if (data.currency === "RMB" && !RMB_KINDS.includes(kind)) return issue("kind", "RMB beneficiaries are paid by Alipay or WeChat");
        if (data.currency !== "RMB" && !PAYOUT_KINDS.includes(kind)) return issue("kind", "Choose bank or mobile money");
        if (kind === BENEFICIARY_KIND.BANK && MOMO_ONLY_CURRENCIES.includes(data.currency)) return issue("kind", `${data.currency} payouts go to mobile money only`);

        const require = (field: keyof typeof data, label: string) => {
            const result = text(label).safeParse(data[field] ?? "");
            if (!result.success) issue(field, result.error.issues[0].message);
        };
        if (kind === BENEFICIARY_KIND.BANK) {
            require("bankName", "Bank name");
            require("accountNumber", "Account number");
            require("accountName", "Account name");
            if (data.accountNumber && !/^[0-9A-Za-z -]{4,40}$/.test(data.accountNumber)) issue("accountNumber", "Enter a valid account number");
        }
        if (kind === BENEFICIARY_KIND.MOMO) {
            require("momoNetwork", "Provider");
            require("momoNumber", "Mobile money number");
            require("momoName", "Name on the wallet");
            if (data.momoNumber && !/^\+?[0-9 ]{6,20}$/.test(data.momoNumber)) issue("momoNumber", "Enter a valid phone number");
        }
        if (kind === BENEFICIARY_KIND.ALIPAY) {
            if (!ALIPAY_TYPES.includes(data.alipayType as any)) issue("alipayType", "Choose the Alipay type");
        }
        if (kind === BENEFICIARY_KIND.ALIPAY || kind === BENEFICIARY_KIND.WECHAT) {
            require("alipayName", "Name on the account");
        }
    });

export type CreateBeneficiaryInput = z.infer<typeof ZCreateBeneficiary>;
