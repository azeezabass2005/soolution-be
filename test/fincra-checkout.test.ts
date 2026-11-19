import { describe, expect, it, vi } from "vitest";
import fincraService, { FINCRA_CHECKOUT_METHODS, FincraError } from "../src/services/fincra.service";

describe("Fincra checkout", () => {
    const input = {
        currency: "GHS" as const, amount: 40, customer: { name: "Christabel Assuming", email: "c@example.test" },
        feeBearer: "business" as const, reference: "GHS-1",
    };

    it("asks for mobile money only for GHS", () => {
        expect(FINCRA_CHECKOUT_METHODS.GHS).toEqual(["mobile_money"]);
    });

    it("retries without a method Fincra says isn't available", async () => {
        const request = vi.spyOn(fincraService as any, "request")
            .mockRejectedValueOnce(new FincraError("bank_transfer is not available for GHS", 400))
            .mockResolvedValueOnce({ data: { link: "https://checkout.fincra.com/pay/x", reference: "fcr-1" } });
        const out = await fincraService.createCheckout({ ...input, paymentMethods: ["mobile_money", "bank_transfer"] });
        expect(out.link).toBe("https://checkout.fincra.com/pay/x");
        expect(request).toHaveBeenCalledTimes(2);
        expect((request.mock.calls[1][2] as any).body.paymentMethods).toEqual(["mobile_money"]);
        request.mockRestore();
    });

    it("doesn't retry other errors, or when nothing would be left", async () => {
        const request = vi.spyOn(fincraService as any, "request").mockRejectedValue(new FincraError("mobile_money is not available for GHS", 400));
        await expect(fincraService.createCheckout({ ...input, paymentMethods: ["mobile_money"] })).rejects.toThrow("mobile_money is not available");
        expect(request).toHaveBeenCalledTimes(1);
        request.mockRestore();
    });
});
