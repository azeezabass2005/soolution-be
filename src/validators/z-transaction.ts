import z from "zod";
import { ALIPAY_PLATFORM, DETAIL_TYPE, INSTITUTION_TYPE } from "../common/constant";
import {Request, Response, NextFunction} from "express";
import zodErrorHandler from "./zod.error";

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
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
}

// Schema for Bank Transfer / Mobile Money transaction creation (GHS, XAF, KES)
const ZCreateBankTransferTransaction = z.object({
    amount: z
        .coerce.number()
        .positive("Amount must be a positive number"),

    fromCurrency: z.enum([
        "NGN", // Nigeria
        "GHS", // Ghana
    ], {
        errorMap: () => ({message: "Currency From Not Supported"})
    }),

    toCurrency: z.enum([
        "GHS", // Ghana
        "NGN", // Nigeria
        "XAF", // Cameroon
        "KES", // Kenya
    ], {
        errorMap: () => ({message: "Currency To Not Supported"})
    }),

    paymentMethod: z.enum([DETAIL_TYPE.BANK_TRANSFER, DETAIL_TYPE.MOBILE_MONEY] as [string, ...string[]], {
        errorMap: () => ({ message: "Invalid payment method" })
    }),

    institutionType: z.enum(Object.values(INSTITUTION_TYPE) as [string, ...string[]], {
        errorMap: () => ({ message: "Invalid institution type" })
    }),

    // Bank fields (required if institutionType is 'bank')
    bankName: z
        .string()
        .trim()
        .max(100, "Bank Name cannot exceed 100 characters")
        .optional(),

    accountNumber: z
        .string()
        .trim()
        .max(50, "Account Number cannot exceed 50 characters")
        .optional(),

    accountName: z
        .string()
        .trim()
        .max(100, "Account Name cannot exceed 100 characters")
        .optional(),

    // Mobile Money fields (required if institutionType is 'momo' or 'mpesa')
    momoNetwork: z
        .string()
        .trim()
        .max(50, "MoMo Network cannot exceed 50 characters")
        .optional(),

    momoNumber: z
        .string()
        .trim()
        .max(50, "MoMo Number cannot exceed 50 characters")
        .optional(),

    momoName: z
        .string()
        .trim()
        .max(100, "MoMo Name cannot exceed 100 characters")
        .optional(),
}).refine((data) => {
    // If institution type is bank, bank fields are required
    if (data.institutionType === INSTITUTION_TYPE.BANK) {
        return data.bankName && data.accountNumber && data.accountName;
    }
    // If institution type is momo or mpesa, momo fields are required
    if (data.institutionType === INSTITUTION_TYPE.MOMO || data.institutionType === INSTITUTION_TYPE.MPESA) {
        return data.momoNetwork && data.momoNumber && data.momoName;
    }
    return true;
}, {
    message: "Required fields are missing based on institution type",
    path: ["institutionType"]
});

export const validateCreateBankTransferTransaction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZCreateBankTransferTransaction.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
}