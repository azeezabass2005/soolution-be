import { eq } from "drizzle-orm";
import { platformSettings } from "../db/schema";
import type { PlatformSettings } from "../types/entities";
import { DEFAULT_TIER_DAILY_LIMIT_NGN } from "../common/tier.constants";
import { exec } from "./utils";
import type { PricingConfig } from "../common/pricing";

type SettingsRow = typeof platformSettings.$inferSelect;

export interface PlatformSettingsUpdate {
    rateMarkupPercent?: number;
    additionalFeePercent?: number;
    providerBaseFeePercent?: { ogateway: number; yellowcard: number; fincra: number };
    tierDailyLimitNgn?: { tier1: number; tier2: number };
    pricing?: PricingConfig;
    updatedBy?: string;
}

function toSettings(row: SettingsRow): PlatformSettings {
    return {
        id: row.id,
        kind: "singleton",
        rateMarkupPercent: row.rateMarkupPercent,
        additionalFeePercent: row.additionalFeePercent,
        providerBaseFeePercent: { ogateway: row.providerFeeOgatewayPercent, yellowcard: row.providerFeeYellowcardPercent, fincra: row.providerFeeFincraPercent },
        tierDailyLimitNgn: { tier1: row.tier1DailyLimitNgn, tier2: row.tier2DailyLimitNgn },
        ...(row.pricing ? { pricing: row.pricing } : {}),
        ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

class PlatformSettingsRepository {
    /** The singleton row, created with defaults the first time it's read */
    async getOrCreate(): Promise<PlatformSettings> {
        await exec()
            .insert(platformSettings)
            .values({
                kind: "singleton",
                tier1DailyLimitNgn: DEFAULT_TIER_DAILY_LIMIT_NGN.tier1,
                tier2DailyLimitNgn: DEFAULT_TIER_DAILY_LIMIT_NGN.tier2,
            })
            .onConflictDoNothing({ target: platformSettings.kind });
        const [row] = await exec().select().from(platformSettings).where(eq(platformSettings.kind, "singleton")).limit(1);
        return toSettings(row);
    }

    async update(patch: PlatformSettingsUpdate): Promise<PlatformSettings> {
        const values: Partial<typeof platformSettings.$inferInsert> = {};
        if (patch.rateMarkupPercent !== undefined) values.rateMarkupPercent = patch.rateMarkupPercent;
        if (patch.additionalFeePercent !== undefined) values.additionalFeePercent = patch.additionalFeePercent;
        if (patch.providerBaseFeePercent) {
            values.providerFeeOgatewayPercent = patch.providerBaseFeePercent.ogateway;
            values.providerFeeYellowcardPercent = patch.providerBaseFeePercent.yellowcard;
            values.providerFeeFincraPercent = patch.providerBaseFeePercent.fincra;
        }
        if (patch.tierDailyLimitNgn) {
            values.tier1DailyLimitNgn = patch.tierDailyLimitNgn.tier1;
            values.tier2DailyLimitNgn = patch.tierDailyLimitNgn.tier2;
        }
        if (patch.pricing) values.pricing = patch.pricing;
        if (patch.updatedBy !== undefined) values.updatedBy = patch.updatedBy;
        await this.getOrCreate();
        const [row] = await exec().update(platformSettings).set(values).where(eq(platformSettings.kind, "singleton")).returning();
        return toSettings(row);
    }
}

export const platformSettingsRepository = new PlatformSettingsRepository();
export default platformSettingsRepository;
