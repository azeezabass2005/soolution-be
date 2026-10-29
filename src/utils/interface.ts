/**
 * Interface for token payload data
 */
export interface ITokenPayload {
    userId: string;
    email: string;
    role: number;
    username: string;
    /** Password-reset tokens: fingerprint of the password they were issued against, so they work once */
    pfp?: string;
}

/**
 * Interface for verify token payload
 */
export interface IVerifyTokenPayload extends ITokenPayload {
    date: Date;
}

/**
 * Represents different token types
 */
export enum TokenType {
    ACCESS = 'access',
    VERIFY = 'verify',
    REFRESH = 'refresh',
    RESET = 'reset',
    RESET_PIN = 'reset_pin',
    /** Lets a newly registered user finish sign-up; not a session */
    REGISTRATION = 'registration'
}

/**
 * Interface for token creation options
 */
export interface ITokenOptions {
    type?: TokenType;
    expiresIn?: string;
    /** Refresh tokens only: whether the session should survive closing the browser */
    rememberMe?: boolean;
    /** Refresh tokens only: when the user last entered their password (ms) */
    sessionStartedAt?: number;
    /** Reset tokens only: fingerprint of the current password */
    passwordFingerprint?: string;
}

export interface IRefreshTokenPayload extends ITokenPayload {
    tokenId: string;
    /** Absent on tokens issued before "keep me signed in" existed; treated as true */
    rememberMe?: boolean;
    /** When the user last entered their password (ms); caps how long refreshing can keep them in */
    sessionStartedAt?: number;
}