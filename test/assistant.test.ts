import { describe, expect, it } from "vitest";
import assistantService, { wordsOf } from "../src/services/assistant.service";

describe("support assistant", () => {
    const top = (q: string) => assistantService.answer(q);

    it("answers common questions with the right article", () => {
        const cases: Array<[string, string]> = [
            ["How do I deposit money into my wallet?", "fund-wallet"],
            ["what is my account number for bank transfer", "fund-wallet"],
            ["How do I send money to Kenya?", "send-money"],
            ["my payment failed, will I get a refund", "failed-refund"],
            ["I forgot my transaction PIN", "pin"],
            ["How do I raise a dispute about a payment?", "dispute"],
            ["how can i increase my daily limit", "verification"],
            ["how long does it take to arrive", "how-long"],
            ["I want to withdraw to my bank", "withdraw"],
            ["Can I pay a supplier on Alipay in China?", "china"],
            ["my money is still pending, where is it", "pending"],
            ["how do payment links work", "payment-link"],
        ];
        const got = cases.map(([question]) => { const r = top(question); return { question, confident: r.confident, first: r.answers[0]?.id }; });
        expect(got).toEqual(cases.map(([question, id]) => ({ question, confident: true, first: id })));
    });

    it("isn't confident about things it doesn't know, so the user can talk to a person", () => {
        expect(top("What's your office address in Lagos?").confident).toBe(false);
        expect(top("zzzz qqqq").answers).toEqual([]);
        expect(() => top("")).toThrow();
    });

    it("folds synonyms and drops filler words", () => {
        expect(wordsOf("I deposited via MoMo please")).toEqual(["fund", "via", "mobile", "money"]);
    });
});
