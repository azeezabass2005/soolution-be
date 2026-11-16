/**
 * Admin-configurable pricing.
 *
 * Every priced operation has two fee rules and, when currencies change, a
 * rate rule:
 *   - providerFee: what the provider (Fincra) charges, passed on to the user
 *   - platformFee: SolutionPay's own charge on top
 *   - rate:        the buffer added to the provider's exchange rate
 *
 * A fee rule is `amount × percent% + fixed`, then raised to `min` and held
 * to `cap` (0 = no minimum / no cap). Fees are in NGN.
 *
 * Funding is different: Fincra takes its fee out of the deposit itself, so
 * its providerFee is only for display and the user is charged platformFee.
 */

export interface FeeRule {
    percent: number;
    fixed: number;
    min: number;
    /** 0 = no cap */
    cap: number;
}

export interface RateRule {
    /** % of the provider's rate */
    percent: number;
    /** NGN per 1 unit of the foreign currency */
    fixed: number;
}

export interface FeePricing {
    providerFee: FeeRule;
    platformFee: FeeRule;
}

export interface FxPricing extends FeePricing {
    rate: RateRule;
}

export interface PricingConfig {
    /** Deposits into the user's NGN account number */
    funding: { NGN: FeePricing };
    /** NGN withdrawals to Nigerian banks */
    withdrawal: { NGN: FeePricing };
    /** User pays NGN, the recipient gets the foreign currency. Key: "NGN-GHS" */
    send: Record<string, FxPricing>;
    /** Someone pays the foreign currency, the user gets NGN. Key: "GHS-NGN" */
    receive: Record<string, FxPricing>;
}

export type PricedOperation = keyof PricingConfig;

export const ZERO_FEE: FeeRule = { percent: 0, fixed: 0, min: 0, cap: 0 };
export const ZERO_RATE: RateRule = { percent: 0, fixed: 0 };

/** Defaults: Fincra's published pricing passed on, nothing extra for SolutionPay */
export const DEFAULT_PRICING: PricingConfig = {
    funding: { NGN: { providerFee: { percent: 1, fixed: 0, min: 0, cap: 300 }, platformFee: { ...ZERO_FEE } } },
    withdrawal: { NGN: { providerFee: { ...ZERO_FEE }, platformFee: { ...ZERO_FEE } } },
    send: { "NGN-GHS": { providerFee: { percent: 1.5, fixed: 0, min: 0, cap: 0 }, platformFee: { ...ZERO_FEE }, rate: { ...ZERO_RATE } } },
    receive: { "GHS-NGN": { providerFee: { percent: 1.5, fixed: 0, min: 0, cap: 0 }, platformFee: { ...ZERO_FEE }, rate: { ...ZERO_RATE } } },
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The fee a rule charges on `amount` (NGN), never more than the amount itself */
export function applyFeeRule(rule: FeeRule | undefined, amount: number): number {
    if (!rule || !(amount > 0)) return 0;
    let fee = amount * (rule.percent / 100) + rule.fixed;
    if (rule.min > 0) fee = Math.max(fee, rule.min);
    if (rule.cap > 0) fee = Math.min(fee, rule.cap);
    return round2(Math.min(Math.max(fee, 0), amount));
}

export interface FeeBreakdown {
    providerFee: number;
    platformFee: number;
    /** What the user is charged (funding: platformFee only) */
    total: number;
    /** total as a % of the amount, for display */
    effectivePercent: number;
}

export function priceFees(pricing: FeePricing | undefined, amount: number, opts: { providerFeeCharged?: boolean } = {}): FeeBreakdown {
    const providerFee = applyFeeRule(pricing?.providerFee, amount);
    const platformFee = applyFeeRule(pricing?.platformFee, amount);
    const charged = opts.providerFeeCharged === false ? platformFee : round2(providerFee + platformFee);
    const total = round2(Math.min(charged, amount));
    return { providerFee, platformFee, total, effectivePercent: amount > 0 ? Math.round((total / amount) * 100 * 10_000) / 10_000 : 0 };
}

/**
 * The user's rate (NGN per 1 unit of the foreign currency) from the
 * provider's. Sends cost the user more NGN, receives give them less.
 */
export function applyRateRule(rule: RateRule | undefined, providerRate: number, direction: "send" | "receive"): number {
    if (!rule) return providerRate;
    const buffer = providerRate * (rule.percent / 100) + rule.fixed;
    const rate = direction === "send" ? providerRate + buffer : providerRate - buffer;
    return rate > 0 ? rate : providerRate;
}

// ─────────────────────────── validation ───────────────────────────

const MAX_PERCENT = 50;
const MAX_NGN = 100_000_000;

export class PricingError extends Error {}

function num(value: unknown, path: string, max: number): number {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof n !== "number" || !isFinite(n) || n < 0 || n > max) {
        throw new PricingError(`${path} must be a number between 0 and ${max.toLocaleString("en-NG")}`);
    }
    return Math.round(n * 10_000) / 10_000;
}

