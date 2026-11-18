// src/config/env.config.ts

import dotenv from 'dotenv';
import path from 'path';
import logger from '../utils/logger.utils';

/**
 * Environment configuration interface
 * @interface EnvConfig
 */
interface EnvConfig {
    /** Node environment (development, production, test) */
    NODE_ENV: string;
    /** Server port number */
    PORT: number;
    /** PostgreSQL connection string, e.g. postgres://user:pass@host:5432/db */
    DATABASE_URL: string;
    /** Use TLS for the database connection (managed databases usually need it) */
    DATABASE_SSL: boolean;
    /** Verify the database server's TLS certificate (turn off only for self-signed certs) */
    DATABASE_SSL_REJECT_UNAUTHORIZED: boolean;
    /** Maximum connections in the pool */
    DATABASE_POOL_MAX: number;
    /** Abort any single statement that runs longer than this (ms) */
    DATABASE_STATEMENT_TIMEOUT_MS: number;
    /** JWT secret key */
    JWT_SECRET: string;
    /** JWT token expiration time */
    JWT_EXPIRES_IN: string;
    /** API version */
    API_VERSION: string;
    /** Cors origin */
    CORS_ORIGIN: string;
    /** Cookie Domain */
    COOKIE_DOMAIN: string;
    /** Domains sign-in cookies used to be set on; they're cleared on sign-in and sign-out */
    LEGACY_COOKIE_DOMAINS: string[];
    /** Rate limit window in minutes */
    RATE_LIMIT_WINDOW_MS: number;
    /** Maximum requests per window */
    RATE_LIMIT_MAX: number;
    /** Redis URL for caching */
    REDIS_URL?: string;
    /** Log level */
    LOG_LEVEL: string;
    /** Log retention days */
    LOG_RETENTION_DAYS: number;
    /** R2 endpoint */
    R2_ENDPOINT: string;
    /** R2 access key id */
    R2_ACCESS_KEY_ID: string;
    /** R2 access key id */
    R2_SECRET_ACCESS_KEY: string;
    /** R2 bucket name */
    R2_BUCKET_NAME: string;
    /** R2 public url */
    R2_PUBLIC_URL: string;
    /** Payment related environment variables */
    FLUTTERWAVE_SECRET_HASH: string;
    FLUTTERWAVE_CLIENT_SECRET: string;
    FLUTTERWAVE_CLIENT_ID: string;

    /** Mail related credentials */
    MAIL_HOST: string;
    MAIL_PORT: string;
    MAIL_SECURE: string;
    MAIL_USERNAME: string;
    MAIL_PASSWORD: string;
    MAIL_FROM: string;
    EMAIL_TEMPLATES_PATH: string;
    ADMIN_EMAILS: string;
    ADMIN_PHONE_NUMBERS: string;
    FRONTEND_URL: string;

    /** KYC related environment variables  */
    SMILE_ID_PARTNER_ID: string;
    SMILE_ID_API_KEY: string;
    SMILE_ID_AUTH_TOKEN: string;
    SMILE_ID_TEST_LAMBDA_URL: string;
    SMILE_ID_PROD_LAMBDA_URL: string;
    SMILE_ID_CALLBACK_URL: string;
    SMILE_ID_SID_SERVER: string;
    /** Key for hashing BVNs (one BVN per account); falls back to JWT_SECRET. Changing it breaks the duplicate check for existing accounts. */
    IDENTITY_HASH_SECRET: string;
    /**
     * 32-byte key (64 hex characters) that encrypts users' BVN and NIN, which
     * YellowCard needs on every transfer. Required in production. Losing or
     * changing it makes stored numbers unreadable (users would re-enter them).
     */
    IDENTITY_ENCRYPTION_KEY: string;
    /** Check NINs with Smile ID (needs NIMC enterprise registration on the Smile ID account) */
    SMILE_ID_VERIFY_NIN: boolean;
    /** Sandbox only: don't fail on face match (Smile ID's test BVN carries a stand-in photo) */
    SMILE_ID_SANDBOX_SKIP_FACE_MATCH: boolean;
    /**
     * Refuse YellowCard transfers until the user's real KYC details are on file.
     * Defaults to on for the production YellowCard API and off for its sandbox,
     * where missing details fall back to placeholders.
     */
    YELLOWCARD_REQUIRE_KYC: boolean;

