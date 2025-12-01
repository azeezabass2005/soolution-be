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
    accountNumber: z
        .number()
        .min(8, "Account Number too short")
        .max(12, "Account Number too long"),
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

export const validateCreateBankAccountDetails = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZBankAccountDetails.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
}