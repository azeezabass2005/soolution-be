import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        emailService = { sendNotificationEmail: vi.fn(), sendWelcomeEmail: vi.fn(), verifyConnection: vi.fn(async () => true) };
        sendTransactionNotification = vi.fn();
        notifyAdmins = vi.fn();
        sendNotification = vi.fn();
        initializeWhatsApp = vi.fn();
    },
}));

import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { bootstrapLedger, createUser } from "./helpers/fixtures";
import yellowCardService from "../src/services/yellowcard.service";
import beneficiaryService from "../src/services/beneficiary.service";
import dashboardService from "../src/services/dashboard.service";
import { ycCountryFor } from "../src/common/payment-link.constants";
import { lagosDayRange } from "../src/utils/date-range.utils";
import { exec } from "../src/repositories/utils";
import { transactions } from "../src/db/schema";

describe("CFA franc countries", () => {
    it("uses the country asked for only when it shares the currency", () => {
        expect(ycCountryFor("XOF", "ci")).toBe("CI");
        expect(ycCountryFor("XOF")).toBe("SN");
        // Cameroon doesn't use XOF, and Kenya only has KES
        expect(ycCountryFor("XOF", "CM")).toBe("SN");
        expect(ycCountryFor("KES", "TZ")).toBe("KE");
        expect(ycCountryFor("XAF", "GA")).toBe("GA");
    });

    it("lists each CFA country YellowCard has on, next to the one-country currencies", async () => {
        const on: Record<string, { send: boolean; receive: boolean }> = {
            "SN:XOF": { send: true, receive: true },
            "CI:XOF": { send: true, receive: false },
            "CM:XAF": { send: true, receive: true },
            "GA:XAF": { send: false, receive: true },
        };
        const spy = vi.spyOn(yellowCardService, "getCountryConfig").mockImplementation(async (country: string, currency: string) => {
            const known = on[`${country}:${currency}`];
            if (["XOF", "XAF"].includes(currency) && !known) throw new Error("not offered here");
            return {
                country, currency,
                send: known?.send ?? true, receive: known?.receive ?? true,
                sendMin: 0, sendMax: 0, receiveMin: 0, receiveMax: 0, channelTypes: ["momo"],
            };
        });
        const { send, receive, markets } = await yellowCardService.flowCurrencies();
        expect(send.filter((c) => c === "XOF")).toHaveLength(1);
        expect(receive).toContain("XAF");
        const pick = (list: { currency: string; country: string }[], currency: string) => list.filter((m) => m.currency === currency).map((m) => m.country);
        expect(pick(markets.send, "XOF")).toEqual(["SN", "CI"]);
        expect(pick(markets.receive, "XOF")).toEqual(["SN"]);
        expect(pick(markets.send, "XAF")).toEqual(["CM"]);
        expect(pick(markets.receive, "XAF")).toEqual(["CM", "GA"]);
        expect(pick(markets.send, "KES")).toEqual(["KE"]);
        spy.mockRestore();
    });
});

describe("with a database", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(async () => {
        await resetTestDatabase();
        await bootstrapLedger();
    });

    it("keeps a CFA recipient's country, so the same number can be saved for two countries", async () => {
        const user = await createUser();
        const base = { currency: "XOF", kind: "momo", momoNetwork: "Orange Money", momoNumber: "+2250701234567", momoName: "Awa Koné" };
        const ci = await beneficiaryService.create(user.id, { ...base, country: "CI" });
        expect(ci.country).toBe("CI");
        // Saving it again for Côte d'Ivoire is a duplicate; for Senegal it isn't
        await expect(beneficiaryService.create(user.id, { ...base, country: "CI" })).rejects.toMatchObject({ message: "You've already saved this beneficiary." });
        const sn = await beneficiaryService.create(user.id, { ...base, country: "SN" });
        expect(sn.country).toBe("SN");
        // A country that doesn't use XOF falls back to Senegal; non-CFA recipients keep none
        const kes = await beneficiaryService.create(user.id, { currency: "KES", kind: "momo", momoNetwork: "Mpesa", momoNumber: "+254712345678", momoName: "Wanjiru", country: "CI" });
        expect(kes.country ?? null).toBeNull();
    });

    it("narrows the admin dashboard to the dates picked", async () => {
        const user = await createUser();
        const at = async (iso: string, status: string) => {
            await exec().insert(transactions).values({
                user: user.id, reference: `D-${Math.random().toString(36).slice(2)}`, amount: 1_000, currency: "NGN", fromCurrency: "NGN",
                detailType: "fincra" as any, status: status as any, createdAt: new Date(iso),
            } as any);
        };
        // 00:30 in Lagos on the 20th is still the 19th in UTC: it belongs to the 20th
        await at("2026-11-19T23:30:00Z", "completed");
        await at("2026-11-21T10:00:00Z", "completed");
        await at("2026-11-21T11:00:00Z", "awaiting_confirmation");

        const all = await dashboardService.getAdminDashboard();
        expect(all.totalTransactions).toBe(3);

        const day20 = await dashboardService.getAdminDashboard(lagosDayRange("2026-11-20", "2026-11-20"));
        expect(day20).toMatchObject({ totalTransactions: 1, totalTransactionsCompleted: 1, pendingPayments: 0 });
        expect(day20.recentTransactions).toHaveLength(1);

        const day21 = await dashboardService.getAdminDashboard(lagosDayRange("2026-11-21", "2026-11-21"));
        expect(day21).toMatchObject({ totalTransactions: 2, totalTransactionsCompleted: 1, pendingPayments: 1, totalAmountInitiated: 2_000 });

        // The user signed up today, so no one signed up on the 20th
        expect(day20.totalUsers).toBe(0);
    });
});
