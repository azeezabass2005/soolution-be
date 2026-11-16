// Runs before any test module is imported, so env.config.ts sees these values.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "test-jwt-secret-that-is-at-least-32-characters-long";
process.env.IDENTITY_HASH_SECRET ||= "test-identity-hash-secret-0123456789abcdef";
process.env.IDENTITY_ENCRYPTION_KEY ||= "0".repeat(64);
process.env.LOG_LEVEL ||= "error";
process.env.ADMIN_EMAILS ||= "admin@example.test";
process.env.ADMIN_PHONE_NUMBERS ||= "";

import "../src/polyfills";

// Quiet test output (set TEST_LOGS=true to see the app's logs)
import logger from "../src/utils/logger.utils";
if (process.env.TEST_LOGS !== "true") logger.silent = true;
