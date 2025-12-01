import z from "zod";
import { ALIPAY_PLATFORM } from "../common/constant";
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
    }),

    alipayId: z
        .string()
        .trim()
        .min(1, "Alipay ID is required")
        .max(50, "Alipay ID cannot exceed 50 characters"),

    alipayName: z
        .string()
        .trim()
        .min(1, "Alipay Name is required")
        .max(100, "Alipay Name cannot exceed 100 characters"),

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