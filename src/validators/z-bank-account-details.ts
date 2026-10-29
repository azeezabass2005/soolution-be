import z from "zod";
import {NextFunction} from "express";
import zodErrorHandler from "./zod.error";

const ZBankAccountDetails = z.object({
    currency: z.enum([
        "NGN", // Nigeria
        "GHS" // Ghana
    ], {
        errorMap: () => ({message: "You cannot create a bank account for this currency"})
    }),
    accountNumber: z.preprocess(
        (v) => (typeof v === "number" ? String(v) : v),
        z.string().regex(/^[0-9]{6,20}$/, "Enter a valid account number"),
    ),
    accountName: z
        .string()
        .trim()
        .min(5, "Account name is too short")
        .max(100, "Account Name is too long"),
    bankName: z
        .string()
        .trim()
        .min(2, "Bank Name is too short")
        .max(100, "Bank Name is too long"),
})

/** A user's own saved account (where they receive or withdraw). Unknown fields are dropped. */
export const ZUserBankAccount = z.object({
    currency: z.enum(["NGN", "GHS"], { errorMap: () => ({ message: "You can save NGN or GHS accounts" }) }),
    accountNumber: z.preprocess(
        (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.replace(/\s+/g, "") : v),
        z.string({ required_error: "Account number is required" }).regex(/^[0-9]{6,20}$/, "Enter a valid account number"),
    ),
    accountName: z.string({ required_error: "Account name is required" }).trim().min(2, "Account name is too short").max(100, "Account name is too long"),
    bankName: z.string({ required_error: "Bank is required" }).trim().min(2, "Choose a bank").max(100, "Bank name is too long"),
    bankCode: z.string().trim().max(40).optional().transform((v) => v || undefined),
}).superRefine((data, ctx) => {
    if (data.currency === "NGN" && !/^\d{10}$/.test(data.accountNumber)) {
        ctx.addIssue({ code: "custom", path: ["accountNumber"], message: "Nigerian account numbers have 10 digits" });
    }
    if (data.currency === "NGN" && !data.bankCode) {
        ctx.addIssue({ code: "custom", path: ["bankCode"], message: "Choose the bank from the list" });
    }
});

export const validateCreateBankAccountDetails = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZBankAccountDetails.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
}