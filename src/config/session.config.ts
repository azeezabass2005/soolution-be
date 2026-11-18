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
    /**
     * Signed out after this long without using the app. The browser enforces
     * it to the minute (it sees clicks and typing, which the server doesn't);
     * the refresh tokens below are the server's backstop.
     */
    IDLE_TIMEOUT_MS: 30 * MINUTE,
    /**
     * Refresh token lifetime, renewed on every refresh. The idle limit plus one
     * access token: a user active at the end of an access token's life still
     * has the full 30 minutes, and an abandoned session dies within 45.
     * "Keep me signed in" only decides whether the cookies survive closing the
     * browser; it never extends the idle limit.
     */
    REFRESH_TTL_MS: 45 * MINUTE,
    REMEMBERED_REFRESH_TTL_MS: 45 * MINUTE,
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
