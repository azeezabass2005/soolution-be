/**
 * Identity verification (BVN with Smile ID) that moves a user from
 * Unverified to Tier 1.
 */

export const IDENTITY_STATUS = {
    UNVERIFIED: "unverified",
    PENDING: "pending",
    VERIFIED: "verified",
    FAILED: "failed",
} as const;

export type IdentityStatus = (typeof IDENTITY_STATUS)[keyof typeof IDENTITY_STATUS];

export const IDENTITY_STATUSES: IdentityStatus[] = Object.values(IDENTITY_STATUS);

/** Error code the frontend uses to open BVN verification */
export const IDENTITY_REQUIRED_CODE = "IDENTITY_REQUIRED";

/** Failed attempts allowed per rolling 24 hours (each attempt is a paid Smile ID job) */
export const BVN_MAX_FAILED_ATTEMPTS = 3;
export const BVN_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A check with no result after this long is treated as abandoned and can be retried */
export const BVN_PENDING_TIMEOUT_MS = 30 * 60 * 1000;

/** Ask Smile ID for the result ourselves if the webhook hasn't arrived after this long, at most this often */
export const BVN_POLL_AFTER_MS = 60 * 1000;
export const BVN_POLL_INTERVAL_MS = 20 * 1000;

/** Images from the selfie capture: at most this many, each at most ~5MB (base64) */
export const BVN_MAX_IMAGES = 10;
export const BVN_MAX_IMAGE_CHARS = 7 * 1024 * 1024;

export const isBvn = (value: unknown): value is string => typeof value === "string" && /^\d{11}$/.test(value);
