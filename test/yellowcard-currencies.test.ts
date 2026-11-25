import { describe, expect, it, vi } from "vitest";
import yellowCardService from "../src/services/yellowcard.service";

describe("YellowCard currencies on offer", () => {
    it("lists each currency by the direction YellowCard has on, and leaves out the ones it can't be reached for", async () => {
        const spy = vi.spyOn(yellowCardService, "getCountryConfig").mockImplementation(async (country: string, currency: string) => {
            if (currency === "UGX") throw new Error("YellowCard unreachable");
            return {
                country, currency,
                // A direction is on only when YellowCard has it on and a channel is live that way
                send: currency !== "ZAR" && currency !== "MWK",
                receive: currency !== "XOF" && currency !== "MWK",
                sendMin: 0, sendMax: 0, receiveMin: 0, receiveMax: 0,
                channelTypes: currency === "MWK" ? [] : ["momo", "bank"],
                channels: currency === "MWK" ? { send: [], receive: [] } : { send: ["momo", "bank"], receive: ["momo", "bank"] },
            } as any;
        });
        const { send, receive } = await yellowCardService.flowCurrencies();
        expect(send).toEqual(["KES", "XAF", "TZS", "XOF", "RWF", "BWP", "ZMW", "CDF"]);
        expect(receive).toEqual(["KES", "XAF", "ZAR", "TZS", "RWF", "BWP", "ZMW", "CDF"]);
        spy.mockRestore();
    });

    it("says why a currency is missing", async () => {
        const spy = vi.spyOn(yellowCardService, "getCountryConfig").mockImplementation(async (country: string, currency: string) => {
            if (currency === "UGX") throw Object.assign(new Error("boom"), { response: { status: 403, data: { message: "Forbidden" } } });
            const none = currency === "MWK";
            return { country, currency, send: !none, receive: !none, sendMin: 0, sendMax: 0, receiveMin: 0, receiveMax: 0, channelTypes: none ? [] : ["bank"], channels: { send: none ? [] : ["bank"], receive: none ? [] : ["bank"] } } as any;
        });
        const { unavailable } = await yellowCardService.flowCurrencies();
        expect(unavailable).toEqual({ UGX: "403: Forbidden", MWK: "no bank or mobile money channel is on either way" });
        spy.mockRestore();
    });

    it("reads the channel list when the country config can't be fetched", async () => {
        const svc: any = yellowCardService;
        const get = vi.spyOn(svc, "get").mockImplementation(async (path: any) => {
            if (path === "/country/config") throw Object.assign(new Error("nope"), { response: { status: 404 } });
            if (path === "/networks") return { networks: [{ id: "n1", status: "active", channelType: "momo" }, { id: "n2", status: "active", channelType: "bank" }] };
            return { channels: [
                { currency: "TZS", country: "TZ", rampType: "withdraw", channelType: "momo", status: "active", apiStatus: "active", min: 1000, max: 500000 },
                { currency: "TZS", country: "TZ", rampType: "withdraw", channelType: "bank", status: "active", min: 5000, max: 900000 },
                { currency: "TZS", country: "TZ", rampType: "deposit", channelType: "momo", status: "inactive", min: 1000, max: 500000 },
                { currency: "TZS", country: "TZ", rampType: "deposit", channelType: "eft", status: "active", min: 1, max: 2 },
            ] };
        });
        const config = await yellowCardService.getCountryConfig("TZ", "TZS");
        expect(config).toMatchObject({ send: true, receive: false, sendMin: 1000, sendMax: 900000, channelTypes: ["momo", "bank"], channels: { send: ["momo", "bank"], receive: [] } });
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

describe("which ways money moves, per direction", () => {
    it("takes send and receive methods from the live channels, so a country can receive by bank but not send", async () => {
        const svc: any = yellowCardService;
        const get = vi.spyOn(svc, "get").mockImplementation(async (path: any, params: any) => {
            if (path === "/country/config") return { currency: params.currency, send: "active", receive: "active", channelTypes: ["bank"] };
            if (path === "/networks") return { networks: [{ id: "absa", status: "active", channelType: "bank" }] };
            // South Africa today: its only send channel is switched off; receiving by bank works
            return { channels: [
                { currency: "ZAR", country: "ZA", rampType: "withdraw", channelType: "bank", status: "inactive", apiStatus: "inactive" },
                { currency: "ZAR", country: "ZA", rampType: "deposit", channelType: "bank", status: "active", apiStatus: "active" },
            ] };
        });
        const config = await yellowCardService.getCountryConfig("ZA", "ZAR");
        expect(config).toMatchObject({ send: false, receive: true, channels: { send: [], receive: ["bank"] } });
        get.mockRestore();
    });

    it("counts a way to pay only when YellowCard also lists somewhere to pay into (Malawi: banks on, but no banks listed)", async () => {
        const svc: any = yellowCardService;
        const get = vi.spyOn(svc, "get").mockImplementation(async (path: any, params: any) => {
            if (path === "/country/config") return { currency: params.currency, send: "active", receive: "active", channelTypes: ["bank", "momo"] };
            if (path === "/networks") return { networks: [{ id: "airtel", status: "active", channelType: "momo" }, { id: "tnm", status: "active", accountNumberType: "phone" }] };
            return { channels: ["withdraw", "deposit"].flatMap((rampType) => ["bank", "momo"].map((channelType) => ({ currency: "MWK", country: "MW", rampType, channelType, status: "active", apiStatus: "active" }))) };
        });
        const config = await yellowCardService.getCountryConfig("MW", "MWK");
        expect(config).toMatchObject({ send: true, receive: true, channels: { send: ["momo"], receive: ["momo"] } });
        get.mockRestore();
    });
});
