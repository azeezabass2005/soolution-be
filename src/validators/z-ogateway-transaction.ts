import z from "zod";
import { Request, Response, NextFunction } from "express";
import zodErrorHandler from "./zod.error";
import { WALLET_LIMITS } from "../config/wallet-limits.config";
import { OGATEWAY_NETWORKS } from "../common/constant";

// Send NGN→GHS: payout via OGateway MoMo or bank. Debits NGN wallet, so PIN required.
const ZCreateOGatewayPayout = z.object({
    amount: z.coerce.number().positive("Amount must be a positive number"),
    fromAmount: z.coerce.number().positive("fromAmount must be a positive number").optional(),
    fromCurrency: z.literal("NGN"),
    toCurrency: z.literal("GHS"),

    destination: z.object({
        accountType: z.enum(["momo", "bank"]),
        accountName: z.string().min(1, "Recipient account name is required"),
        accountNumber: z.string().min(1, "Recipient account number is required"),
        // One of these is required depending on accountType.
        network: z.enum(OGATEWAY_NETWORKS).optional(),
        bank: z.string().min(1).optional(),
    }).refine(
        (d) => (d.accountType === "momo" ? !!d.network : !!d.bank),
        { message: "network is required for momo, bank is required for bank payouts" },
    ),

    pin: z
        .string()
        .length(WALLET_LIMITS.PIN_LENGTH, `PIN must be exactly ${WALLET_LIMITS.PIN_LENGTH} digits`)
        .regex(/^\d+$/, "PIN must contain only digits"),
});

// Receive GHS→NGN: collection via OGateway MoMo. No wallet debit (sender pays), no PIN.
const ZCreateOGatewayCollection = z.object({
    amount: z.coerce.number().positive("Amount must be a positive number"),
    fromAmount: z.coerce.number().positive("fromAmount must be a positive number").optional(),
    fromCurrency: z.literal("GHS"),
    toCurrency: z.literal("NGN"),

    sender: z.object({
        accountName: z.string().min(1, "Sender account name is required"),
        accountNumber: z.string().min(1, "Sender account number is required"),
        network: z.enum(OGATEWAY_NETWORKS),
        email: z.string().email("Sender email must be valid").optional(),
    }),
});

export const validateCreateOGatewayPayout = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        ZCreateOGatewayPayout.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};

export const validateCreateOGatewayCollection = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        ZCreateOGatewayCollection.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};
