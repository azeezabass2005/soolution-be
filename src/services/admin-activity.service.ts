import { and, desc, eq, gt, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { adminActivity, refreshTokens, users } from "../db/schema";
import { exec, isUuid } from "../repositories/utils";
import userRepository from "../repositories/user.repository";
import { ROLE_MAP } from "../common/constant";
import errorResponseMessage from "../common/messages/error-response-message";
import logger from "../utils/logger.utils";

/** Request fields never stored */
const SECRET = /pass(word)?|pin|token|secret|otp|code|cvv|card|bvn|nin|signature|authorization/i;
const MAX_BODY = 4000;

/** What an admin route does, in words (most specific first); unknown routes keep the path */
const ACTIONS: Array<[string, RegExp, string]> = [
    ["POST", /^\/admin\/approvals\/[^/]+\/approve$/, "Approved a held payout"],
    ["POST", /^\/admin\/approvals\/[^/]+\/reject$/, "Rejected a held payout"],
    ["POST", /^\/admin\/receive-holds\/[^/]+\/release$/, "Allowed withdrawal of a held receive"],
    ["PUT", /^\/admin\/platform-settings\/?$/, "Changed platform settings"],
    ["POST", /^\/admin\/team\/roles$/, "Created a role"],
    ["PUT", /^\/admin\/team\/roles\/[^/]+$/, "Changed a role"],
    ["DELETE", /^\/admin\/team\/roles\/[^/]+$/, "Deleted a role"],
    ["POST", /^\/admin\/team\/staff$/, "Added someone to the team"],
    ["PATCH", /^\/admin\/team\/staff\/[^/]+$/, "Changed someone's role"],
    ["DELETE", /^\/admin\/team\/staff\/[^/]+$/, "Removed someone from the team"],
    ["POST", /^\/admin\/team\/invites$/, "Invited someone to the team"],
    ["DELETE", /^\/admin\/team\/invites\/[^/]+$/, "Withdrew an invitation"],
    ["POST", /^\/admin\/team\/sessions\/[^/]+\/sign-out$/, "Signed an admin out everywhere"],
    ["POST", /^\/admin\/support\/[^/]+\/messages$/, "Replied to a customer"],
    ["PATCH", /^\/admin\/support\/[^/]+$/, "Changed a ticket's status"],
    ["POST", /^\/admin\/insights\/expenses$/, "Recorded an expense"],
    ["DELETE", /^\/admin\/insights\/expenses\/[^/]+$/, "Removed an expense"],
    ["POST", /^\/admin\/reconciliation/, "Ran a reconciliation"],
    ["POST", /^\/admin\/suspense/, "Resolved a suspense entry"],
    ["POST", /^\/admin\/conversions/, "Acted on a GHS conversion"],
    ["POST", /^\/admin\/webhooks/, "Replayed a webhook"],
    ["PUT", /^\/features\/admin\/users\/[^/]+$/, "Changed a beta user"],
    ["PUT", /^\/users\/[^/]+\/approval$/, "Changed a user's approval limit"],
    ["PATCH", /^\/users\/[^/]+/, "Changed a user's account"],
    ["PUT", /^\/users\/[^/]+/, "Changed a user's account"],
    ["POST", /^\/users\/[^/]+/, "Acted on a user's account"],
    ["POST", /^\/kyc\//, "Reviewed a verification"],
    ["PATCH", /^\/kyc\//, "Reviewed a verification"],
    ["POST", /^\/transactions\/[^/]+\/(confirm|complete|approve)/, "Confirmed a manual payment"],
    ["POST", /^\/transactions\/[^/]+\/reject/, "Rejected a manual payment"],
    ["PATCH", /^\/transactions\//, "Changed a transaction"],
    ["POST", /^\/exchange-rates/, "Added an exchange rate"],
    ["PATCH", /^\/exchange-rates/, "Changed an exchange rate"],
    ["POST", /^\/partners/, "Added a marketplace partner"],
    ["PATCH", /^\/partners/, "Changed a marketplace partner"],
];

/** Admin requests that aren't actions (reading notifications, refreshing) */
const NOT_ACTIONS = [/^\/notifications\/read$/, /^\/logs/];

export const describeAction = (method: string, path: string) =>
    ACTIONS.find(([m, re]) => m === method && re.test(path))?.[2] ?? null;

/** A copy of the request body with secrets removed and size capped */
export const redactBody = (body: unknown): unknown => {
    const walk = (value: unknown, depth: number): unknown => {
        if (depth > 4) return "…";
        if (Array.isArray(value)) return value.slice(0, 50).map((v) => walk(v, depth + 1));
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET.test(k) ? "[removed]" : walk(v, depth + 1)]));
        }
        return typeof value === "string" && value.length > 300 ? `${value.slice(0, 300)}…` : value;
    };
    const cleaned = walk(body ?? null, 0);
    const text = JSON.stringify(cleaned ?? null);
    return text && text.length > MAX_BODY ? { truncated: text.slice(0, MAX_BODY) } : cleaned;
};

/** "Chrome on Windows", "Safari on iPhone"… from a user agent */
export const deviceOf = (ua?: string | null) => {
    if (!ua) return "Unknown device";
    const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /okhttp|Dart|Expo/i.test(ua) ? "App" : "Browser";
    const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "unknown system";
    return `${browser} on ${os}`;
};

