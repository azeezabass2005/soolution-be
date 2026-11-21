import { describe, expect, it, vi } from "vitest";
import yellowCardService from "../src/services/yellowcard.service";

describe("YellowCard currencies on offer", () => {
    it("lists each currency by the direction YellowCard has on, and leaves out the ones it can't be reached for", async () => {
        const spy = vi.spyOn(yellowCardService, "getCountryConfig").mockImplementation(async (country: string, currency: string) => {
            if (currency === "UGX") throw new Error("YellowCard unreachable");
            return {
                country, currency,
                send: currency !== "ZAR",
                receive: currency !== "XOF",
                sendMin: 0, sendMax: 0, receiveMin: 0, receiveMax: 0,
                channelTypes: currency === "MWK" ? [] : ["momo", "bank"],
            };
        });
        const { send, receive } = await yellowCardService.flowCurrencies();
        expect(send).toEqual(["KES", "XAF", "TZS", "XOF", "RWF", "BWP", "ZMW"]);
        expect(receive).toEqual(["KES", "XAF", "ZAR", "TZS", "RWF", "BWP", "ZMW"]);
        spy.mockRestore();
    });

    it("says why a currency is missing", async () => {
        const spy = vi.spyOn(yellowCardService, "getCountryConfig").mockImplementation(async (country: string, currency: string) => {
            if (currency === "UGX") throw Object.assign(new Error("boom"), { response: { status: 403, data: { message: "Forbidden" } } });
            return { country, currency, send: true, receive: true, sendMin: 0, sendMax: 0, receiveMin: 0, receiveMax: 0, channelTypes: currency === "MWK" ? [] : ["bank"] };
        });
        const { unavailable } = await yellowCardService.flowCurrencies();
        expect(unavailable).toEqual({ UGX: "403: Forbidden", MWK: "no bank or mobile money channel is on" });
        spy.mockRestore();
    });

    it("reads the channel list when the country config can't be fetched", async () => {
        const svc: any = yellowCardService;
        const get = vi.spyOn(svc, "get").mockImplementation(async (path: any) => {
            if (path === "/country/config") throw Object.assign(new Error("nope"), { response: { status: 404 } });
            return { channels: [
                { currency: "TZS", country: "TZ", rampType: "withdraw", channelType: "momo", status: "active", apiStatus: "active", min: 1000, max: 500000 },
                { currency: "TZS", country: "TZ", rampType: "withdraw", channelType: "bank", status: "active", min: 5000, max: 900000 },
                { currency: "TZS", country: "TZ", rampType: "deposit", channelType: "momo", status: "inactive", min: 1000, max: 500000 },
                { currency: "TZS", country: "TZ", rampType: "deposit", channelType: "eft", status: "active", min: 1, max: 2 },
            ] };
        });
        const config = await yellowCardService.getCountryConfig("TZ", "TZS");
        expect(config).toMatchObject({ send: true, receive: false, sendMin: 1000, sendMax: 900000, channelTypes: ["momo", "bank"] });
        get.mockRestore();
    });
});

describe("when YellowCard money arrives", () => {
    it("reads instant, same-day and next-day settlement", async () => {
        const { channelArrival } = await import("../src/services/yellowcard.service");
        expect(channelArrival({ settlementType: "instant", estimatedSettlementTime: 60 })).toBe("minutes");
        expect(channelArrival({ settlementType: "T+1" })).toBe("next_day");
        expect(channelArrival({ settlementType: "next_day" })).toBe("next_day");
        expect(channelArrival({ settlementType: "instant", estimatedSettlementTime: 86_400 })).toBe("next_day");
        expect(channelArrival({ estimatedSettlementTime: 4 * 60 * 60 })).toBe("same_day");
        expect(channelArrival({})).toBe("minutes");
    });
});
