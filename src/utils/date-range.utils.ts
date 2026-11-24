/** Lagos is UTC+1 all year (no daylight saving) */
const WAT_OFFSET_MS = 60 * 60 * 1000;

export interface DateRange {
    from?: Date;
    to?: Date;
}

/** "2026-11-24" → its parts, or null when it isn't a date */
const parseDay = (value: unknown): [number, number, number] | null => {
    if (typeof value !== "string") return null;
    const parts = value.split("-").map((p) => parseInt(p, 10));
    if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return null;
    return [parts[0], parts[1] - 1, parts[2]];
};

/**
 * YYYY-MM-DD start and end dates as a range of whole days in Lagos time
 * (WAT, UTC+1), so "today" is the admin's today. Undefined with no valid date.
 */
export const lagosDayRange = (startDate: unknown, endDate: unknown): DateRange | undefined => {
    const range: DateRange = {};
    const start = parseDay(startDate);
    if (start) range.from = new Date(Date.UTC(start[0], start[1], start[2], 0, 0, 0, 0) - WAT_OFFSET_MS);
    const end = parseDay(endDate);
    if (end) range.to = new Date(Date.UTC(end[0], end[1], end[2], 23, 59, 59, 999) - WAT_OFFSET_MS);
    return range.from || range.to ? range : undefined;
};
