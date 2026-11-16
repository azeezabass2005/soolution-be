const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True for a well-formed UUID (what `ObjectId.isValid` used to check for ids) */
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);
