import Transaction from "../models/transaction.model";
import { ROLE_MAP, TRANSACTION_STATUS } from "../common/constant";
import { IDENTITY_STATUS } from "../common/identity.constants";
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

/**
 * One-off, idempotent migration for accounts created before BVN verification.
 * Only touches users without an identity record, so it's a no-op afterwards.
 *   - Already verified (an earlier Smile ID pass, an approved KYC/KYB, or Tier 2+):
 *     counted as verified and keep their tier
 *   - Other customers on Tier 1 never verified who they are: Unverified until
 *     they verify their BVN
 */
export async function migrateIdentity(): Promise<void> {
    const at = new Date();
    const verified = await User.updateMany(
        { identity: { $exists: false }, $or: [{ tier: { $gte: USER_TIER.BUSINESS } }, { isKYCDone: true }] },
        { $set: { identity: { status: IDENTITY_STATUS.VERIFIED, method: "verified_before_bvn_checks" } } }
    );
    const unverified = await User.updateMany(
        { identity: { $exists: false }, role: ROLE_MAP.USER, tier: { $lte: USER_TIER.INDIVIDUAL } },
        {
            $set: { identity: { status: IDENTITY_STATUS.UNVERIFIED }, tier: USER_TIER.UNVERIFIED },
            $push: { tierHistory: { tier: USER_TIER.UNVERIFIED, reason: "BVN verification is now required for Tier 1", at } },
        }
    );
    // Staff accounts don't transact; just give them a record
    const others = await User.updateMany({ identity: { $exists: false } }, { $set: { identity: { status: IDENTITY_STATUS.UNVERIFIED } } });

    if (verified.modifiedCount + unverified.modifiedCount + others.modifiedCount) {
        logger.info("Identity verification migrated", {
            alreadyVerified: verified.modifiedCount,
            movedToUnverified: unverified.modifiedCount,
            staff: others.modifiedCount,
        });
    }
}

/**
 * Before tiers, unverified users' sends waited in "awaiting KYC verification"
 * after the payment receipt was uploaded. Tier 1 sends don't need KYC (the
 * daily limit applies instead), so release them to ops, as an approved KYC
 * would. Idempotent: nothing sets that status any more.
 */
export async function releaseLegacyKycHolds(): Promise<void> {
    const result = await Transaction.updateMany(
        { status: TRANSACTION_STATUS.AWAITING_KYC_VERIFICATION },
        { $set: { status: TRANSACTION_STATUS.AWAITING_CONFIRMATION } }
    );
    if (result.modifiedCount) {
        logger.info("Released transactions held for KYC before tiers", { released: result.modifiedCount });
    }
}
