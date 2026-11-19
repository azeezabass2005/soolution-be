import { describe, expect, it } from "vitest";
import { DEFAULT_OPERATIONS, OperationsError, hoursLabel, manualWindow, mergeOperations } from "../src/common/operations";

/** A moment given in Lagos time (UTC+1) */
const lagos = (iso: string) => new Date(new Date(`${iso}Z`).getTime() - 60 * 60 * 1000);
const manual = DEFAULT_OPERATIONS.manual; // Monday–Friday, 08:00–20:00

describe("manual payment hours", () => {
    it("is open on a weekday between 8am and 8pm Lagos time", () => {
        expect(manualWindow(manual, lagos("2026-11-18T08:00:00")).open).toBe(true);   // Wednesday
        expect(manualWindow(manual, lagos("2026-11-18T19:59:00")).open).toBe(true);
    });

    it("is closed before opening, after closing and at weekends, and says when it reopens", () => {
        const early = manualWindow(manual, lagos("2026-11-18T07:59:00"));
        expect(early.open).toBe(false);
        expect(early.opensAt?.toISOString()).toBe(lagos("2026-11-18T08:00:00").toISOString());

        const late = manualWindow(manual, lagos("2026-11-18T20:00:00"));
        expect(late.opensAt?.toISOString()).toBe(lagos("2026-11-19T08:00:00").toISOString());

        const friday = manualWindow(manual, lagos("2026-11-20T21:00:00"));
        expect(friday.opensAt?.toISOString()).toBe(lagos("2026-11-23T08:00:00").toISOString()); // Monday
    });

    it("stays closed on the admin's closed dates", () => {
        const holiday = { ...manual, closedDates: ["2026-12-25"] };
        const christmas = manualWindow(holiday, lagos("2026-12-25T10:00:00"));
        expect(christmas.open).toBe(false);
        expect(christmas.opensAt?.toISOString()).toBe(lagos("2026-12-28T08:00:00").toISOString());
    });

    it("describes the hours", () => {
        expect(hoursLabel(manual)).toBe("8am–8pm WAT, Monday to Friday");
        expect(hoursLabel({ ...manual, days: [1, 3, 5], open: "09:30", close: "17:00" })).toBe("9:30am–5pm WAT, Monday, Wednesday and Friday");
    });
});

describe("saving operations settings", () => {
    it("keeps what isn't changed and checks what is", () => {
        const next = mergeOperations(DEFAULT_OPERATIONS, { manual: { rates: { GHS: "121.5" }, closedDates: ["2026-12-25", "2026-12-25"] }, pause: { payments: true } });
        expect(next.manual).toMatchObject({ rates: { GHS: 121.5 }, closedDates: ["2026-12-25"], days: [1, 2, 3, 4, 5], open: "08:00" });
        expect(next.pause).toMatchObject({ payments: true, logins: false });
    });

    it("refuses bad input", () => {
        expect(() => mergeOperations(DEFAULT_OPERATIONS, { manual: { open: "8am" } })).toThrow(OperationsError);
        expect(() => mergeOperations(DEFAULT_OPERATIONS, { manual: { open: "20:00", close: "08:00" } })).toThrow("Closing time must be after opening time");
        expect(() => mergeOperations(DEFAULT_OPERATIONS, { manual: { rates: { GHS: -1 } } })).toThrow(OperationsError);
        expect(() => mergeOperations(DEFAULT_OPERATIONS, { manual: { days: [7] } })).toThrow(OperationsError);
    });
});
