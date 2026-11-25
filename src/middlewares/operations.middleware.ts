import { NextFunction, Request, Response } from "express";
import platformSettingsService from "../services/platform-settings.service";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { ROLE_MAP } from "../common/constant";
import { SUPPORT_CONTACT } from "../common/operations";

type Kind = "out" | "in";

/**
 * Routes (under /protected) that start a money movement. "out" takes money
 * out of the user's account; "in" brings money in. Reads and quotes aren't
 * listed, so they keep working while things are paused.
 */
const MONEY_ROUTES: Array<{ method: string; path: RegExp; kind: Kind }> = [
    { method: "POST", path: /^\/(ogateway|ghs)\/?$/, kind: "out" },
    { method: "POST", path: /^\/(ogateway|ghs)\/manual\/?$/, kind: "out" },
    { method: "POST", path: /^\/transactions\/(alipay|bank-transfer)\/?$/, kind: "out" },
    { method: "POST", path: /^\/yellowcard\/?$/, kind: "out" },
    { method: "POST", path: /^\/wallet\/(exchange|withdraw)\/?$/, kind: "out" },
    { method: "POST", path: /^\/(ogateway|ghs)\/(collect|account|top-up)\/?$/, kind: "in" },
    { method: "POST", path: /^\/yellowcard\/collect\/?$/, kind: "in" },
    { method: "POST", path: /^\/payment-links\/?$/, kind: "in" },
];

export const moneyRouteKind = (method: string, path: string): Kind | null =>
    MONEY_ROUTES.find((r) => r.method === method && r.path.test(path))?.kind ?? null;

const contact = `Please contact support in the app (Support) or at ${SUPPORT_CONTACT.email}.`;

/** The error a user sees while payments are paused */
export const pausedError = (note?: string) =>
    errorResponseMessage.createError(503, `Payments are paused right now.${note ? ` ${note}` : ""} ${contact}`, ErrorSeverity.LOW, { code: "PAYMENTS_PAUSED" });

/** The error a user sees while sign-ins are paused */
export const loginsPausedError = (note?: string) =>
    errorResponseMessage.createError(503, `Sign-ins are paused right now.${note ? ` ${note}` : ""} ${contact}`, ErrorSeverity.LOW, { code: "LOGINS_PAUSED" });

/**
 * Why `user` can't be signed in right now, or null: a suspended or
 * deactivated account, or sign-ins paused (admins can always sign in).
 */
export async function signInBlock(user: { status?: string; role?: number }) {
    if (user.status && user.status !== "active") {
        return errorResponseMessage.createError(401, `Your account has been ${user.status}. ${contact}`, ErrorSeverity.LOW, { code: "ACCOUNT_SUSPENDED" });
    }
    if (user.role !== ROLE_MAP.ADMIN) {
        const { pause } = await platformSettingsService.getOperations();
        if (pause.logins) return loginsPausedError(pause.message);
    }
    return null;
}

/**
 * Stops money moving when the admin has paused payments, and applies a
 * user's freeze: "balance" stops money leaving, "account" stops everything
 * (money that arrives anyway is credited but can't be moved). Admins pass.
 */
export async function moneyGuard(req: Request, res: Response, next: NextFunction) {
    try {
        const kind = moneyRouteKind(req.method, req.path);
        if (!kind) return next();
        const user = res.locals.user;
        if (!user || user.role === ROLE_MAP.ADMIN) return next();

        const { pause } = await platformSettingsService.getOperations();
        if (pause.payments) return next(pausedError(pause.message));

        if (user.freeze === "account") {
            return next(errorResponseMessage.createError(403, `Your account is on hold, so payments can't be made or received. ${contact}`, ErrorSeverity.LOW, { code: "ACCOUNT_FROZEN" }));
        }
        if (user.freeze === "balance" && kind === "out") {
            return next(errorResponseMessage.createError(403, `Money can't leave your account right now. ${contact}`, ErrorSeverity.LOW, { code: "BALANCE_FROZEN" }));
        }
        return next();
    } catch (error) {
        return next(error);
    }
}
