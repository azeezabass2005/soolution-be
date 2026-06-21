import DBService from "../utils/db.utils";
import { IPlatformSettings } from "../models/interface";
import PlatformSettings from "../models/platform-settings.model";
import logger from "../utils/logger.utils";

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
        let doc = await this.findOne({ kind: 'singleton' }) as IPlatformSettings | null;
        if (!doc) {
            doc = await this.create({ kind: 'singleton' } as Partial<IPlatformSettings>) as IPlatformSettings;
            logger.info("PlatformSettings: seeded defaults", { id: (doc as any)?._id });
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
        update.updatedBy = adminUserId;

        const before = {
            rateMarkupPercent: current.rateMarkupPercent,
            additionalFeePercent: current.additionalFeePercent,
            providerBaseFeePercent: current.providerBaseFeePercent,
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
            },
        });

        return updated;
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
