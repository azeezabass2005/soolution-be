/**
 * Session lifetimes. Short-lived access tokens limit what a stolen token can
 * do; the refresh token keeps an active user signed in and is replaced on
 * every use.
 */
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SESSION = {
    /** Access token (JWT + cookie) */
    ACCESS_TTL_MS: 15 * MINUTE,
    /** Refresh token without "keep me signed in": the session ends after 12h of inactivity or when the browser closes */
    REFRESH_TTL_MS: 12 * HOUR,
    /** Refresh token with "keep me signed in": 7 days of inactivity */
    REMEMBERED_REFRESH_TTL_MS: 7 * DAY,
    /** Nobody stays signed in longer than this without entering their password again */
    MAX_SESSION_MS: 30 * DAY,
    /**
     * Two tabs can refresh with the same token at once. A token used again
     * within this window is a race, not theft, and the other tab just retries.
     */
    REFRESH_REUSE_GRACE_MS: 30 * 1000,
} as const;

/** Error codes the frontend acts on */
export const SESSION_CODE = {
    /** Another tab refreshed first; retry the request with the new cookies */
    REFRESH_RACED: "REFRESH_RACED",
    /** The session is over (expired, signed out everywhere, or a reused token) */
    SESSION_ENDED: "SESSION_ENDED",
} as const;
