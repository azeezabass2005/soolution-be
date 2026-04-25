import z from "zod";
import { Request, Response, NextFunction } from "express";
import zodErrorHandler from "./zod.error";

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

    sender: z.object({
        name: z.string().min(1, "Sender name is required"),
        country: z.string().min(1, "Sender country is required"),
        phone: z.string().min(1, "Sender phone is required"),
        address: z.string().min(1, "Sender address is required"),
        dob: z.string().min(1, "Sender date of birth is required"),
        email: z.string().email("Sender email must be valid"),
        idNumber: z.string().optional(),
        idType: z.string().optional(),
    }),

    destination: z.object({
        accountName: z.string().min(1, "Destination account name is required"),
        accountNumber: z.string().min(1, "Destination account number is required"),
        accountType: z.string().min(1, "Destination account type is required"),
        country: z.string().min(1, "Destination country is required"),
    }),
});

export const validateCreateYellowCardTransaction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZCreateYellowCardTransaction.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};
