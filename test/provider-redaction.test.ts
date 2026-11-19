import { describe, expect, it } from "vitest";
import { redactProviders } from "../src/middlewares/provider-redaction.middleware";

describe("hiding provider names from customers", () => {
    it("leaves a checkout address alone, so the payer is sent to the real page", () => {
        const { body } = redactProviders({ data: { payment: { checkoutUrl: "https://checkout.fincra.com/pay/abc123", status: "processing" } } });
        expect(body.data.payment.checkoutUrl).toBe("https://checkout.fincra.com/pay/abc123");
    });

    it("still rewords a provider's name in messages", () => {
        const { body } = redactProviders({ message: "Fincra could not process this", data: { note: "Settled through Fincra" } });
        expect(body.message).not.toMatch(/fincra/i);
        expect(body.data.note).toBe("Settled through partner");
    });
});
