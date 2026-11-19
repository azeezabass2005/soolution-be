/**
 * Operational controls the admin sets: when manual payments run and at what
 * rate, and the switches that pause the platform. Stored on the platform
 * settings row (`operations`), read through platform-settings.service.
 */

export interface ManualConfig {
    /** Naira per one unit of each currency, for manual payments (e.g. { GHS: 121 }) */
    rates: Record<string, number>;
    /** Days manual payments run, 0 = Sunday … 6 = Saturday (Lagos time) */
    days: number[];
    /** Opening and closing time, "HH:MM" in Lagos time (WAT) */
    open: string;
    close: string;
    /** Days closed despite being a working day (public holidays), "YYYY-MM-DD" */
    closedDates: string[];
}

export interface PauseConfig {
    /** No money moves: sends, receives, funding, withdrawals and payment links stop */
    payments: boolean;
    /** Nobody but admins can sign in */
    logins: boolean;
    /** Optional note shown to users while paused */
    message: string;
}

export interface OperationsConfig {
    manual: ManualConfig;
    pause: PauseConfig;
}

export const DEFAULT_OPERATIONS: OperationsConfig = {
    manual: { rates: {}, days: [1, 2, 3, 4, 5], open: "08:00", close: "20:00", closedDates: [] },
    pause: { payments: false, logins: false, message: "" },
};

export class OperationsError extends Error {}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The stored config with defaults filled in */
export function withOperationDefaults(stored: unknown): OperationsConfig {
    const s = (stored && typeof stored === "object" ? stored : {}) as Partial<OperationsConfig>;
    return {
        manual: { ...DEFAULT_OPERATIONS.manual, ...(s.manual ?? {}) },
        pause: { ...DEFAULT_OPERATIONS.pause, ...(s.pause ?? {}) },
    };
}

/** Checks an admin's change and merges it into the current config (throws OperationsError) */
export function mergeOperations(current: OperationsConfig, patch: unknown): OperationsConfig {
    if (!patch || typeof patch !== "object") throw new OperationsError("Operations settings must be an object");
    const p = patch as { manual?: Partial<ManualConfig>; pause?: Partial<PauseConfig> };
    const next: OperationsConfig = { manual: { ...current.manual }, pause: { ...current.pause } };

    if (p.manual) {
        const m = p.manual;
        if (m.rates !== undefined) {
            if (!m.rates || typeof m.rates !== "object") throw new OperationsError("Manual rates must be a list of currency rates");
            const rates: Record<string, number> = {};
            for (const [code, value] of Object.entries(m.rates)) {
                if (!/^[A-Z]{3,4}$/.test(code)) throw new OperationsError(`${code} isn't a currency code`);
                if (value === null || value === undefined || (value as unknown) === "") continue;
                const n = Number(value);
                if (!(n > 0) || n > 1_000_000) throw new OperationsError(`Enter a manual ${code} rate above 0`);
                rates[code] = Math.round(n * 10_000) / 10_000;
            }
            next.manual.rates = rates;
        }
        if (m.days !== undefined) {
            if (!Array.isArray(m.days) || m.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
                throw new OperationsError("Choose the days manual payments run");
            }
            next.manual.days = [...new Set(m.days)].sort();
        }
        if (m.open !== undefined) {
            if (!TIME.test(String(m.open))) throw new OperationsError("Opening time must look like 08:00");
            next.manual.open = String(m.open);
        }
        if (m.close !== undefined) {
            if (!TIME.test(String(m.close))) throw new OperationsError("Closing time must look like 20:00");
            next.manual.close = String(m.close);
        }
        if (toMinutes(next.manual.close) <= toMinutes(next.manual.open)) {
            throw new OperationsError("Closing time must be after opening time");
        }
        if (m.closedDates !== undefined) {
            if (!Array.isArray(m.closedDates) || m.closedDates.some((d) => !DATE.test(String(d)))) {
                throw new OperationsError("Closed dates must look like 2026-12-25");
            }
            next.manual.closedDates = [...new Set(m.closedDates.map(String))].sort();
        }
    }

    if (p.pause) {
        if (p.pause.payments !== undefined) next.pause.payments = Boolean(p.pause.payments);
        if (p.pause.logins !== undefined) next.pause.logins = Boolean(p.pause.logins);
        if (p.pause.message !== undefined) next.pause.message = String(p.pause.message ?? "").trim().slice(0, 300);
    }
    return next;
}

/** Lagos is UTC+1 all year (no daylight saving) */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

/** The Lagos calendar date, weekday and minute of the day for a moment */
export function lagosClock(at: Date) {
    const local = new Date(at.getTime() + LAGOS_OFFSET_MS);
    return {
        ymd: local.toISOString().slice(0, 10),
        day: local.getUTCDay(),
        minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
    };
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "8am" / "8:30pm" */
const clockLabel = (hhmm: string) => {
    const h = Number(hhmm.slice(0, 2));
    const m = hhmm.slice(3, 5);
    const suffix = h < 12 ? "am" : "pm";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${m === "00" ? "" : `:${m}`}${suffix}`;
};

/** "Monday to Friday", "Monday, Wednesday and Friday", "every day" */
export function daysLabel(days: number[]): string {
    const sorted = [...days].sort();
    if (sorted.length === 7) return "every day";
    if (!sorted.length) return "no days";
    const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
    if (contiguous && sorted.length > 2) return `${DAY_NAMES[sorted[0]]} to ${DAY_NAMES[sorted[sorted.length - 1]]}`;
    const names = sorted.map((d) => DAY_NAMES[d]);
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "8am–8pm WAT, Monday to Friday" */
export function hoursLabel(manual: ManualConfig): string {
    return `${clockLabel(manual.open)}–${clockLabel(manual.close)} WAT, ${daysLabel(manual.days)}`;
}

export interface ManualWindow {
    open: boolean;
    /** When it next opens (null while open, or if no opening day is set) */
    opensAt: Date | null;
    hours: string;
}

/** Whether manual payments are running at `at`, and when they next open */
export function manualWindow(manual: ManualConfig, at: Date = new Date()): ManualWindow {
    const openMin = toMinutes(manual.open);
    const closeMin = toMinutes(manual.close);
    const isWorkingDay = (ymd: string, day: number) => manual.days.includes(day) && !manual.closedDates.includes(ymd);
    const now = lagosClock(at);
    const hours = hoursLabel(manual);

    if (isWorkingDay(now.ymd, now.day) && now.minutes >= openMin && now.minutes < closeMin) {
        return { open: true, opensAt: null, hours };
    }
    // The next working day's opening: later today if it's before opening, else the following days
    for (let ahead = 0; ahead <= 60; ahead++) {
        const dayStart = new Date(Date.UTC(Number(now.ymd.slice(0, 4)), Number(now.ymd.slice(5, 7)) - 1, Number(now.ymd.slice(8, 10)) + ahead));
        const ymd = dayStart.toISOString().slice(0, 10);
        const day = dayStart.getUTCDay();
        if (!isWorkingDay(ymd, day)) continue;
        if (ahead === 0 && now.minutes >= openMin) continue;
        return { open: false, opensAt: new Date(dayStart.getTime() + openMin * 60_000 - LAGOS_OFFSET_MS), hours };
    }
    return { open: false, opensAt: null, hours };
}

/** Where users are pointed when something is paused or on hold */
export const SUPPORT_CONTACT = { whatsapp: "+234 816 003 0330", email: "support@solutionpay.co" };
