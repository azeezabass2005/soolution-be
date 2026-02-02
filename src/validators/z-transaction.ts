import z from "zod";
import { ALIPAY_PLATFORM, DETAIL_TYPE } from "../common/constant";
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