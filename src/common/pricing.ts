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
 * to `cap` (0 = no minimum / no cap).
 *
 * Currency of the fixed / min / cap amounts:
 *   - funding and withdrawal: NGN
 *   - a send or receive pair: its `feeCurrency`. "GHS" for NGN-GHS means the
 *     fee is worked out on the GHS amount, in GHS, then charged in NGN at the
 *     user's (buffered) rate. Older saved configs have no feeCurrency and
 *     stay in NGN until an admin reviews and saves them.
 *
 * Funding is different: Fincra takes its fee out of the deposit itself.
 * `customerFee` is what the user pays in total (e.g. 1% capped at ₦500);
 * Fincra's part (providerFee, e.g. 1% capped at ₦300) is taken by Fincra,
 * and SolutionPay keeps whatever is left of the total (never below zero).
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

export interface TxLimits {
    /** Smallest amount per transaction, in the pair's foreign currency (0 = none) */
    min: number;
    /** Largest amount per transaction, in the pair's foreign currency (0 = none) */
    max: number;
}

/**
 * Pricing for one amount band of a pair: from `min` (inclusive) up to `max`
 * (exclusive; 0 = no upper end), in the pair's foreign currency like the
 * limits. Its fees replace the pair's own, and its rate buffer too when set.
 */
export interface PriceTier {
    min: number;
    max: number;
    providerFee: FeeRule;
    platformFee: FeeRule;
    rate?: RateRule;
}

export interface FxPricing extends FeePricing {
    rate: RateRule;
    /** Currency of the fee rules' fixed / min / cap amounts (see above) */
    feeCurrency: string;
    limits: TxLimits;
    /** Optional amount bands, each priced on its own; amounts outside every band use the pair's own pricing */
    tiers?: PriceTier[];
}

/** The band of a pair's pricing an amount (foreign currency) falls in, or null */
export function tierFor(rules: FxPricing | undefined, amount: number): PriceTier | null {
    if (!rules?.tiers?.length || !(amount >= 0)) return null;
    return rules.tiers.find((t) => amount >= t.min && (t.max === 0 || amount < t.max)) ?? null;
}

/** A pair's pricing for this exact amount: its band's fees (and buffer, when the band sets one) */
export function rulesForAmount(rules: FxPricing | undefined, amount: number): FxPricing | undefined {
    const tier = tierFor(rules, amount);
    if (!rules || !tier) return rules;
    return { ...rules, providerFee: tier.providerFee, platformFee: tier.platformFee, rate: tier.rate ?? rules.rate };
}

export interface FundingPricing extends FeePricing {
    /** What the user pays in total for a deposit; SolutionPay keeps total − Fincra's part */
    customerFee: FeeRule;
}

/**
 * The naira-per-USD used to price YellowCard currencies. YellowCard quotes
 * every currency against USD and settles with us in USD, so a KES price is
 * (NGN per USD) / (KES per USD). "yellowcard" uses YellowCard's own NGN rate;
 * "ours" uses the rates we actually buy and sell USD at.
 */
export interface UsdPricing {
    mode: "yellowcard" | "ours";
    /** NGN we pay for 1 USD (sends: we buy USD to pay out) */
    buyNgn: number;
    /** NGN we get for 1 USD (receives: we sell the USD collected) */
    sellNgn: number;
}

export interface PricingConfig {
    /** Deposits into the user's NGN account number */
    funding: { NGN: FundingPricing };
    /** NGN withdrawals to Nigerian banks */
    withdrawal: { NGN: FeePricing };
    /** User pays NGN, the recipient gets the foreign currency. Key: "NGN-GHS" */
    send: Record<string, FxPricing>;
    /** Someone pays the foreign currency, the user gets NGN. Key: "GHS-NGN" */
    receive: Record<string, FxPricing>;
    /** The USD rate behind YellowCard currencies */
    usd: UsdPricing;
}

export type PricedOperation = Exclude<keyof PricingConfig, "usd">;

