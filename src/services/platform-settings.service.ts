import platformSettingsRepository from "../repositories/platform-settings.repository";
import type { PlatformSettings as IPlatformSettings } from "../types/entities";
import logger from "../utils/logger.utils";
import { DEFAULT_TIER_DAILY_LIMIT_NGN, USER_TIER, UserTier } from "../common/tier.constants";
import {
    FeeBreakdown, FeePricing, FundingFeeBreakdown, FundingPricing, FxPricing, NO_LIMITS, PricingConfig, ZERO_FEE, ZERO_RATE,
    applyRateRule, parsePricing, priceFees, priceFunding, withDefaults,
} from "../common/pricing";

export type ProviderKey = 'ogateway' | 'yellowcard' | 'fincra';
export type RateDirection = 'send' | 'receive';

/**
 * Source of truth for universal pricing knobs.
 *
 * Auto-seeds defaults on first read so the rest of the system never has to
 * handle a "settings missing" state. Caches the result for 30s — the read
 * path (rate display + transaction creation) hits this on every keystroke
 * and would otherwise hammer the database.
 *
 * Always go through this service. Reading the model directly will bypass
 * the cache and risk drift between display and journal.
 */
class PlatformSettingsService {
    private cache: { value: IPlatformSettings; fetchedAt: number } | null = null;
    private loading: Promise<IPlatformSettings> | null = null;
    private readonly TTL_MS = 30_000;

    private bustCache() {
        this.cache = null;
    }

    /** Forget the cached settings (tests reset the database underneath it) */
    public clearCache() {
        this.bustCache();
    }

    public async getSettings(): Promise<IPlatformSettings> {
        if (this.cache && Date.now() - this.cache.fetchedAt < this.TTL_MS) {
            return this.cache.value;
        }
        // Concurrent callers share one load, so they can't both try to seed the singleton
        this.loading ??= this.load().finally(() => { this.loading = null; });
        return this.loading;
    }

    private async load(): Promise<IPlatformSettings> {
        // Seeds the defaults on first read; safe when several instances race
        const settings = await platformSettingsRepository.getOrCreate();
        this.cache = { value: settings, fetchedAt: Date.now() };
        return settings;
    }

    /**
     * Update the singleton. Caller must enforce admin auth before invoking.
     */
    public async updateSettings(
        patch: Partial<{
            rateMarkupPercent: number;
            additionalFeePercent: number;
            providerBaseFeePercent: Partial<{ ogateway: number; yellowcard: number; fincra: number }>;
            tierDailyLimitNgn: Partial<{ tier1: number; tier2: number }>;
            /** Partial pricing: what's given replaces, the rest is kept (throws PricingError) */
            pricing: unknown;
        }>,
        adminUserId: string,
    ): Promise<IPlatformSettings> {
        const current = await this.getSettings();
        const update: any = {};
        if (typeof patch.rateMarkupPercent === 'number') update.rateMarkupPercent = patch.rateMarkupPercent;
        if (typeof patch.additionalFeePercent === 'number') update.additionalFeePercent = patch.additionalFeePercent;
        if (patch.providerBaseFeePercent) {
            update.providerBaseFeePercent = {
                ogateway: typeof patch.providerBaseFeePercent.ogateway === 'number'
                    ? patch.providerBaseFeePercent.ogateway
                    : current.providerBaseFeePercent.ogateway,
                yellowcard: typeof patch.providerBaseFeePercent.yellowcard === 'number'
                    ? patch.providerBaseFeePercent.yellowcard
                    : current.providerBaseFeePercent.yellowcard,
                fincra: typeof patch.providerBaseFeePercent.fincra === 'number'
                    ? patch.providerBaseFeePercent.fincra
                    : current.providerBaseFeePercent.fincra,
            };
        }
        if (patch.tierDailyLimitNgn) {
            const limits = this.tierLimits(current);
            update.tierDailyLimitNgn = {
                tier1: patch.tierDailyLimitNgn.tier1 ?? limits.tier1,
                tier2: patch.tierDailyLimitNgn.tier2 ?? limits.tier2,
            };
        }
        if (patch.pricing !== undefined) update.pricing = parsePricing(patch.pricing, this.pricingOf(current));
        update.updatedBy = adminUserId;

        const before = {
            rateMarkupPercent: current.rateMarkupPercent,
            additionalFeePercent: current.additionalFeePercent,
            providerBaseFeePercent: current.providerBaseFeePercent,
            tierDailyLimitNgn: this.tierLimits(current),
            pricing: this.pricingOf(current),
        };

        const updated = await platformSettingsRepository.update(update);
        this.bustCache();

        logger.info("PlatformSettings: updated", {
            adminUserId,
            before,
            after: {
                rateMarkupPercent: updated.rateMarkupPercent,
                additionalFeePercent: updated.additionalFeePercent,
                providerBaseFeePercent: updated.providerBaseFeePercent,
                tierDailyLimitNgn: updated.tierDailyLimitNgn,
                pricing: this.pricingOf(updated),
            },
        });

        return updated;
    }

