import { NextFunction, Request, Response } from "express";
import { ROLE_MAP } from "../common/constant";
import { PROVIDER_NAME_PATTERN, mentionsProvider } from "../utils/provider-names.utils";
import logger from "../utils/logger.utils";

/**
 * Last line of defence: customers and payers never see which partners move
 * their money or check their identity. Every JSON response to anyone but an
 * admin goes through here. Messages should already be written without
 * provider names; anything that slips through is replaced and logged so the
 * source can be fixed.
 */

/** Provider error text and raw provider records, never needed by the app */
const DROP_KEYS = new Set(["providerMessage", "ycError", "ogError", "ogRawPayload", "rawPayload", "smileJobId", "providerAccountCode"]);

/** Internal codes that name a provider (identity.method "smile_id_bvn"): dropped, not reworded */
const DROP_WHEN_NAMED = new Set(["method", "accountCode"]);

/**
 * Names people and banks really have, kept as they are: a bank can carry a
 * provider's name ("Paystack-Titan MFB"), and so can someone's own entry.
 */
const VERBATIM_KEYS = new Set(["name", "accountName", "bankName", "momoName", "alipayName", "firstName", "lastName", "email"]);

/** The few fields of YellowCard's record the app shows (rate, fee, destination) */
const pickYellowCardPayload = (raw: any) => {
    if (!raw || typeof raw !== "object") return undefined;
    const dest = raw.destination && typeof raw.destination === "object" ? raw.destination : undefined;
    return {
        rate: raw.rate,
        currency: raw.currency,
        country: raw.country,
        serviceFeeAmountLocal: raw.serviceFeeAmountLocal,
        ...(dest ? { destination: { accountName: dest.accountName, accountNumber: dest.accountNumber, networkName: dest.networkName } } : {}),
    };
};

/** Enum values the app branches on (e.g. detailType "yellowcard"); not shown as text */
const ENUM_KEYS = new Set(["detailType", "type"]);

/** Customer-facing text fields: replaced as a whole when they name a provider */
const TEXT_FALLBACK: Record<string, string> = {
    message: "Something went wrong. Please try again in a few minutes.",
    error: "Something went wrong. Please try again in a few minutes.",
    failureReason: "The transaction couldn't be completed.",
    reason: "The transaction couldn't be completed.",
    cancelReason: "The transaction was cancelled.",
    description: "Transaction",
};

const scrubString = (key: string, value: string, path: string, hits: string[]): string => {
    if (ENUM_KEYS.has(key) || VERBATIM_KEYS.has(key) || !mentionsProvider(value)) return value;
    hits.push(path);
    return TEXT_FALLBACK[key] ?? value.replace(new RegExp(PROVIDER_NAME_PATTERN.source, "gi"), "partner");
};

const scrub = (value: any, key: string, path: string, hits: string[]): any => {
    if (typeof value === "string") return scrubString(key, value, path, hits);
    if (Array.isArray(value)) return value.map((v, i) => scrub(v, key, `${path}[${i}]`, hits));
    if (!value || typeof value !== "object") return value;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
        // Raw provider records, and fields named after a provider (paystackReference, ...)
        if (DROP_KEYS.has(k) || PROVIDER_NAME_PATTERN.test(k)) continue;
        if (DROP_WHEN_NAMED.has(k) && mentionsProvider(v)) continue;
        if (k === "ycRawPayload") {
            out[k] = scrub(pickYellowCardPayload(v), k, `${path}.${k}`, hits);
            continue;
        }
        out[k] = scrub(v, k, `${path}.${k}`, hits);
    }
    return out;
};

export const redactProviders = (body: any): { body: any; hits: string[] } => {
    const hits: string[] = [];
    if (body === undefined || body === null) return { body, hits };
    // Plain JSON first, so Mongoose documents and dates serialise as they would
    const plain = JSON.parse(JSON.stringify(body));
    return { body: scrub(plain, "", "$", hits), hits };
};

const providerRedaction = (req: Request, res: Response, next: NextFunction) => {
    const json = res.json.bind(res);
    res.json = (body?: any) => {
        if (res.locals.user?.role === ROLE_MAP.ADMIN) return json(body);
        const { body: safe, hits } = redactProviders(body);
        if (hits.length) {
            logger.warn("Provider name removed from a response; fix the source", { method: req.method, path: req.originalUrl, fields: hits.slice(0, 10) });
        }
        return json(safe);
    };
    next();
};

export default providerRedaction;
