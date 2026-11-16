const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `JSON.stringify` replacer (installed as Express's "json replacer") that
 * gives every record with a UUID `id` an `_id` alias. Mongo responses always
 * carried `_id`, and the frontend reads `item._id || item.id` in places.
 */
export function addLegacyIdAliases(this: unknown, _key: string, value: unknown): unknown {
    if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Date) &&
        typeof (value as { id?: unknown }).id === "string" &&
        UUID_RE.test((value as { id: string }).id) &&
        !Object.prototype.hasOwnProperty.call(value, "_id")
    ) {
        return { _id: (value as { id: string }).id, ...(value as Record<string, unknown>) };
    }
    return value;
}
