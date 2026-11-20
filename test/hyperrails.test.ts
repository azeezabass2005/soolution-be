import { afterEach, describe, expect, it, vi } from "vitest";
import config from "../src/config/env.config";
import hyperRailsService, { HyperRailsError } from "../src/services/hyperrails.service";

const client = (hyperRailsService as any).client;
const notFound = () => Object.assign(new Error("404"), { response: { status: 404, data: { errorMessage: "Not found" } } });

describe("HyperRails client", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        (config as any).HYPERRAILS_SECRET_KEY = "";
    });

    it("refuses to call without a secret key, or with the wrong kind of key", async () => {
        await expect(hyperRailsService.balances()).rejects.toMatchObject({ status: 503 });
        (config as any).HYPERRAILS_SECRET_KEY = "pk_test_abc";
        await expect(hyperRailsService.balances()).rejects.toMatchObject({ status: 400 });
    });

    it("sends the bearer key and service header, and reads the mode from the key", async () => {
        (config as any).HYPERRAILS_SECRET_KEY = "sk_test_abc";
        expect(hyperRailsService.mode).toBe("test");
        const request = vi.spyOn(client, "request").mockResolvedValue({ data: [{ accountId: "a1", currency: "GHS", balance: 5, availableBalance: 5 }] });
        const rows = await hyperRailsService.balances();
        expect(rows).toHaveLength(1);
        expect(request.mock.calls[0][0]).toMatchObject({
            method: "get",
            url: "/api/v1/partners/balances",
            headers: { Authorization: "Bearer sk_test_abc", "x-service-source": "SolutionPay" },
        });
    });

    it("tries the other documented path when HyperRails says 404", async () => {
        (config as any).HYPERRAILS_SECRET_KEY = "sk_test_abc";
        const request = vi.spyOn(client, "request")
            .mockRejectedValueOnce(notFound())
            .mockResolvedValueOnce({ data: [{ accountId: "a2", currency: "KES" }] });
        expect(await hyperRailsService.balances()).toEqual([{ accountId: "a2", currency: "KES" }]);
        expect(request.mock.calls.map((c: any) => c[0].url)).toEqual(["/api/v1/partners/balances", "/api/v1/balances"]);
    });

    it("prices on the exchange host and charges the payer's mobile money on accept", async () => {
        (config as any).HYPERRAILS_SECRET_KEY = "sk_test_abc";
        const request = vi.spyOn(client, "request")
            .mockResolvedValueOnce({ data: { quoteId: "q-1", status: "PENDING" } })
            .mockResolvedValueOnce({ data: { quoteId: "q-1", status: "AWAITING_PAYMENT", metadata: { mobileMoneyPayIn: { authorizationMode: "otp" } } } });
        const quote = await hyperRailsService.expressQuote({ sourceCurrency: "GHS", destinationCurrency: "NGN", amount: 5, amountDirection: "source", accountId: "ngn-1" });
        expect(quote.quoteId).toBe("q-1");
        const accepted = await hyperRailsService.acceptWithMobileMoney("q-1", { accountId: "ngn-1", countryCode: "GH", providerCode: "mtn", phoneNumber: "0244123456" });
        expect(accepted.status).toBe("AWAITING_PAYMENT");
        expect(request.mock.calls[0][0]).toMatchObject({ method: "post", url: "/exchange/api/v1/partners/marketplace/express/quote" });
        expect(request.mock.calls[1][0]).toMatchObject({
            method: "put",
            url: "/exchange/api/v1/partners/marketplace/quote/q-1/accept",
            data: { accountId: "ngn-1", payment: { channel: "mobile_money", countryCode: "GH", mobileMoney: { code: "mtn", phoneNumber: "0244123456" } } },
        });
    });

    it("passes HyperRails' own error message on", async () => {
        (config as any).HYPERRAILS_SECRET_KEY = "sk_test_abc";
        vi.spyOn(client, "request").mockRejectedValue(Object.assign(new Error("400"), { response: { status: 400, data: { errorMessage: "Unable to fulfill requested volume at the moment." } } }));
        const error = await hyperRailsService.rate("GHS", "NGN").catch((e) => e);
        expect(error).toBeInstanceOf(HyperRailsError);
        expect(error).toMatchObject({ status: 400, message: "Unable to fulfill requested volume at the moment." });
    });
});
