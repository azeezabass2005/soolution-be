import z from "zod";
import { Request, Response, NextFunction } from "express";
import zodErrorHandler from "./zod.error";
import { WALLET_LIMITS } from "../config/wallet-limits.config";

const ZSetPin = z.object({
    pin: z
        .string()
        .length(WALLET_LIMITS.PIN_LENGTH, `PIN must be exactly ${WALLET_LIMITS.PIN_LENGTH} digits`)
        .regex(/^\d+$/, "PIN must contain only digits"),
});

const ZChangePin = z.object({
    oldPin: z
        .string()
        .length(WALLET_LIMITS.PIN_LENGTH, `PIN must be exactly ${WALLET_LIMITS.PIN_LENGTH} digits`)
        .regex(/^\d+$/, "PIN must contain only digits"),
    newPin: z
        .string()
        .length(WALLET_LIMITS.PIN_LENGTH, `PIN must be exactly ${WALLET_LIMITS.PIN_LENGTH} digits`)
        .regex(/^\d+$/, "PIN must contain only digits"),
});

const ZInitiateWithdrawal = z.object({
    amount: z
        .coerce.number()
        .positive("Amount must be a positive number")
        .min(WALLET_LIMITS.MIN_WITHDRAWAL, `Minimum withdrawal is ₦${WALLET_LIMITS.MIN_WITHDRAWAL.toLocaleString()}`),
    bankCode: z
        .string()
        .trim()
        .min(1, "Bank code is required"),
    accountNumber: z
        .string()
        .trim()
        .regex(/^\d{10}$/, "Account number must be 10 digits"),
    accountName: z
        .string()
        .trim()
        .min(1, "Account name is required"),
    pin: z
        .string()
        .length(WALLET_LIMITS.PIN_LENGTH, `PIN must be exactly ${WALLET_LIMITS.PIN_LENGTH} digits`)
        .regex(/^\d+$/, "PIN must contain only digits"),
});

const ZResolveAccount = z.object({
    accountNumber: z
        .string()
        .trim()
        .regex(/^\d{10}$/, "Account number must be 10 digits"),
    bankCode: z
        .string()
        .trim()
        .min(1, "Bank code is required"),
});

export const validateSetPin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZSetPin.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};

export const validateChangePin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZChangePin.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};

export const validateInitiateWithdrawal = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZInitiateWithdrawal.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};

export const validateResolveAccount = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZResolveAccount.parse(req.query);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};
