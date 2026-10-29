import DBService from "../utils/db.utils";
import { IPlatformSettings } from "../models/interface";
import PlatformSettings from "../models/platform-settings.model";
import logger from "../utils/logger.utils";
import { DEFAULT_TIER_DAILY_LIMIT_USD, USER_TIER, UserTier } from "../common/tier.constants";

export type ProviderKey = 'ogateway' | 'yellowcard';
export type RateDirection = 'send' | 'receive';

/**
 * Source of truth for universal pricing knobs.
 *
 * Auto-seeds defaults on first read so the rest of the system never has to
 * handle a "settings missing" state. Caches the result for 30s — the read
 * path (rate display + transaction creation) hits this on every keystroke
 * and would otherwise hammer Mongo.
 *
 * Always go through this service. Reading the model directly will bypass
 * the cache and risk drift between display and journal.
 */
class PlatformSettingsService extends DBService<IPlatformSettings> {
    private cache: { value: IPlatformSettings; fetchedAt: number } | null = null;
    private loading: Promise<IPlatformSettings> | null = null;
    private readonly TTL_MS = 30_000;

    constructor() {
        super(PlatformSettings);
    }

    private bustCache() {
        this.cache = null;
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
        let doc = await this.findOne({ kind: 'singleton' }) as IPlatformSettings | null;
        if (!doc) {
            try {
                doc = await this.create({ kind: 'singleton' } as Partial<IPlatformSettings>) as IPlatformSettings;
                logger.info("PlatformSettings: seeded defaults", { id: (doc as any)?._id });
            } catch (error) {
                // Another instance seeded it first
                doc = await this.findOne({ kind: 'singleton' }) as IPlatformSettings | null;
                if (!doc) throw error;
            }
        }
        this.cache = { value: doc, fetchedAt: Date.now() };
        return doc;
    }

    /**
     * Update the singleton. Caller must enforce admin auth before invoking.
     */
    public async updateSettings(
        patch: Partial<{
            rateMarkupPercent: number;
            additionalFeePercent: number;
            providerBaseFeePercent: Partial<{ ogateway: number; yellowcard: number }>;
            tierDailyLimitUsd: Partial<{ tier1: number; tier2: number }>;
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
            };
        }
        if (patch.tierDailyLimitUsd) {
            const limits = this.tierLimits(current);
            update.tierDailyLimitUsd = {
                tier1: patch.tierDailyLimitUsd.tier1 ?? limits.tier1,
                tier2: patch.tierDailyLimitUsd.tier2 ?? limits.tier2,
            };
        }
        update.updatedBy = adminUserId;

        const before = {
            rateMarkupPercent: current.rateMarkupPercent,
            additionalFeePercent: current.additionalFeePercent,
            providerBaseFeePercent: current.providerBaseFeePercent,
            tierDailyLimitUsd: this.tierLimits(current),
        };

        const updated = await this.updateById(String(current._id), update);
        this.bustCache();

        logger.info("PlatformSettings: updated", {
            adminUserId,
            before,
            after: {
                rateMarkupPercent: updated.rateMarkupPercent,
                additionalFeePercent: updated.additionalFeePercent,
                providerBaseFeePercent: updated.providerBaseFeePercent,
                tierDailyLimitUsd: updated.tierDailyLimitUsd,
            },
        });

        return updated;
    }

    private tierLimits(settings: IPlatformSettings) {
        return {
            tier1: settings.tierDailyLimitUsd?.tier1 ?? DEFAULT_TIER_DAILY_LIMIT_USD.tier1,
            tier2: settings.tierDailyLimitUsd?.tier2 ?? DEFAULT_TIER_DAILY_LIMIT_USD.tier2,
        };
    }

    /** Daily limit in USD for a tier; null means unlimited (Tier 3), 0 for unverified accounts */
    public async getTierDailyLimitUsd(tier: UserTier): Promise<number | null> {
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
