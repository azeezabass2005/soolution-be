import type { Response } from "express";
import config from "../config/env.config";

export const AUTH_COOKIE_NAMES = ["accessToken", "refreshToken", "role"] as const;

/**
 * Where the sign-in cookies live. Each environment's API keeps its own
 * (COOKIE_DOMAIN is that API's host), so signing in to staging can't
 * overwrite production's cookies or the other way round. Empty means the
 * cookie belongs to the exact API host only.
 */
export const authCookieBase = () => ({
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
});

/**
 * Removes the sign-in cookies left on domains no longer used (the shared
 * ".solutionpay.co" both environments used to write to). Sent along with
 * every new session and on sign-out, so old cookies go away by themselves.
 */
export function clearLegacyAuthCookies(res: Response): void {
    for (const domain of config.LEGACY_COOKIE_DOMAINS) {
        if (!domain || domain === config.COOKIE_DOMAIN) continue;
        for (const name of AUTH_COOKIE_NAMES) {
            res.clearCookie(name, { ...authCookieBase(), domain, httpOnly: name !== "role" });
        }
    }
}

/** Signs the browser out: this environment's cookies and any old shared ones */
export function clearAuthCookies(res: Response): void {
    for (const name of AUTH_COOKIE_NAMES) {
        res.clearCookie(name, { ...authCookieBase(), httpOnly: name !== "role" });
    }
    clearLegacyAuthCookies(res);
}

/**
 * Every value of a cookie in a Cookie header. A browser can send the same
 * name more than once (an old shared-domain cookie next to the current one),
 * so callers try each rather than trusting the first.
 */
export function cookieValues(cookieHeader: string | undefined, name: string): string[] {
    if (!cookieHeader) return [];
    const values: string[] = [];
    for (const part of cookieHeader.split(";")) {
        const pair = part.trim();
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        if (pair.slice(0, eq).trim() === name) {
            const value = pair.slice(eq + 1).trim();
            if (value) values.push(value);
        }
    }
    return values;
}