    /** YellowCard payment integration */
    YELLOWCARD_API_KEY: string;
    YELLOWCARD_SECRET_KEY: string;
    YELLOWCARD_WEBHOOK_SECRET: string;
    YELLOWCARD_BASE_URL: string;

    /** OGateway payment integration (Ghana instant send + receive) */
    OGATEWAY_API_KEY: string;
    OGATEWAY_WEBHOOK_SECRET: string;
    OGATEWAY_BASE_URL: string;
    OGATEWAY_CALLBACK_URL: string;
    OGATEWAY_STALE_AFTER_MINUTES: number;

    /** Paystack payment integration (Wallet funding & withdrawals) */
    PAYSTACK_SECRET_KEY: string;
    PAYSTACK_PUBLIC_KEY: string;
    PAYSTACK_BASE_URL: string;

    /** Fincra lab (admin-only, local exploration of NGN virtual accounts and fees) */
    FINCRA_LAB_ENABLED: boolean;
    FINCRA_ENV: 'sandbox' | 'live';
    FINCRA_SECRET_KEY: string;
    /** Public key (pk_…), sent as x-pub-key when creating checkout payment links */
    FINCRA_PUBLIC_KEY: string;
    FINCRA_BUSINESS_ID: string;
    /** Bank for users' NGN account numbers (Fincra's `channel`); Moniepoint unless set */
    FINCRA_VA_CHANNEL: string;
    /** Fincra portal → Settings → secret keys → webhook key; signs every webhook */
    FINCRA_WEBHOOK_SECRET: string;

    /** Spotflow lab (admin-only, local exploration of NGN/GHS virtual accounts); mode follows the key */
    SPOTFLOW_LAB_ENABLED: boolean;
    SPOTFLOW_SECRET_KEY: string;
    SPOTFLOW_BASE_URL: string;
    /** Signs Spotflow's webhooks (dashboard → Settings → API keys); not the secret key */
    SPOTFLOW_WEBHOOK_SECRET_KEY: string;
    /** Offer GHS one-time bank accounts to customers (needs Spotflow's webhook set up) */
    SPOTFLOW_GHS_ACCOUNTS_ENABLED: boolean;

    /** Daya lab (admin-only, local exploration of NGN funding accounts and USD/EUR virtual accounts); mode follows the key */
    DAYA_LAB_ENABLED: boolean;
    DAYA_SECRET_KEY: string;
    /** Optional override; otherwise sk_sandbox_ → api.sandbox.daya.co, sk_live_ → api.daya.co */
    DAYA_BASE_URL: string;

    /** How often the lab poller re-checks provider deposits and balances */
    LAB_POLL_SECONDS: number;
    /** How long an action in a lab tab keeps its account watched */
    LAB_WATCH_MINUTES: number;
}

/**
 * Load environment variables based on current NODE_ENV
 * @function loadEnvConfig
 * @returns {EnvConfig} Environment configuration object
 * @throws {Error} If a required secret is missing or too weak at boot time.
 */
const MIN_SECRET_LENGTH = 32;

const requireSecret = (name: string, value: string | undefined, { minLength = MIN_SECRET_LENGTH }: { minLength?: number } = {}): string => {
    if (!value || value.trim().length === 0) {
        throw new Error(`[env] ${name} is required but was not provided. Set it in your .env file before starting the server.`);
    }
    if (value.length < minLength) {
        throw new Error(`[env] ${name} must be at least ${minLength} characters long (got ${value.length}). Generate a secure value with \`openssl rand -hex 32\`.`);
    }
    return value;
};