function feeRule(value: any, path: string): FeeRule {
    if (!value || typeof value !== "object") throw new PricingError(`${path} is missing`);
    const rule = {
        percent: num(value.percent ?? 0, `${path}.percent`, MAX_PERCENT),
        fixed: num(value.fixed ?? 0, `${path}.fixed`, MAX_NGN),
        min: num(value.min ?? 0, `${path}.min`, MAX_NGN),
        cap: num(value.cap ?? 0, `${path}.cap`, MAX_NGN),
    };
    if (rule.cap > 0 && rule.min > rule.cap) throw new PricingError(`${path}: the minimum can't be above the cap`);
    return rule;
}

function rateRule(value: any, path: string): RateRule {
    if (!value || typeof value !== "object") throw new PricingError(`${path} is missing`);
    return { percent: num(value.percent ?? 0, `${path}.percent`, MAX_PERCENT), fixed: num(value.fixed ?? 0, `${path}.fixed`, MAX_NGN) };
}

const PAIR = /^[A-Z]{3}-[A-Z]{3}$/;

/** A complete, checked config from admin input; anything left out keeps `current` */
export function parsePricing(input: any, current: PricingConfig): PricingConfig {
    if (!input || typeof input !== "object") throw new PricingError("pricing must be an object");
    const next: PricingConfig = JSON.parse(JSON.stringify(current));
    for (const op of ["funding", "withdrawal"] as const) {
        if (input[op]?.NGN === undefined) continue;
        const src = input[op].NGN;
        next[op].NGN = {
            providerFee: feeRule(src.providerFee ?? current[op].NGN.providerFee, `${op}.NGN.providerFee`),
            platformFee: feeRule(src.platformFee ?? current[op].NGN.platformFee, `${op}.NGN.platformFee`),
        };
    }
    for (const op of ["send", "receive"] as const) {
        if (input[op] === undefined) continue;
        if (typeof input[op] !== "object") throw new PricingError(`${op} must be an object`);
        for (const [pair, src] of Object.entries<any>(input[op])) {
            if (!PAIR.test(pair)) throw new PricingError(`${op}: "${pair}" isn't a currency pair like NGN-GHS`);
            const base = current[op][pair] ?? { providerFee: ZERO_FEE, platformFee: ZERO_FEE, rate: ZERO_RATE };
            next[op][pair] = {
                providerFee: feeRule(src?.providerFee ?? base.providerFee, `${op}.${pair}.providerFee`),
                platformFee: feeRule(src?.platformFee ?? base.platformFee, `${op}.${pair}.platformFee`),
                rate: rateRule(src?.rate ?? base.rate, `${op}.${pair}.rate`),
            };
        }
    }
    return next;
}

/** Stored config over the defaults, so a missing operation or field is never undefined */
export function withDefaults(stored: Partial<PricingConfig> | null | undefined, base: PricingConfig = DEFAULT_PRICING): PricingConfig {
    try {
        return stored ? parsePricing(stored, base) : JSON.parse(JSON.stringify(base));
    } catch {
        return JSON.parse(JSON.stringify(base));
    }
}
