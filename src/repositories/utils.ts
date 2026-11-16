import { getDb, type Executor } from "../db/client";

/** The executor to use: the caller's transaction, or the pooled database */
export const exec = (tx?: Executor): Executor => tx ?? getDb();

/**
 * Drop NULL columns so an unset field reads as `undefined`, as it did with
 * Mongo. Only the top level is touched; JSON values are returned as stored.
 */
export function stripNulls<T extends Record<string, unknown>>(row: T): any {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
        const value = row[key];
        if (value !== null) out[key] = value;
    }
    return out;
}

/**
 * Turn a patch into column values for `.set()`: keys whose value is
 * `undefined` are skipped (left unchanged), `null` clears the column.
 */
export function definedOnly<T extends Record<string, unknown>>(patch: T): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
        if (patch[key] !== undefined) out[key] = patch[key];
    }
    return out as Partial<T>;
}

/** Uppercase + trim, as Mongoose's `uppercase: true, trim: true` did */
export const upper = (value: string | null | undefined): string | undefined =>
    typeof value === "string" ? value.trim().toUpperCase() : undefined;

export { isUuid } from "../utils/id.utils";

/** Escape LIKE/ILIKE wildcards so user input is matched literally */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** numeric aggregates come back as strings from node-postgres */
export const toNumber = (value: unknown): number => {
    if (value === null || value === undefined) return 0;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
};