const loadEnvConfig = (): EnvConfig => {
    const env = process.env.NODE_ENV || 'development';

    // Load environment-specific .env file
    const envPath = path.resolve(process.cwd(), `.env.${env}`);
    const defaultPath = path.resolve(process.cwd(), '.env');

    const envResult = dotenv.config({ path: envPath });
    const defaultResult = dotenv.config({ path: defaultPath });

    if (envResult.error && defaultResult.error) {
        logger.warn('No .env file found, using default values', {
            envPath,
            defaultPath
        });
    }

    // Fail fast on required secrets. Any server that boots must have a strong
    // JWT signing key — a fallback literal would let anyone forge tokens.
    const JWT_SECRET = requireSecret('JWT_SECRET', process.env.JWT_SECRET);

    const config = {
        NODE_ENV: env,
        PORT: parseInt(process.env.PORT || '3500', 10),
        DATABASE_URL: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/solution_pay',
        DATABASE_SSL: process.env.DATABASE_SSL === 'true',
        DATABASE_SSL_REJECT_UNAUTHORIZED: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
        DATABASE_POOL_MAX: Math.max(1, parseInt(process.env.DATABASE_POOL_MAX || '10', 10) || 10),
        DATABASE_STATEMENT_TIMEOUT_MS: Math.max(1000, parseInt(process.env.DATABASE_STATEMENT_TIMEOUT_MS || '30000', 10) || 30000),
        JWT_SECRET,
        JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '1d',
        API_VERSION: process.env.API_VERSION || 'v1',
        CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
        COOKIE_DOMAIN: (process.env.COOKIE_DOMAIN || '').trim(),
        LEGACY_COOKIE_DOMAINS: (process.env.LEGACY_COOKIE_DOMAINS || '').split(',').map((d) => d.trim()).filter(Boolean),
        RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
        RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
        REDIS_URL: process.env.REDIS_URL,
        LOG_LEVEL: process.env.LOG_LEVEL || 'info',
        LOG_RETENTION_DAYS: parseInt(process.env.LOG_RETENTION_DAYS || '30', 10),
        R2_ENDPOINT: process.env.R2_ENDPOINT || "",
        R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || '',
        R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || '',
        R2_BUCKET_NAME: process.env.R2_BUCKET_NAME || "",
        R2_PUBLIC_URL: process.env.R2_PUBLIC_URL || '',
        FLUTTERWAVE_SECRET_HASH: process.env.FLUTTERWAVE_SECRET_HASH || '',
        FLUTTERWAVE_CLIENT_ID: process.env.FLUTTERWAVE_CLIENT_ID || '',
        FLUTTERWAVE_CLIENT_SECRET: process.env.FLUTTERWAVE_CLIENT_SECRET || '',
        MAIL_HOST: process.env.MAIL_HOST || '',
        MAIL_PORT: process.env.MAIL_PORT || '',
        MAIL_SECURE: process.env.MAIL_SECURE || '',
        MAIL_USERNAME: process.env.MAIL_USERNAME || '',
        MAIL_PASSWORD: process.env.MAIL_PASSWORD || '',
        MAIL_FROM: process.env.MAIL_FROM || '',
        EMAIL_TEMPLATES_PATH: process.env.EMAIL_TEMPLATES_PATH || '',
        ADMIN_EMAILS: process.env.ADMIN_EMAILS || 'azeezabass2005@gmail.com',
        ADMIN_PHONE_NUMBERS: process.env.ADMIN_PHONE_NUMBERS || "+2349160649124",
        FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
        SMILE_ID_PARTNER_ID: process.env.SMILE_ID_PARTNER_ID || '',
        SMILE_ID_API_KEY: process.env.SMILE_ID_API_KEY || '',
        SMILE_ID_AUTH_TOKEN: process.env.SMILE_ID_AUTH_TOKEN || '',
        SMILE_ID_TEST_LAMBDA_URL: process.env.SMILE_ID_TEST_LAMBDA_URL || '',
        SMILE_ID_PROD_LAMBDA_URL: process.env.SMILE_ID_PROD_LAMBDA_URL || '',
        SMILE_ID_CALLBACK_URL: process.env.SMILE_ID_CALLBACK_URL || '',
        SMILE_ID_SID_SERVER: process.env.SMILE_ID_SID_SERVER || '',
        IDENTITY_HASH_SECRET: process.env.IDENTITY_HASH_SECRET || process.env.JWT_SECRET || '',
        IDENTITY_ENCRYPTION_KEY: process.env.IDENTITY_ENCRYPTION_KEY || '',
        SMILE_ID_VERIFY_NIN: process.env.SMILE_ID_VERIFY_NIN === 'true',
        SMILE_ID_SANDBOX_SKIP_FACE_MATCH: process.env.SMILE_ID_SANDBOX_SKIP_FACE_MATCH === 'true' && (process.env.SMILE_ID_SID_SERVER || '').replace(/["'\s]/g, '') === '0',
        YELLOWCARD_REQUIRE_KYC: process.env.YELLOWCARD_REQUIRE_KYC !== undefined
            ? process.env.YELLOWCARD_REQUIRE_KYC === 'true'
            : !/sandbox/i.test(process.env.YELLOWCARD_BASE_URL || 'sandbox'),
        YELLOWCARD_API_KEY: process.env.YELLOWCARD_API_KEY || process.env.YELLOW_CARD_PUBLIC_KEY || '',
        YELLOWCARD_SECRET_KEY: process.env.YELLOWCARD_SECRET_KEY || process.env.YELLOW_CARD_SECRET_KEY || '',
        YELLOWCARD_WEBHOOK_SECRET: process.env.YELLOWCARD_WEBHOOK_SECRET || '',
        YELLOWCARD_BASE_URL: process.env.YELLOWCARD_BASE_URL || 'https://sandbox.api.yellowcard.io/business',

        // OGateway — Ghana instant send/receive
        OGATEWAY_API_KEY: process.env.OGATEWAY_API_KEY || '',
        OGATEWAY_WEBHOOK_SECRET: process.env.OGATEWAY_WEBHOOK_SECRET || '',
        OGATEWAY_BASE_URL: process.env.OGATEWAY_BASE_URL || 'https://api.ogateway.io',
        OGATEWAY_CALLBACK_URL: process.env.OGATEWAY_CALLBACK_URL || '',
        OGATEWAY_STALE_AFTER_MINUTES: parseInt(process.env.OGATEWAY_STALE_AFTER_MINUTES || '15', 10),

        // Paystack — wallet funding (DVA) & withdrawals (transfers)
        PAYSTACK_SECRET_KEY: process.env.PAYSTACK_SECRET_KEY || '',
        PAYSTACK_PUBLIC_KEY: process.env.PAYSTACK_PUBLIC_KEY || '',
        PAYSTACK_BASE_URL: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',

        // Fincra: NGN accounts, payouts and GHS payment links. The admin lab tab stays off
        // unless FINCRA_LAB_ENABLED; sandbox unless FINCRA_ENV=live
        FINCRA_LAB_ENABLED: process.env.FINCRA_LAB_ENABLED === 'true',
        FINCRA_ENV: (process.env.FINCRA_ENV === 'live' ? 'live' : 'sandbox') as 'sandbox' | 'live',
        FINCRA_SECRET_KEY: process.env.FINCRA_SECRET_KEY || '',
        FINCRA_PUBLIC_KEY: process.env.FINCRA_PUBLIC_KEY || '',
        FINCRA_WEBHOOK_SECRET: process.env.FINCRA_WEBHOOK_SECRET || '',
        FINCRA_BUSINESS_ID: process.env.FINCRA_BUSINESS_ID || '',
        FINCRA_VA_CHANNEL: (process.env.FINCRA_VA_CHANNEL || 'moniepoint').trim().toLowerCase(),

        // Spotflow lab — off unless explicitly enabled; sk_test_ / sk_live_ picks the mode
        SPOTFLOW_LAB_ENABLED: process.env.SPOTFLOW_LAB_ENABLED === 'true',
        SPOTFLOW_SECRET_KEY: process.env.SPOTFLOW_SECRET_KEY || '',
        SPOTFLOW_BASE_URL: process.env.SPOTFLOW_BASE_URL || 'https://api.spotflow.co/api/v1',
        SPOTFLOW_WEBHOOK_SECRET_KEY: process.env.SPOTFLOW_WEBHOOK_SECRET_KEY || '',
        SPOTFLOW_GHS_ACCOUNTS_ENABLED: process.env.SPOTFLOW_GHS_ACCOUNTS_ENABLED === 'true',
        // Daya lab — off unless explicitly enabled; sk_sandbox_ / sk_live_ picks the host
        DAYA_LAB_ENABLED: process.env.DAYA_LAB_ENABLED === 'true',
        DAYA_SECRET_KEY: process.env.DAYA_SECRET_KEY || '',
        DAYA_BASE_URL: process.env.DAYA_BASE_URL || '',
        LAB_POLL_SECONDS: Math.max(10, parseInt(process.env.LAB_POLL_SECONDS || '30', 10) || 30),
        LAB_WATCH_MINUTES: Math.max(1, parseInt(process.env.LAB_WATCH_MINUTES || '30', 10) || 30),
    };

    // Log configuration on startup
    logger.info('Environment configuration loaded', {
        environment: config.NODE_ENV,
        apiVersion: config.API_VERSION,
        logLevel: config.LOG_LEVEL
    });

    return config;
};

const config = loadEnvConfig();

export default config;