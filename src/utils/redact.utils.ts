/**
 * Field names whose values never go into logs: passwords, PINs, sign-in and
 * reset codes, tokens, secrets, and identity numbers.
 */
const SENSITIVE_KEY = /pass(word)?|pin$|^pin|otp|^code$|token|secret|authorization|cookie|cvv|signature|apikey|api_key|^(bvn|nin)(number)?$/i;

/** A copy of `value` with sensitive fields replaced, for logging */
export function redactForLog(value: unknown, depth = 0): unknown {
    if (value === null || typeof value !== "object") return value;
    if (depth > 6) return "[nested]";
    if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        out[key] = SENSITIVE_KEY.test(key) && v !== undefined && v !== null && v !== "" ? "[redacted]" : redactForLog(v, depth + 1);
    }
    return out;
}
