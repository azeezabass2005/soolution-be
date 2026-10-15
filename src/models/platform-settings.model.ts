import { model, Model, Schema } from "mongoose";
import { IPlatformSettings } from "./interface";
import { MODEL_NAME } from "../common/constant";
import { DEFAULT_TIER_DAILY_LIMIT_USD } from "../common/tier.constants";

/**
 * Singleton document holding universal pricing knobs: FX markup, additional
 * fee on top of the rail's base fee, and the rail's base fee itself (so it
 * can be tracked without redeploys when a provider changes their pricing).
 *
 * Singleton-ness is enforced by the unique index on `kind`.
 */
export const PlatformSettingsSchema = new Schema<IPlatformSettings>(
    {
        kind: { type: String, enum: ['singleton'], required: true, unique: true, default: 'singleton' },
        rateMarkupPercent: { type: Number, required: true, default: 0, min: 0, max: 50 },
        additionalFeePercent: { type: Number, required: true, default: 0, min: 0, max: 10 },
        providerBaseFeePercent: {
            ogateway: { type: Number, required: true, default: 1.5, min: 0, max: 10 },
            yellowcard: { type: Number, required: true, default: 0, min: 0, max: 10 },
        },
        tierDailyLimitUsd: {
            tier1: { type: Number, required: true, default: DEFAULT_TIER_DAILY_LIMIT_USD.tier1, min: 0 },
            tier2: { type: Number, required: true, default: DEFAULT_TIER_DAILY_LIMIT_USD.tier2, min: 0 },
        },
        updatedBy: { type: Schema.Types.ObjectId, ref: MODEL_NAME.USER },
    },
    { timestamps: true, toObject: { virtuals: true }, toJSON: { virtuals: true } },
);

const PlatformSettings: Model<IPlatformSettings> = model<IPlatformSettings>(
    MODEL_NAME.PLATFORM_SETTINGS,
    PlatformSettingsSchema,
);
export default PlatformSettings;
