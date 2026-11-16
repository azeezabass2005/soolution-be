import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, PricingError, applyFeeRule, applyRateRule, parsePricing, priceFees } from "../src/common/pricing";

describe("pricing rules", () => {
    it("works a fee as percent plus fixed, held between the minimum and the cap", () => {
        const fincra = { percent: 1, fixed: 0, min: 0, cap: 300 };
        expect(applyFeeRule(fincra, 10_000)).toBe(100);
        expect(applyFeeRule(fincra, 100_000)).toBe(300); // capped
        expect(applyFeeRule({ percent: 0.5, fixed: 20, min: 100, cap: 0 }, 1_000)).toBe(100); // raised to the minimum
        expect(applyFeeRule({ percent: 0, fixed: 500, min: 0, cap: 0 }, 300)).toBe(300); // never more than the amount
    });

    it("adds SolutionPay's fee to the provider's (funding charges only SolutionPay's)", () => {
        const rules = { providerFee: { percent: 1, fixed: 0, min: 0, cap: 300 }, platformFee: { percent: 0, fixed: 200, min: 0, cap: 0 } };
        expect(priceFees(rules, 50_000)).toMatchObject({ providerFee: 300, platformFee: 200, total: 500, effectivePercent: 1 });
        expect(priceFees(rules, 50_000, { providerFeeCharged: false })).toMatchObject({ total: 200 });
    });

    it("buffers the rate against the user in both directions", () => {
        const rule = { percent: 2, fixed: 1 };
        expect(applyRateRule(rule, 100, "send")).toBe(103);   // pays more NGN per GHS
        expect(applyRateRule(rule, 100, "receive")).toBe(97); // gets less NGN per GHS
    });

    it("checks admin input and keeps what isn't sent", () => {
        const next = parsePricing({ send: { "NGN-GHS": { rate: { percent: 1.25, fixed: 0.5 } } } }, DEFAULT_PRICING);
        expect(next.send["NGN-GHS"].rate).toEqual({ percent: 1.25, fixed: 0.5 });
        expect(next.send["NGN-GHS"].providerFee).toEqual(DEFAULT_PRICING.send["NGN-GHS"].providerFee);
        expect(next.funding).toEqual(DEFAULT_PRICING.funding);
        expect(() => parsePricing({ withdrawal: { NGN: { platformFee: { percent: 0, fixed: 0, min: 500, cap: 100 } } } }, DEFAULT_PRICING)).toThrow(PricingError);
        expect(() => parsePricing({ send: { "naira": {} } }, DEFAULT_PRICING)).toThrow(PricingError);
        expect(() => parsePricing({ send: { "NGN-GHS": { rate: { percent: -1, fixed: 0 } } } }, DEFAULT_PRICING)).toThrow(PricingError);
    });
});
