import z from "zod";
import { Request, Response, NextFunction } from "express";
import zodErrorHandler from "./zod.error";
import { WALLET_LIMITS } from "../config/wallet-limits.config";

const pinSchema = z
    .string()
    .length(WALLET_LIMITS.PIN_LENGTH, `PIN must be exactly ${WALLET_LIMITS.PIN_LENGTH} digits`)
    .regex(/^\d+$/, "PIN must contain only digits");

const ZSetTransactionPin = z.object({
    pin: pinSchema,
});

const ZChangeTransactionPin = z.object({
    oldPin: pinSchema,
    newPin: pinSchema,
});

const ZForgotTransactionPin = z.object({
    email: z.string().trim().email("A valid email is required").optional(),
});

const ZResetTransactionPin = z.object({
    token: z.string().trim().min(1, "Reset token is required"),
    newPin: pinSchema,
});

export const validateSetTransactionPin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZSetTransactionPin.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};

export const validateChangeTransactionPin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZChangeTransactionPin.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};

export const validateForgotTransactionPin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZForgotTransactionPin.parse(req.body || {});
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};

export const validateResetTransactionPin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZResetTransactionPin.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};