    /**
     * The full pricing config. Until an admin saves one, it's built from the
     * older single knobs (markup %, Fincra %, additional %) so nothing changes.
     */
    private pricingOf(settings: IPlatformSettings): PricingConfig {
        if (settings.pricing) return withDefaults(settings.pricing);
        const fx = (): FxPricing => ({
            providerFee: { ...ZERO_FEE, percent: settings.providerBaseFeePercent?.fincra ?? 0 },
            platformFee: { ...ZERO_FEE, percent: settings.additionalFeePercent ?? 0 },
            rate: { ...ZERO_RATE, percent: settings.rateMarkupPercent ?? 0 },
            feeCurrency: "GHS",
            limits: { ...NO_LIMITS },
        });
        return { ...withDefaults(null), send: { "NGN-GHS": fx() }, receive: { "GHS-NGN": fx() } };
    }

    public async getPricing(): Promise<PricingConfig> {
        return this.pricingOf(await this.getSettings());
    }

    /** Fees for an operation on `amount` (NGN). Funding charges only SolutionPay's fee: Fincra takes its own. */
    public async priceFees(operation: "funding" | "withdrawal", amount: number): Promise<FeeBreakdown & { pricing: FeePricing }>;
    public async priceFees(operation: "send" | "receive", amount: number, pair: string): Promise<FeeBreakdown & { pricing: FeePricing }>;
    public async priceFees(operation: keyof PricingConfig, amount: number, pair?: string) {
        const pricing = await this.getPricing();
        const rules: FeePricing | undefined = operation === "funding" || operation === "withdrawal"
            ? pricing[operation].NGN
            : pricing[operation][pair || ""];
        const fees = priceFees(rules, amount, { providerFeeCharged: operation !== "funding" });
        return { ...fees, pricing: rules ?? { providerFee: ZERO_FEE, platformFee: ZERO_FEE } };
    }

    /** The user's rate for a pair (NGN per 1 foreign unit) from the provider's, with the pair's buffer */
    /** A pair's rules (fees, rate, fee currency, limits), or undefined when the pair isn't priced */
    public async pairPricing(operation: "send" | "receive", pair: string): Promise<FxPricing | undefined> {
        return (await this.getPricing())[operation][pair];
    }

    /** A deposit's fees: what the user pays in total, Fincra's part and SolutionPay's (see priceFunding) */
    public async priceFunding(grossAmount: number, providerTaken?: number): Promise<FundingFeeBreakdown & { pricing: FundingPricing }> {
        const pricing = (await this.getPricing()).funding.NGN;
        return { ...priceFunding(pricing, grossAmount, providerTaken), pricing };
    }

    public async applyPairRate(operation: "send" | "receive", pair: string, providerRate: number): Promise<number> {
        const pricing = await this.getPricing();
        return applyRateRule(pricing[operation][pair]?.rate, providerRate, operation);
    }

    private tierLimits(settings: IPlatformSettings) {
        return {
            tier1: settings.tierDailyLimitNgn?.tier1 ?? DEFAULT_TIER_DAILY_LIMIT_NGN.tier1,
            tier2: settings.tierDailyLimitNgn?.tier2 ?? DEFAULT_TIER_DAILY_LIMIT_NGN.tier2,
        };
    }

    /** Daily limit in NGN for a tier; null means unlimited (Tier 3), 0 for unverified accounts */
    public async getTierDailyLimitNgn(tier: UserTier): Promise<number | null> {
        if (tier >= USER_TIER.INSTITUTION) return null;
        if (tier < USER_TIER.INDIVIDUAL) return 0;
        const limits = this.tierLimits(await this.getSettings());
        return tier === USER_TIER.BUSINESS ? limits.tier2 : limits.tier1;
    }

    /** All tiers' daily limits (null = unlimited), for display */
    public async getTierDailyLimits(): Promise<Record<UserTier, number | null>> {
        const limits = this.tierLimits(await this.getSettings());
        return { 0: 0, 1: limits.tier1, 2: limits.tier2, 3: null };
    }

    /**
     * Apply the FX markup so the platform always profits regardless of
     * trade direction.
     *   - send (user buys foreign currency): user pays MORE source units per
     *     destination unit  → multiply rate by (1 + m)
     *   - receive (user sells foreign currency): user gets LESS destination
     *     units per source unit → multiply rate by (1 - m)
     *
     * The caller passes the provider's raw rate (always quoted as source-per-
     * destination for the relevant pair); this returns the rate to actually
     * display and book against.
     */
    public async applyRateMarkup(providerRate: number, direction: RateDirection): Promise<number> {
        const { rateMarkupPercent } = await this.getSettings();
        const m = rateMarkupPercent / 100;
        if (m <= 0) return providerRate;
        return direction === 'send'
            ? providerRate * (1 + m)
            : providerRate * (1 - m);
    }

    /**
     * Total % the user pays = the rail's own fee + the admin's additional %.
     */
    public async getEffectiveFeePercent(provider: ProviderKey): Promise<{
        total: number;
        providerBase: number;
        additional: number;
    }> {
        const settings = await this.getSettings();
        const providerBase = settings.providerBaseFeePercent[provider] ?? 0;
        const additional = settings.additionalFeePercent;
        return { total: providerBase + additional, providerBase, additional };
    }

    /**
     * Convenience: compute a fee amount from a base amount using the
     * effective total %. Rounded to 2 dp to match wallet currency precision.
     */
    public async computeFee(provider: ProviderKey, baseAmount: number): Promise<{
        feeAmount: number;
        feePercent: number;
        providerFeePercent: number;
    }> {
        const { total, providerBase } = await this.getEffectiveFeePercent(provider);
        const feeAmount = Math.round(baseAmount * (total / 100) * 100) / 100;
        return { feeAmount, feePercent: total, providerFeePercent: providerBase };
    }
}

export default new PlatformSettingsService();