export const DEFAULT_USD: UsdPricing = { mode: "yellowcard", buyNgn: 0, sellNgn: 0 };

export const ZERO_FEE: FeeRule = { percent: 0, fixed: 0, min: 0, cap: 0 };
export const ZERO_RATE: RateRule = { percent: 0, fixed: 0 };
export const NO_LIMITS: TxLimits = { min: 0, max: 0 };

/** The foreign currency of a pair: "NGN-GHS" and "GHS-NGN" both give "GHS" */
export const foreignOf = (pair: string) => pair.split("-").find((c) => c !== "NGN") ?? "NGN";

/** Defaults: Fincra's published pricing passed on, nothing extra for SolutionPay */
export const DEFAULT_PRICING: PricingConfig = {
    funding: {
        NGN: {
            providerFee: { percent: 1, fixed: 0, min: 0, cap: 300 },
            platformFee: { ...ZERO_FEE },
            customerFee: { percent: 1, fixed: 0, min: 0, cap: 500 },
        },
    },
    withdrawal: { NGN: { providerFee: { ...ZERO_FEE }, platformFee: { ...ZERO_FEE } } },
    send: { "NGN-GHS": { providerFee: { percent: 1.5, fixed: 0, min: 0, cap: 0 }, platformFee: { ...ZERO_FEE }, rate: { ...ZERO_RATE }, feeCurrency: "GHS", limits: { ...NO_LIMITS } } },
    receive: { "GHS-NGN": { providerFee: { percent: 1.5, fixed: 0, min: 0, cap: 0 }, platformFee: { ...ZERO_FEE }, rate: { ...ZERO_RATE }, feeCurrency: "GHS", limits: { ...NO_LIMITS } } },
    usd: { ...DEFAULT_USD },
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

export interface FundingFeeBreakdown {
    /** What the user pays in total (customerFee on the amount they sent) */
    customerTotal: number;
    /** Fincra's part: what it actually took when known, else its rule */
    providerFee: number;
    /** SolutionPay's part: customerTotal − providerFee, never below zero */
    platformFee: number;
}

/**
 * A deposit's fees. `grossAmount` is what the payer sent; `providerTaken` is
 * what Fincra actually kept, when the webhook says (otherwise its rule).
 */
export function priceFunding(pricing: FundingPricing | undefined, grossAmount: number, providerTaken?: number): FundingFeeBreakdown {
    const providerFee = providerTaken !== undefined && isFinite(providerTaken) && providerTaken >= 0
        ? round2(providerTaken)
        : applyFeeRule(pricing?.providerFee, grossAmount);
    const customerTotal = pricing?.customerFee ? applyFeeRule(pricing.customerFee, grossAmount) : providerFee;
    // Older configs without customerFee: SolutionPay's own fee on top, as before
    const platformFee = pricing?.customerFee
        ? round2(Math.max(0, customerTotal - providerFee))
        : applyFeeRule(pricing?.platformFee, grossAmount);
    return { customerTotal: round2(Math.max(customerTotal, providerFee + platformFee)), providerFee, platformFee };
}

/** Whether `amount` (in the pair's foreign currency) is inside the pair's per-transaction limits */
export function limitProblem(limits: TxLimits | undefined, amount: number, currency: string): string | null {
    if (!limits) return null;
    const fmt = (n: number) => `${currency} ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    if (limits.min > 0 && amount < limits.min) return `The smallest amount per transaction is ${fmt(limits.min)}.`;
    if (limits.max > 0 && amount > limits.max) return `The most you can do in one transaction is ${fmt(limits.max)}.`;
    return null;
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
const MAX_LIMIT = 1_000_000_000;
/** No naira rate for 1 USD is anywhere near this */
const MAX_USD_NGN = 100_000;

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

function limitsRule(value: any, path: string): TxLimits {
    if (value === undefined || value === null) return { ...NO_LIMITS };
    if (typeof value !== "object") throw new PricingError(`${path} must be an object`);
    const limits = { min: num(value.min ?? 0, `${path}.min`, MAX_LIMIT), max: num(value.max ?? 0, `${path}.max`, MAX_LIMIT) };
    if (limits.max > 0 && limits.min > limits.max) throw new PricingError(`${path}: the minimum can't be above the maximum`);
    return limits;
}

function rateRule(value: any, path: string): RateRule {
    if (!value || typeof value !== "object") throw new PricingError(`${path} is missing`);
    return { percent: num(value.percent ?? 0, `${path}.percent`, MAX_PERCENT), fixed: num(value.fixed ?? 0, `${path}.fixed`, MAX_NGN) };
}

const MAX_TIERS = 20;

/** Bands in order, none overlapping; each must be a real range */
function tiersRule(value: any, path: string): PriceTier[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new PricingError(`${path} must be a list`);
    if (value.length > MAX_TIERS) throw new PricingError(`${path}: at most ${MAX_TIERS} amount ranges`);
    const tiers = value.map((t: any, i: number): PriceTier => {
        if (!t || typeof t !== "object") throw new PricingError(`${path}[${i}] is missing`);
        const tier: PriceTier = {
            min: num(t.min ?? 0, `${path}[${i}].min`, MAX_LIMIT),
            max: num(t.max ?? 0, `${path}[${i}].max`, MAX_LIMIT),
            providerFee: feeRule(t.providerFee ?? ZERO_FEE, `${path}[${i}].providerFee`),
            platformFee: feeRule(t.platformFee ?? ZERO_FEE, `${path}[${i}].platformFee`),
        };
        if (t.rate !== undefined && t.rate !== null) tier.rate = rateRule(t.rate, `${path}[${i}].rate`);
        if (tier.max > 0 && tier.max <= tier.min) throw new PricingError(`Range ${i + 1}: "to" must be more than "from"`);
        return tier;
    }).sort((a, b) => a.min - b.min);
    for (let i = 1; i < tiers.length; i++) {
        const prev = tiers[i - 1];
        if (prev.max === 0 || prev.max > tiers[i].min) {
            throw new PricingError(`Amount ranges overlap: ${prev.min}–${prev.max || "and up"} and ${tiers[i].min}–${tiers[i].max || "and up"}`);
        }
    }
    return tiers;
}

const PAIR = /^[A-Z]{3}-[A-Z]{3}$/;

/** A complete, checked config from admin input; anything left out keeps `current` */
export function parsePricing(input: any, current: PricingConfig): PricingConfig {
    if (!input || typeof input !== "object") throw new PricingError("pricing must be an object");
    const next: PricingConfig = JSON.parse(JSON.stringify(current));
    next.usd = { ...DEFAULT_USD, ...(current.usd ?? {}) };
    for (const op of ["funding", "withdrawal"] as const) {
        if (input[op]?.NGN === undefined) continue;
        const src = input[op].NGN;
        const base = current[op].NGN as Partial<FundingPricing>;
        next[op].NGN = {
            providerFee: feeRule(src.providerFee ?? base.providerFee, `${op}.NGN.providerFee`),
            platformFee: feeRule(src.platformFee ?? base.platformFee, `${op}.NGN.platformFee`),
        } as FundingPricing;
        if (op === "funding") {
            const customer = src.customerFee ?? base.customerFee;
            if (customer) (next.funding.NGN as FundingPricing).customerFee = feeRule(customer, "funding.NGN.customerFee");
        }
    }
    if (input.usd !== undefined) {
        const src = input.usd;
        if (!src || typeof src !== "object") throw new PricingError("usd must be an object");
        const mode = src.mode ?? current.usd?.mode ?? "yellowcard";
        if (mode !== "yellowcard" && mode !== "ours") throw new PricingError('usd.mode must be "yellowcard" or "ours"');
        const usd: UsdPricing = {
            mode,
            buyNgn: num(src.buyNgn ?? current.usd?.buyNgn ?? 0, "usd.buyNgn", MAX_USD_NGN),
            sellNgn: num(src.sellNgn ?? current.usd?.sellNgn ?? 0, "usd.sellNgn", MAX_USD_NGN),
        };
        if (usd.mode === "ours" && !(usd.buyNgn > 0 && usd.sellNgn > 0)) {
            throw new PricingError("Enter both of our USD rates (what we buy and sell 1 USD for) before using them");
        }
        next.usd = usd;
    }
    for (const op of ["send", "receive"] as const) {
        if (input[op] === undefined) continue;
        if (typeof input[op] !== "object") throw new PricingError(`${op} must be an object`);
        for (const [pair, src] of Object.entries<any>(input[op])) {
            if (!PAIR.test(pair)) throw new PricingError(`${op}: "${pair}" isn't a currency pair like NGN-GHS`);
            const base: Partial<FxPricing> = current[op][pair] ?? { providerFee: ZERO_FEE, platformFee: ZERO_FEE, rate: ZERO_RATE, feeCurrency: foreignOf(pair), limits: NO_LIMITS };
            const feeCurrency = String(src?.feeCurrency ?? base.feeCurrency ?? "NGN").toUpperCase();
            if (feeCurrency !== "NGN" && feeCurrency !== foreignOf(pair)) {
                throw new PricingError(`${op}.${pair}.feeCurrency must be NGN or ${foreignOf(pair)}`);
            }
            next[op][pair] = {
                providerFee: feeRule(src?.providerFee ?? base.providerFee, `${op}.${pair}.providerFee`),
                platformFee: feeRule(src?.platformFee ?? base.platformFee, `${op}.${pair}.platformFee`),
                rate: rateRule(src?.rate ?? base.rate, `${op}.${pair}.rate`),
                feeCurrency,
                limits: limitsRule(src?.limits ?? base.limits, `${op}.${pair}.limits`),
                tiers: tiersRule(src?.tiers !== undefined ? src.tiers : base.tiers, `${op}.${pair}.tiers`),
            };
        }
    }
    return next;
}

/** Stored config over the defaults, so a missing operation or field is never undefined */
/** Whether a fee rule has any fixed amount (fixed, min or cap), i.e. depends on its currency */
const hasAmounts = (rule?: Partial<FeeRule>) => !!rule && [rule.fixed, rule.min, rule.cap].some((v) => Number(v) > 0);

/**
 * Configs saved before fees could be in the foreign currency have no
 * feeCurrency: their amounts are NGN. Pairs that are only percentages give
 * the same fee either way, so they move to the foreign currency directly.
 */
export function withStoredFeeCurrencies(stored: any): any {
    if (!stored || typeof stored !== "object") return stored;
    const copy = JSON.parse(JSON.stringify(stored));
    for (const op of ["send", "receive"]) {
        for (const [pair, rules] of Object.entries<any>(copy[op] ?? {})) {
            if (!rules || typeof rules !== "object" || rules.feeCurrency) continue;
            rules.feeCurrency = hasAmounts(rules.providerFee) || hasAmounts(rules.platformFee) ? "NGN" : foreignOf(pair);
        }
    }
    return copy;
}

/** Pairs whose fee amounts are still in NGN although they could be in the foreign currency */
export function legacyNgnFeePairs(config: PricingConfig): { op: "send" | "receive"; pair: string }[] {
    const out: { op: "send" | "receive"; pair: string }[] = [];
    for (const op of ["send", "receive"] as const) {
        for (const [pair, rules] of Object.entries(config[op])) {
            if (rules.feeCurrency === "NGN" && foreignOf(pair) !== "NGN") out.push({ op, pair });
        }
    }
    return out;
}

export function withDefaults(stored: Partial<PricingConfig> | null | undefined, base: PricingConfig = DEFAULT_PRICING): PricingConfig {
    try {
        return stored ? parsePricing(withStoredFeeCurrencies(stored), base) : JSON.parse(JSON.stringify(base));
    } catch {
        return JSON.parse(JSON.stringify(base));
    }
}
