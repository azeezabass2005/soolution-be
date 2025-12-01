import z from "zod";
import {NextFunction, Request, Response} from "express";
import zodErrorHandler from "./zod.error";

const ZExchangeRate = z.object({
    from: z.enum([
        "RMB", // China
        "GHS", // Ghana
        "NGN", // Nigeria
        "KES", // Kenya
        "ZAR", // South Africa
        "TZS", // Tanzania
        "UGX", // Uganda
        "XOF", // Benin, Mali, Ivory Coast, Burkina Faso
        "XAF", // Cameroon
        "RWF", // Rwanda
        "USDT" // Crypto
    ], {
        errorMap: () => ({message: "Currency From Not Supported"})
    }),
    to: z.enum([
        "RMB", // China
        "GHS", // Ghana
        "NGN", // Nigeria
        "KES", // Kenya
        "ZAR", // South Africa
        "TZS", // Tanzania
        "UGX", // Uganda
        "XOF", // Benin, Mali, Ivory Coast, Burkina Faso
        "XAF", // Cameroon
        "RWF", // Rwanda
        "USDT" // Crypto
    ], {
        errorMap: () => ({message: "Currency To Not Supported"})
    }),
    rate: z.number(),
    isActive: z.boolean().optional()
})

const ZExchangeRateUpdate = ZExchangeRate.partial();

const validate = (req: Request, res: Response, next: NextFunction) => {
    try {
        ZExchangeRate.parse(req.body);
        next()
    } catch (error) {
        zodErrorHandler(error, next)
    }
}

export const validateUpdate = (req: Request, res: Response, next: NextFunction) => {
    try {
        ZExchangeRateUpdate.parse(req.body);
        next()
    } catch (error) {
        zodErrorHandler(error, next)
    }
}

export default validate;