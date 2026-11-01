import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import config from "../config/env.config";
import logger from "./logger.utils";

/**
 * Encryption for identity numbers we must keep (BVN, NIN: YellowCard needs
 * them on every transfer). AES-256-GCM with a key kept outside the database,
 * so a database copy alone reveals nothing. Stored as "v1:<iv>:<tag>:<data>".
 */
const VERSION = "v1";
let warned = false;

const key = (): Buffer => {
    const raw = (config.IDENTITY_ENCRYPTION_KEY || "").trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
    if (raw) throw new Error("IDENTITY_ENCRYPTION_KEY must be 64 hex characters (generate one with `openssl rand -hex 32`)");
    if (config.NODE_ENV === "production") {
        throw new Error("IDENTITY_ENCRYPTION_KEY is not set; identity numbers can't be stored");
    }
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
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
};
