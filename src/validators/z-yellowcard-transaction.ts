import z from "zod";
import { Request, Response, NextFunction } from "express";
import zodErrorHandler from "./zod.error";
import { WALLET_LIMITS } from "../config/wallet-limits.config";

const ZCreateYellowCardTransaction = z.object({
    amount: z
        .coerce.number()
        .positive("Amount must be a positive number"),

    fromAmount: z
        .coerce.number()
        .positive("fromAmount must be a positive number")
        .optional(),

    fromCurrency: z.string().min(1, "fromCurrency is required"),

    toCurrency: z.string().min(1, "toCurrency is required"),

    // The sender YellowCard sees is built from the user's verified record
    // (identityService.yellowCardPerson); anything sent here is ignored.
    sender: z.object({ country: z.string().optional() }).passthrough().optional(),

    destination: z.object({
        accountName: z.string().min(1, "Destination account name is required"),
        accountNumber: z.string().min(1, "Destination account number is required"),
        accountType: z.string().min(1, "Destination account type is required"),
        country: z.string().min(1, "Destination country is required"),
    }),

    // YellowCard send debits the user's wallet — PIN is required.
    // Note: this schema is NOT applied to /collect (collections don't debit).
    pin: z
        .string()
        .length(WALLET_LIMITS.PIN_LENGTH, `PIN must be exactly ${WALLET_LIMITS.PIN_LENGTH} digits`)
        .regex(/^\d+$/, "PIN must contain only digits"),
});

export const validateCreateYellowCardTransaction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZCreateYellowCardTransaction.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};
