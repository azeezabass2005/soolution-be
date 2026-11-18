import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, PricingError, applyFeeRule, applyRateRule, legacyNgnFeePairs, limitProblem, parsePricing, priceFees, priceFunding, withDefaults } from "../src/common/pricing";
import { pairFees } from "../src/services/ghs-rate.service";

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

    it("funding: the user pays 1% capped at ₦500 in total, SolutionPay keeps what Fincra doesn't", () => {
        const rules = DEFAULT_PRICING.funding.NGN;
        expect(priceFunding(rules, 20_000, 200)).toEqual({ customerTotal: 200, providerFee: 200, platformFee: 0 });
        expect(priceFunding(rules, 40_000, 300)).toEqual({ customerTotal: 400, providerFee: 300, platformFee: 100 });
        expect(priceFunding(rules, 1_000_000, 300)).toEqual({ customerTotal: 500, providerFee: 300, platformFee: 200 });
        // Fincra's fee unknown: its rule is used
        expect(priceFunding(rules, 100_000)).toEqual({ customerTotal: 500, providerFee: 300, platformFee: 200 });
        // Fincra took more than the total: SolutionPay takes nothing, never a negative fee
        expect(priceFunding(rules, 10_000, 150).platformFee).toBe(0);
    });

    it("GHS pair fees are worked out in cedis and converted at the user's buffered rate", () => {
        const rules = { ...DEFAULT_PRICING.send["NGN-GHS"], providerFee: { percent: 1, fixed: 0, min: 0, cap: 0 }, platformFee: { percent: 0, fixed: 5, min: 0, cap: 0 } };
        // 1,000 GHS at ₦125 (the buffered rate): 1% = GHS 10, + GHS 5 fixed = GHS 15 = ₦1,875
        expect(pairFees(rules, 1_000, 125)).toMatchObject({ subtotalNgn: 125_000, providerFee: 1_250, platformFee: 625, total: 1_875, inFeeCurrency: 15, feeCurrency: "GHS" });
        // The same rules in NGN (an older config): ₦5 fixed, not GHS 5
        expect(pairFees({ ...rules, feeCurrency: "NGN" }, 1_000, 125)).toMatchObject({ total: 1_255, feeCurrency: "NGN" });
    });

    it("keeps older NGN fee amounts in NGN until an admin saves them in cedis", () => {
        const stored = { send: { "NGN-GHS": { providerFee: { percent: 1, fixed: 0, min: 0, cap: 0 }, platformFee: { percent: 0, fixed: 200, min: 0, cap: 0 }, rate: { percent: 1, fixed: 0 } } },
            receive: { "GHS-NGN": { providerFee: { percent: 1.5, fixed: 0, min: 0, cap: 0 }, platformFee: { percent: 0.5, fixed: 0, min: 0, cap: 0 }, rate: { percent: 1, fixed: 0 } } } };
        const config = withDefaults(stored as any);
        expect(config.send["NGN-GHS"].feeCurrency).toBe("NGN");     // has a ₦200 fixed fee
        expect(config.receive["GHS-NGN"].feeCurrency).toBe("GHS");  // percentages only: same either way
        expect(legacyNgnFeePairs(config)).toEqual([{ op: "send", pair: "NGN-GHS" }]);
        const saved = parsePricing({ send: { "NGN-GHS": { feeCurrency: "GHS", platformFee: { percent: 0, fixed: 1.5, min: 0, cap: 0 } } } }, config);
        expect(legacyNgnFeePairs(saved)).toEqual([]);
        expect(() => parsePricing({ send: { "NGN-GHS": { feeCurrency: "KES" } } }, config)).toThrow(PricingError);
    });

    it("per-transaction limits", () => {
        const next = parsePricing({ receive: { "GHS-NGN": { limits: { min: 10, max: 50_000 } } } }, DEFAULT_PRICING);
        expect(next.receive["GHS-NGN"].limits).toEqual({ min: 10, max: 50_000 });
        expect(limitProblem(next.receive["GHS-NGN"].limits, 60_000, "GHS")).toBe("The most you can do in one transaction is GHS 50,000.");
        expect(limitProblem(next.receive["GHS-NGN"].limits, 5, "GHS")).toBe("The smallest amount per transaction is GHS 10.");
        expect(limitProblem(next.receive["GHS-NGN"].limits, 500, "GHS")).toBeNull();
        expect(() => parsePricing({ receive: { "GHS-NGN": { limits: { min: 100, max: 50 } } } }, DEFAULT_PRICING)).toThrow(PricingError);
    });
});

import { environmentMismatch } from "../src/utils/environment-check.utils";
describe("staging and production stay apart", () => {
    it("flags an API whose FRONTEND_URL is the other environment", () => {
        expect(environmentMismatch("api.solutionpay.co", "https://www.solutionpay.co")).toBeNull();
        expect(environmentMismatch("api-staging.solutionpay.co", "https://staging.solutionpay.co")).toBeNull();
        expect(environmentMismatch("api.solutionpay.co", "https://staging.solutionpay.co")).toContain("Production API");
        expect(environmentMismatch("api-staging.solutionpay.co", "https://solutionpay.co")).toContain("Staging API");
        expect(environmentMismatch("", "http://localhost:3000")).toBeNull();
    });
});
