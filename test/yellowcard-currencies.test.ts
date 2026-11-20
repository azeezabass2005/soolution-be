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
});
