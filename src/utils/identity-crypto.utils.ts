import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import config from "../config/env.config";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import logger from "./logger.utils";

/**
 * Encryption for identity numbers we must keep (BVN, NIN: YellowCard needs
 * them on every transfer). AES-256-GCM with a key kept outside the database,
 * so a database copy alone reveals nothing. Stored as "v1:<iv>:<tag>:<data>".
 */
const VERSION = "v1";
let warned = false;

/** Quotes and spaces pasted into a hosting dashboard aren't part of the key */
const rawKey = () => (config.IDENTITY_ENCRYPTION_KEY || "").trim().replace(/^["']|["']$/g, "");

/** Why the configured key can't be used, if it can't */
const keyProblem = (): string | undefined => {
    const raw = rawKey();
    if (/^[0-9a-f]{64}$/i.test(raw)) return undefined;
    if (raw) return "IDENTITY_ENCRYPTION_KEY must be 64 hex characters (generate one with `openssl rand -hex 32`)";
    if (config.NODE_ENV === "production") return "IDENTITY_ENCRYPTION_KEY is not set; identity numbers can't be stored";
    return undefined;
};

// Say so at startup rather than on the first user's verification
const startupProblem = keyProblem();
if (startupProblem) logger.error(`${startupProblem}. Identity verification and cross-border transfers will fail until it's set.`);

const key = (): Buffer => {
    const problem = keyProblem();
    if (problem) {
        logger.error(problem);
        throw errorResponseMessage.createError(500, "Identity verification is temporarily unavailable on our side. Please try again later.", ErrorSeverity.HIGH, { code: "IDENTITY_UNAVAILABLE" });
    }
    const raw = rawKey();
    if (raw) return Buffer.from(raw, "hex");
    // Development and tests only: a key derived from the hash secret
    if (!warned) {
        warned = true;
        logger.warn("IDENTITY_ENCRYPTION_KEY is not set; using a development key. Set it before going live.");
    }
    return createHash("sha256").update(`identity-encryption:${config.IDENTITY_HASH_SECRET}`).digest();
};

export const encryptIdentity = (value: string): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key(), iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
};

export const decryptIdentity = (stored: string): string => {
    const [version, iv, tag, data] = stored.split(":");
    if (version !== VERSION || !iv || !tag || !data) throw new Error("Unreadable identity value");
    const secret = key();
    try {
        const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(iv, "base64"));
        decipher.setAuthTag(Buffer.from(tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    } catch {
        // Encrypted with a different IDENTITY_ENCRYPTION_KEY (e.g. another environment sharing this database)
        logger.error("Couldn't decrypt an identity number: IDENTITY_ENCRYPTION_KEY differs from the key it was encrypted with");
        throw errorResponseMessage.createError(500, "Identity verification is temporarily unavailable on our side. Please try again later.", ErrorSeverity.HIGH, { code: "IDENTITY_UNAVAILABLE" });
    }
};
