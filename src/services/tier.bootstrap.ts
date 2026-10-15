import User from "../models/user.model";
import KycApplication from "../models/kyc-application.model";
import { KYC_STATUS } from "../common/kyc.constants";
import { USER_TIER } from "../common/tier.constants";
import logger from "../utils/logger.utils";

/**
 * One-off, idempotent migration for accounts created before tiers existed.
 * Only touches documents without a tier, so it's a no-op after the first run.
 *   - Applications: full KYB → Tier 3, individual KYC → Tier 2 (what they were assessed against)
 *   - Users with an approved application → that application's tier
 *   - Other verified users (e.g. Smile ID) → Tier 2, so nobody loses the access they had
 *   - Everyone else → Tier 1
 */
export async function migrateUserTiers(): Promise<void> {
    const reason = "Verified before account tiers were introduced";
    const at = new Date();

    const businessApps = await KycApplication.updateMany({ tier: { $exists: false }, type: "business" }, { $set: { tier: USER_TIER.INSTITUTION } });
    const individualApps = await KycApplication.updateMany({ tier: { $exists: false }, type: "individual" }, { $set: { tier: USER_TIER.BUSINESS } });

    const approved = await KycApplication.find({ status: KYC_STATUS.APPROVED }).select("user tier").lean();
    let fromApplications = 0;
    for (const application of approved) {
        const result = await User.updateOne(
            { _id: application.user, tier: { $exists: false } },
            { $set: { tier: application.tier }, $push: { tierHistory: { tier: application.tier, reason, at } } }
        );
        fromApplications += result.modifiedCount;
    }

    const verified = await User.updateMany(
        { tier: { $exists: false }, isKYCDone: true },
        { $set: { tier: USER_TIER.BUSINESS }, $push: { tierHistory: { tier: USER_TIER.BUSINESS, reason, at } } }
    );
    const others = await User.updateMany({ tier: { $exists: false } }, { $set: { tier: USER_TIER.INDIVIDUAL } });

    const changed = businessApps.modifiedCount + individualApps.modifiedCount + fromApplications + verified.modifiedCount + others.modifiedCount;
    if (changed) {
        logger.info("Account tiers migrated", {
            applications: businessApps.modifiedCount + individualApps.modifiedCount,
            usersFromApplications: fromApplications,
            verifiedUsers: verified.modifiedCount,
            tier1Users: others.modifiedCount,
        });
    }
}
