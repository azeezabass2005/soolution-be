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
    /** MongoDB connection URI */
    MONGODB_URI: string;
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
}

/**
 * Load environment variables based on current NODE_ENV
 * @function loadEnvConfig
 * @returns {EnvConfig} Environment configuration object
 */
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

    const config = {
        NODE_ENV: env,
        PORT: parseInt(process.env.PORT || '3500', 10),
        MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/your-db-name',
        JWT_SECRET: process.env.JWT_SECRET || 'your-super-secret-key',
        JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '1d',
        API_VERSION: process.env.API_VERSION || 'v1',
        CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
        COOKIE_DOMAIN: process.env.COOKIE_DOMAIN || 'http://localhost:3000',
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
        FLUTTERWAVE_SECRET_HASH: process.env.FLUTTERWAVE_SECRET_HASH || 'lj3dfd4k5df5jld9ied3fn7df487rn2df',
        FLUTTERWAVE_CLIENT_ID: process.env.FLUTTERWAVE_CLIENT_ID || '1234',
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