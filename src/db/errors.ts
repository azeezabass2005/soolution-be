/**
 * Postgres error helpers. Drizzle wraps driver errors in DrizzleQueryError
 * (whose message contains the SQL and its parameters), so always inspect the
 * `cause` chain and never surface the wrapper's message to clients.
 */

export const PG_ERROR = {
    UNIQUE_VIOLATION: "23505",
    FOREIGN_KEY_VIOLATION: "23503",
    NOT_NULL_VIOLATION: "23502",
    CHECK_VIOLATION: "23514",
    INVALID_TEXT_REPRESENTATION: "22P02",
    SERIALIZATION_FAILURE: "40001",
    DEADLOCK_DETECTED: "40P01",
} as const;

export interface PgErrorInfo {
    code: string;
    constraint?: string;
    detail?: string;
    table?: string;
    column?: string;
}

/** The underlying Postgres error, if `error` is (or wraps) one */
export function pgError(error: unknown): PgErrorInfo | null {
    let current: any = error;
    for (let depth = 0; current && depth < 5; depth++) {
        if (typeof current.code === "string" && /^[0-9A-Z]{5}$/.test(current.code)) {
            return {
                code: current.code,
                constraint: current.constraint,
                detail: current.detail,
                table: current.table,
                column: current.column,
            };
        }
        current = current.cause;
    }
    return null;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
    const info = pgError(error);
    return !!info && info.code === PG_ERROR.UNIQUE_VIOLATION && (!constraint || info.constraint === constraint);
}

export function isCheckViolation(error: unknown, constraint?: string): boolean {
    const info = pgError(error);
    return !!info && info.code === PG_ERROR.CHECK_VIOLATION && (!constraint || info.constraint === constraint);
}

export function isRetryableTransactionError(error: unknown): boolean {
    const code = pgError(error)?.code;
    return code === PG_ERROR.SERIALIZATION_FAILURE || code === PG_ERROR.DEADLOCK_DETECTED;
}