/**
 * The admin activity log and where admins are signed in.
 */
class AdminActivityService {
    /** Records one admin action (called when the response is sent); never throws */
    async record(entry: { adminId: string; method: string; path: string; status: number; ipAddress?: string; userAgent?: string; body?: unknown }) {
        if (NOT_ACTIONS.some((re) => re.test(entry.path))) return;
        try {
            await exec().insert(adminActivity).values({
                adminId: entry.adminId,
                method: entry.method,
                path: entry.path.slice(0, 300),
                action: describeAction(entry.method, entry.path),
                status: entry.status,
                ipAddress: entry.ipAddress?.slice(0, 64) ?? null,
                userAgent: entry.userAgent?.slice(0, 300) ?? null,
                body: redactBody(entry.body) as any,
            });
        } catch (error: any) {
            logger.warn("Couldn't record admin activity", { path: entry.path, error: error?.message });
        }
    }

    /** Newest first; filter by admin and days (YYYY-MM-DD, Lagos); `before` pages back */
    async list(filter: { adminId?: string; from?: string; to?: string; before?: string; limit?: number }) {
        const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
        const day = (v?: string, end?: boolean) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${end ? "23:59:59.999" : "00:00:00.000"}+01:00`) : undefined);
        const from = day(filter.from);
        const to = day(filter.to, true);
        const before = filter.before && !Number.isNaN(Date.parse(filter.before)) ? new Date(filter.before) : undefined;
        const rows = await exec()
            .select({ a: adminActivity, firstName: users.firstName, lastName: users.lastName, email: users.email })
            .from(adminActivity)
            .innerJoin(users, eq(users.id, adminActivity.adminId))
            .where(and(
                filter.adminId && isUuid(filter.adminId) ? eq(adminActivity.adminId, filter.adminId) : undefined,
                from ? gte(adminActivity.createdAt, from) : undefined,
                to ? lte(adminActivity.createdAt, to) : undefined,
                before ? lt(adminActivity.createdAt, before) : undefined,
            ))
            .orderBy(desc(adminActivity.createdAt))
            .limit(limit + 1);
        return {
            items: rows.slice(0, limit).map((r) => ({
                id: r.a.id,
                at: r.a.createdAt,
                admin: { id: r.a.adminId, name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email, email: r.email },
                action: r.a.action ?? `${r.a.method} ${r.a.path}`,
                method: r.a.method,
                path: r.a.path,
                ok: r.a.status < 400,
                status: r.a.status,
                ipAddress: r.a.ipAddress,
                device: deviceOf(r.a.userAgent),
                body: r.a.body,
            })),
            hasMore: rows.length > limit,
        };
    }

    /**
     * Where each admin is signed in now: one live session per refresh token
     * that hasn't been used up, revoked or expired, with its device and IP.
     */
    async sessions() {
        const admins = await exec().select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email, adminRoleId: users.adminRoleId, lastLogin: users.lastLogin, validAfter: users.sessionsValidAfter })
            .from(users).where(eq(users.role, ROLE_MAP.ADMIN));
        const ids = admins.map((a) => a.id);
        const live = ids.length
            ? await exec().select().from(refreshTokens)
                .where(and(inArray(refreshTokens.userId, ids), eq(refreshTokens.isRevoked, false), gt(refreshTokens.expiresAt, sql`now()`)))
                .orderBy(desc(refreshTokens.createdAt))
            : [];
        return admins.map((a) => {
            // Ended by "sign out everywhere" (or a password change): no longer live
            const after = a.validAfter ? new Date(a.validAfter).getTime() : 0;
            const mine = live.filter((t) => t.userId === a.id && new Date(t.createdAt).getTime() > after).map((t) => ({
                id: t.id,
                device: deviceOf(t.userAgent),
                ipAddress: t.ipAddress ?? null,
                // Needs an IP location lookup; not set up yet
                location: null as string | null,
                lastActiveAt: t.createdAt,
                expiresAt: t.expiresAt,
            }));
            return {
                id: a.id,
                name: [a.firstName, a.lastName].filter(Boolean).join(" ") || a.email,
                email: a.email,
                superAdmin: !a.adminRoleId,
                lastLogin: a.lastLogin ?? null,
                sessions: mine,
                devices: new Set(mine.map((s) => s.device)).size,
                ipAddresses: new Set(mine.map((s) => s.ipAddress).filter(Boolean)).size,
            };
        }).sort((x, y) => y.sessions.length - x.sessions.length || x.name.localeCompare(y.name));
    }

    /** Ends every session an admin has (they sign in again) */
    async signOutEverywhere(userId: string, by: string) {
        if (!isUuid(userId)) throw errorResponseMessage.resourceNotFound("Admin");
        const user = await userRepository.findById(userId);
        if (!user || user.role !== ROLE_MAP.ADMIN) throw errorResponseMessage.resourceNotFound("Admin");
        await userRepository.endAllSessions(userId);
        await exec().update(refreshTokens).set({ isRevoked: true, revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.isRevoked, false)));
        logger.info("Admin signed out everywhere by a super admin", { userId, by });
        return { id: userId };
    }
}

export default new AdminActivityService();
