import z from "zod";
import { ALIPAY_PLATFORM, DETAIL_TYPE, INSTITUTION_TYPE } from "../common/constant";
import {Request, Response, NextFunction} from "express";
import zodErrorHandler from "./zod.error";
import { validateTransactionAmount } from "../config/transaction-limits.config";

// Schema for Alipay transaction creation
const ZCreateAlipayTransaction = z.object({
    amount: z
        .coerce.number()
        .positive("Amount must be a positive number"),

    fromCurrency: z.enum([
        "NGN", // Nigeria
        "GHS" // Ghana
    ], {
        errorMap: () => ({message: "Currency From Not Supported"})
    }),

    platform: z.enum(Object.values(ALIPAY_PLATFORM) as [string, ...string[]], {
        errorMap: () => ({ message: "Invalid Alipay platform" })
    }).optional(),

    paymentMethod: z.enum(Object.values(DETAIL_TYPE) as [string, ...string[]], {
        errorMap: () => ({ message: "Invalid payment method" })
    }),

    alipayNo: z
        .string()
        .trim()
        .max(50, "Alipay No cannot exceed 50 characters")
        .optional(),

    alipayName: z
        .string()
        .trim()
        .max(100, "Alipay Name cannot exceed 100 characters")
        .optional(),

    // File validation - ensure it’s uploaded
    // alipayQrCode: z
    //     .custom<Express.Multer.File>((file) => {
    //         return file && typeof file === "object" && "fieldname" in file;
    //     }, {
    //         message: "Alipay QR code file is required"
    //     }),
});

export const validateCreateAlipayTransaction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZCreateAlipayTransaction.parse(req.body);

        // Note: Transaction amount minimum validation (NGN 5,000 equivalent) is handled
        // in the service layer where the proper NGN conversion is calculated.
        // The amount here is in RMB, not NGN, so it cannot be validated without conversion.

        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
}

// Base currencies (user's own currency)
const BASE_CURRENCIES = ["NGN", "GHS"] as const;
// All supported transfer currencies
const ALL_TRANSFER_CURRENCIES = ["GHS", "NGN", "XAF", "KES"] as const;

// Common bank/momo fields shared by both send and receive schemas
const bankTransferFields = {
    amount: z
        .coerce.number()
        .positive("Amount must be a positive number"),

    fromAmount: z
        .coerce.number()
        .positive("From amount must be a positive number")
        .optional(),

    paymentMethod: z.enum([DETAIL_TYPE.BANK_TRANSFER, DETAIL_TYPE.MOBILE_MONEY] as [string, ...string[]], {
        errorMap: () => ({ message: "Invalid payment method" })
    }),

    institutionType: z.enum(Object.values(INSTITUTION_TYPE) as [string, ...string[]], {
        errorMap: () => ({ message: "Invalid institution type" })
    }),

    bankName: z.string().trim().max(100, "Bank Name cannot exceed 100 characters").optional(),
    accountNumber: z.string().trim().max(50, "Account Number cannot exceed 50 characters").optional(),
    accountName: z.string().trim().max(100, "Account Name cannot exceed 100 characters").optional(),
    momoNetwork: z.string().trim().max(50, "MoMo Network cannot exceed 50 characters").optional(),
    momoNumber: z.string().trim().max(50, "MoMo Number cannot exceed 50 characters").optional(),
    momoName: z.string().trim().max(100, "MoMo Name cannot exceed 100 characters").optional(),
};

const institutionFieldsRefine = (data: any) => {
    if (data.institutionType === INSTITUTION_TYPE.BANK) {
        return data.bankName && data.accountNumber && data.accountName;
    }
    if (data.institutionType === INSTITUTION_TYPE.MOMO || data.institutionType === INSTITUTION_TYPE.MPESA) {
        return data.momoNetwork && data.momoNumber && data.momoName;
    }
    return true;
};

// Send: fromCurrency is user's base (NGN/GHS), toCurrency is any supported currency
const ZCreateSendBankTransferTransaction = z.object({
    ...bankTransferFields,
    transactionType: z.literal('send'),
    fromCurrency: z.enum(BASE_CURRENCIES, {
        errorMap: () => ({message: "Currency From Not Supported for send transactions"})
    }),
    toCurrency: z.enum(ALL_TRANSFER_CURRENCIES, {
        errorMap: () => ({message: "Currency To Not Supported"})
    }),
});

// Receive: fromCurrency is any supported currency, toCurrency is user's base (NGN/GHS)
const ZCreateReceiveBankTransferTransaction = z.object({
    ...bankTransferFields,
    transactionType: z.literal('receive'),
    fromCurrency: z.enum(ALL_TRANSFER_CURRENCIES, {
        errorMap: () => ({message: "Currency From Not Supported"})
    }),
    toCurrency: z.enum(BASE_CURRENCIES, {
        errorMap: () => ({message: "Currency To Not Supported for receive transactions"})
    }),
});

// Discriminated union: pick the right schema based on transactionType
const ZCreateBankTransferTransaction = z.discriminatedUnion("transactionType", [
    ZCreateSendBankTransferTransaction,
    ZCreateReceiveBankTransferTransaction,
]);

export const validateCreateBankTransferTransaction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const parsedData = ZCreateBankTransferTransaction.parse(req.body);

        // Validate institution-specific required fields
        if (!institutionFieldsRefine(parsedData)) {
            return next({
                response_code: 400,
                message: "Required fields are missing based on institution type",
                severity: "HIGH" as any,
                timestamp: new Date()
            });
        }

        // Validate amount against transaction limits
        // Use fromAmount (NGN equivalent) if provided, otherwise let service calculate it
        const amountValidation = validateTransactionAmount(
            parsedData.amount,
            parsedData.fromCurrency as any,
            parsedData.toCurrency as any,
            parsedData.fromAmount
        );

        if (!amountValidation.isValid) {
            return next({
                response_code: 400,
                message: amountValidation.error || "Transaction amount is outside allowed limits",
                severity: "HIGH" as any,
                timestamp: new Date()
            });
        }

        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
}