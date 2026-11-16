import { eq } from "drizzle-orm";
import { platformSettings } from "../db/schema";
import type { PlatformSettings } from "../types/entities";
import { DEFAULT_TIER_DAILY_LIMIT_USD } from "../common/tier.constants";
import { exec } from "./utils";

type SettingsRow = typeof platformSettings.$inferSelect;

export interface PlatformSettingsUpdate {
    rateMarkupPercent?: number;
    additionalFeePercent?: number;
    providerBaseFeePercent?: { ogateway: number; yellowcard: number; fincra: number };
    tierDailyLimitUsd?: { tier1: number; tier2: number };
    updatedBy?: string;
}

function toSettings(row: SettingsRow): PlatformSettings {
    return {
        id: row.id,
        kind: "singleton",
        rateMarkupPercent: row.rateMarkupPercent,
        additionalFeePercent: row.additionalFeePercent,
        providerBaseFeePercent: { ogateway: row.providerFeeOgatewayPercent, yellowcard: row.providerFeeYellowcardPercent, fincra: row.providerFeeFincraPercent },
        tierDailyLimitUsd: { tier1: row.tier1DailyLimitUsd, tier2: row.tier2DailyLimitUsd },
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
                tier1DailyLimitUsd: DEFAULT_TIER_DAILY_LIMIT_USD.tier1,
                tier2DailyLimitUsd: DEFAULT_TIER_DAILY_LIMIT_USD.tier2,
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
        if (patch.tierDailyLimitUsd) {
            values.tier1DailyLimitUsd = patch.tierDailyLimitUsd.tier1;
            values.tier2DailyLimitUsd = patch.tierDailyLimitUsd.tier2;
        }
        if (patch.updatedBy !== undefined) values.updatedBy = patch.updatedBy;
        await this.getOrCreate();
        const [row] = await exec().update(platformSettings).set(values).where(eq(platformSettings.kind, "singleton")).returning();
        return toSettings(row);
    }
}

export const platformSettingsRepository = new PlatformSettingsRepository();
export default platformSettingsRepository;
