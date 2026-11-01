import { createHmac } from "crypto";
import mongoose from "mongoose";
import User from "../models/user.model";
import Verification from "../models/verification.model";
import { IUser, IVerification } from "../models/interface";
import SmileId, { personalInfoFrom, SmileImage, SmileJobRef, SmilePersonalInfo } from "./smile-id.service";
import AuditLogService from "./audit-log.service";
import NotificationService from "../utils/notification.utils";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { TIER_NAME, USER_TIER } from "../common/tier.constants";
import {
    BVN_ATTEMPT_WINDOW_MS,
    BVN_MAX_FAILED_ATTEMPTS,
    BVN_MAX_IMAGE_CHARS,
    BVN_MAX_IMAGES,
    BVN_PENDING_TIMEOUT_MS,
    BVN_POLL_AFTER_MS,
    BVN_POLL_INTERVAL_MS,
    DETAILS_MAX_LOOKUPS,
    IDENTITY_REQUIRED_CODE,
    IDENTITY_STATUS,
    IdentityStatus,
    isBvn,
    isNin,
    TRANSFER_DETAILS_REQUIRED_CODE,
    TransferDetail,
} from "../common/identity.constants";
import { decryptIdentity, encryptIdentity } from "../utils/identity-crypto.utils";
import { matchNameOnId } from "../utils/name-match.utils";
import config from "../config/env.config";
import logger from "../utils/logger.utils";

const SMILE_METHOD = "smile_id_bvn";
const PASSING = { id: ["Verified", "Passed"], liveness: ["Passed"], compare: ["Completed", "Passed"] };

export interface IdentityStatusView {
    status: IdentityStatus;
    tier: number;
    bvnLast4?: string;
    verifiedName?: string;
    verifiedAt?: Date;
    failureReason?: string;
    /** The check waiting on Smile ID, if any */
    pending: { id: string; startedAt?: Date } | null;
    attempts: { used: number; max: number; retryAt: Date | null };
    transferDetails: TransferDetailsView;
}

/** Whether the details YellowCard needs on every transfer are on file (never the numbers themselves) */
export interface TransferDetailsView {
    /** False on YellowCard's sandbox, where missing details fall back to placeholders */
    required: boolean;
    complete: boolean;
    missing: TransferDetail[];
    bvnLast4?: string;
    ninLast4?: string;
    dob?: string;
    address?: string;
}

/** The person block YellowCard requires for a Nigerian sender (payments) or recipient (collections) */
export interface YellowCardPerson {
    name: string;
    country: string;
    phone: string;
    address: string;
    /** YYYY-MM-DD; the YellowCard client formats it */
    dob: string;
    email: string;
    idType: string;
    idNumber: string;
    additionalIdType?: string;
    additionalIdNumber?: string;
}

/** Phone numbers from Smile ID come as 080…, 234… or +234… */
export const toNigerianIntl = (phone?: string): string | undefined => {
    const digits = (phone || "").replace(/[^\d+]/g, "");
    if (!digits) return undefined;
    if (digits.startsWith("+")) return digits.length >= 8 ? digits : undefined;
    if (digits.startsWith("234") && digits.length >= 13) return `+${digits}`;
    if (digits.startsWith("0") && digits.length === 11) return `+234${digits.slice(1)}`;
    if (digits.length === 10) return `+234${digits}`;
    return undefined;
};

const yearsSince = (isoDate: string) => {
    const born = new Date(`${isoDate}T00:00:00Z`);
    const now = new Date();
    let age = now.getUTCFullYear() - born.getUTCFullYear();
    if (now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate())) age--;
    return age;
};

type Outcome = { passed: true; nameOnId?: string } | { passed: false; reason: string; nameOnId?: string };

const badRequest = (message: string, code?: string) =>
    errorResponseMessage.createError(400, message, ErrorSeverity.LOW, code ? { code } : undefined);

/**
 * BVN verification with Smile ID (Biometric KYC: BVN lookup plus a live selfie
 * compared with the BVN photo). Passing moves an Unverified account to Tier 1.
 *
 * The BVN is only sent to Smile ID; we keep a keyed hash (one BVN per account)
 * and its last 4 digits. Results arrive by webhook; if one doesn't, the status
 * endpoint asks Smile ID directly, so nobody is left pending.
 */
class IdentityService {
    private smileId = new SmileId();
    private auditLog = new AuditLogService();
    private notifications = new NotificationService();

    hashBvn(bvn: string): string {
        return createHmac("sha256", config.IDENTITY_HASH_SECRET).update(`bvn:${bvn}`).digest("hex");
    }

    hashNin(nin: string): string {
        return createHmac("sha256", config.IDENTITY_HASH_SECRET).update(`nin:${nin}`).digest("hex");
    }

    /** Each attempt is its own Smile ID user, so a retry never collides with an earlier enrollment */
    private smileRef(verification: Pick<IVerification, "user" | "id">): SmileJobRef {
        return { userId: `${String(verification.user)}-${verification.id}`, jobId: String(verification.id) };
    }

    private async countedFailures(userId: string) {
        return Verification.find({
            user: userId,
            kind: "bvn",
            status: "failed",
            excludedFromAttempts: { $ne: true },
            createdAt: { $gte: new Date(Date.now() - BVN_ATTEMPT_WINDOW_MS) },
        }).select("createdAt").sort({ createdAt: 1 }).lean();
    }

    private async attempts(userId: string): Promise<IdentityStatusView["attempts"]> {
        const failures = await this.countedFailures(userId);
        const retryAt = failures.length >= BVN_MAX_FAILED_ATTEMPTS
            ? new Date(new Date(failures[failures.length - BVN_MAX_FAILED_ATTEMPTS].createdAt!).getTime() + BVN_ATTEMPT_WINDOW_MS)
            : null;
        return { used: failures.length, max: BVN_MAX_FAILED_ATTEMPTS, retryAt };
    }

    /** The user's verification state; also chases Smile ID for a result that's overdue */
    async getStatus(userId: string): Promise<IdentityStatusView> {
        let pending = await Verification.findOne({ user: userId, kind: "bvn", status: "pending" });
        if (pending) {
            await this.checkPending(pending);
            pending = await Verification.findOne({ user: userId, kind: "bvn", status: "pending" });
        }

        const user = await User.findById(userId).select("+identity.bvnEnc +identity.ninEnc").lean();
        if (!user) throw errorResponseMessage.resourceNotFound("User");
        const identity = user.identity;
        const verified = identity?.status === IDENTITY_STATUS.VERIFIED;
        return {
            status: pending ? IDENTITY_STATUS.PENDING : identity?.status ?? IDENTITY_STATUS.UNVERIFIED,
            tier: user.tier ?? USER_TIER.UNVERIFIED,
            bvnLast4: identity?.bvnLast4,
            verifiedName: verified ? identity?.verifiedName : undefined,
            verifiedAt: verified ? identity?.verifiedAt : undefined,
            failureReason: identity?.status === IDENTITY_STATUS.FAILED ? identity?.failureReason : undefined,
            pending: pending ? { id: pending.id, startedAt: pending.createdAt } : null,
            attempts: await this.attempts(userId),
            transferDetails: this.detailsView(user as IUser),
        };
    }

    /** What's on file for YellowCard transfers. Expects identity.bvnEnc and ninEnc selected. */
    private detailsView(user: Pick<IUser, "identity" | "phoneNumber">): TransferDetailsView {
        const identity = user.identity;
        const missing: TransferDetail[] = [];
        if (!identity?.bvnEnc) missing.push("bvn");
        if (!identity?.ninEnc) missing.push("nin");
        if (!identity?.dob) missing.push("dob");
        if (!identity?.address) missing.push("address");
        if (!toNigerianIntl(identity?.idPhone) && !toNigerianIntl(user.phoneNumber)) missing.push("phone");
        return {
            required: config.YELLOWCARD_REQUIRE_KYC,
            complete: missing.length === 0,
            missing,
            bvnLast4: identity?.bvnLast4,
            ninLast4: identity?.ninLast4,
            dob: identity?.dob,
            address: identity?.address,
        };
    }

    /** Starts a BVN check: validates, enforces limits, and submits to Smile ID */
    async submitBvn(user: IUser, bvn: unknown, images: unknown, nin?: unknown): Promise<IdentityStatusView> {
        const userId = String(user._id);
        if ((user.tier ?? USER_TIER.UNVERIFIED) >= USER_TIER.INDIVIDUAL || user.identity?.status === IDENTITY_STATUS.VERIFIED) {
            throw errorResponseMessage.createError(409, "Your identity is already verified", ErrorSeverity.LOW, { code: "IDENTITY_ALREADY_VERIFIED" });
        }
        if (!isBvn(bvn)) throw badRequest("Enter your 11-digit BVN", "INVALID_BVN");
        if (!isNin(nin)) throw badRequest("Enter your 11-digit NIN", "INVALID_NIN");
        if (nin === bvn) throw badRequest("Your NIN and BVN are different numbers. Check your NIN.", "INVALID_NIN");
        const selfie = this.validateImages(images);

        const existing = await Verification.findOne({ user: userId, kind: "bvn", status: "pending" });
        if (existing) {
            await this.checkPending(existing);
            if (await Verification.exists({ _id: existing._id, status: "pending" })) {
                throw errorResponseMessage.createError(409, "We're still checking your last submission. This usually takes a minute or two.", ErrorSeverity.LOW, { code: "IDENTITY_PENDING" });
            }
        }

        const attempts = await this.attempts(userId);
        if (attempts.retryAt) {
            throw errorResponseMessage.createError(
                429,
                `You've reached the limit of ${BVN_MAX_FAILED_ATTEMPTS} attempts. You can try again after ${attempts.retryAt.toUTCString()}, or contact support for help.`,
                ErrorSeverity.LOW,
                { code: "IDENTITY_ATTEMPTS_EXCEEDED", retryAt: attempts.retryAt }
            );
        }

        const idHash = this.hashBvn(bvn);
        if (await User.exists({ _id: { $ne: user._id }, "identity.bvnHash": idHash })) {
            throw errorResponseMessage.createError(409, "This BVN is already linked to another SolutionPay account. Contact support if you think this is a mistake.", ErrorSeverity.LOW, { code: "BVN_IN_USE" });
        }

        const ninHash = this.hashNin(nin);
        if (await User.exists({ _id: { $ne: user._id }, "identity.ninHash": ninHash })) {
            throw errorResponseMessage.createError(409, "This NIN is already linked to another SolutionPay account. Contact support if you think this is a mistake.", ErrorSeverity.LOW, { code: "NIN_IN_USE" });
        }

        let verification;
        try {
            verification = await Verification.create({
                user: user._id, kind: "bvn", status: "pending", idHash, idLast4: bvn.slice(-4),
                bvnEnc: encryptIdentity(bvn), ninEnc: encryptIdentity(nin), ninHash, ninLast4: nin.slice(-4),
            });
        } catch (error: any) {
            if (error?.code === 11000) {
                throw errorResponseMessage.createError(409, "We're still checking your last submission. This usually takes a minute or two.", ErrorSeverity.LOW, { code: "IDENTITY_PENDING" });
            }
            throw error;
        }

        try {
            const { smileJobId } = await this.smileId.submitBvnBiometricKyc(
                this.smileRef(verification),
                { firstName: user.firstName, lastName: user.lastName },
                bvn,
                selfie
            );
            await Verification.updateOne({ _id: verification._id }, { $set: { smileJobId } });
        } catch (error: any) {
            // Our partner didn't take the job: not the user's fault, so it doesn't use an attempt
            await Verification.updateOne(
                { _id: verification._id },
                { $set: { status: "failed", reason: "Submission to Smile ID failed", excludedFromAttempts: true, completedAt: new Date() }, $unset: ENCRYPTED_IDS }
            );
            throw errorResponseMessage.createError(500, "We couldn't reach our verification partner. Please try again in a few minutes.", ErrorSeverity.MEDIUM);
        }

        await User.updateOne(
            { _id: user._id, "identity.status": { $ne: IDENTITY_STATUS.VERIFIED } },
            { $set: { "identity.status": IDENTITY_STATUS.PENDING }, $unset: { "identity.failureReason": "" } }
        );
        await this.auditLog.logAction(undefined, userId, "IDENTITY_BVN_SUBMITTED", undefined, { verificationId: verification.id, bvnLast4: bvn.slice(-4) });
        return this.getStatus(userId);
    }

    private validateImages(images: unknown): SmileImage[] {
        if (!Array.isArray(images) || images.length === 0) throw badRequest("Take a selfie to continue", "SELFIE_REQUIRED");
        if (images.length > BVN_MAX_IMAGES) throw badRequest("Too many images. Please retake your selfie.");
        return images.map((item, index) => {
            const image = (item as any)?.image;
            const imageTypeId = (item as any)?.image_type_id;
            if (typeof image !== "string" || !image || typeof imageTypeId !== "number") {
                throw badRequest(`Selfie image ${index + 1} is invalid. Please retake your selfie.`);
            }
            if (image.length > BVN_MAX_IMAGE_CHARS) throw badRequest("Your selfie is too large. Please retake it.");
            return { image, image_type_id: imageTypeId };
        });
    }

    /** Polls Smile ID for an overdue result, and gives up on checks that never finished */
    private async checkPending(verification: IVerification) {
        const age = Date.now() - new Date(verification.createdAt!).getTime();
        const lastPolled = verification.lastPolledAt ? Date.now() - new Date(verification.lastPolledAt).getTime() : Infinity;

        if (age >= BVN_POLL_AFTER_MS && lastPolled >= BVN_POLL_INTERVAL_MS) {
            await Verification.updateOne({ _id: verification._id }, { $set: { lastPolledAt: new Date() } });
            const status = await this.smileId.getJobStatus(this.smileRef(verification));
            if (status?.job_complete && status.result && typeof status.result === "object") {
                await this.handleSmileResult(status.result, "poll");
                return;
            }
        }

        if (age >= BVN_PENDING_TIMEOUT_MS) {
            const expired = await Verification.updateOne(
                { _id: verification._id, status: "pending" },
                { $set: { status: "failed", reason: "No result from Smile ID in time", excludedFromAttempts: true, completedAt: new Date() }, $unset: ENCRYPTED_IDS }
            );
            if (expired.modifiedCount) {
                await User.updateOne(
                    { _id: verification.user, "identity.status": IDENTITY_STATUS.PENDING },
                    { $set: { "identity.status": IDENTITY_STATUS.FAILED, "identity.failureReason": "We didn't get a result in time. Please try again." } }
                );
            }
        }
    }

    /** Decides a finished Smile ID job */
    private evaluate(result: any, account: { firstName?: string; lastName?: string }): Outcome {
        const actions = result?.Actions && typeof result.Actions === "object" ? result.Actions : {};
        if (process.env.FORCE_VERIFY === "true" && process.env.NODE_ENV !== "production") {
            return { passed: true };
        }

        if (!PASSING.id.includes(actions.Verify_ID_Number)) {
            return { passed: false, reason: "We couldn't verify that BVN. Check the number and try again." };
        }
        const liveness = actions.Liveness_Check ?? actions.Selfie_Check;
        if (!PASSING.liveness.includes(liveness)) {
            return { passed: false, reason: "We couldn't confirm your selfie was taken live. Try again in good light, facing the camera." };
        }
        if (actions.Register_Selfie === "Rejected") {
            return { passed: false, reason: "Your selfie couldn't be used. Try again in good light, without glasses or a face covering." };
        }
        if (!PASSING.compare.includes(actions.Selfie_To_ID_Authority_Compare)) {
            return { passed: false, reason: "Your selfie didn't match the photo on your BVN record. Try again in good light, without glasses or a face covering." };
        }

        const info = result?.PersonalInfo ?? result?.personal_info ?? {};
        const name = matchNameOnId(account, {
            fullName: result?.FullName ?? info.FullName ?? info.full_name,
            firstName: info.FirstName ?? info.first_name,
            lastName: info.LastName ?? info.last_name,
            otherNames: info.MiddleName ?? info.OtherNames ?? info.middle_name,
        });
        if (name.match === false) {
            return {
                passed: false,
                nameOnId: name.nameOnId,
                reason: `The name on this BVN (${name.nameOnId}) doesn't match your account name (${account.firstName} ${account.lastName}). Contact support if your account name needs correcting.`,
            };
        }
        // No name returned: the selfie already matched the BVN photo, so the BVN is theirs
        return { passed: true, nameOnId: name.nameOnId ?? undefined };
    }

    /**
     * Applies a Smile ID result from the webhook or a status lookup. Idempotent:
     * a job that's already been decided is left alone.
     */
    async handleSmileResult(result: any, source: "webhook" | "poll"): Promise<{ handled: boolean; outcome?: "passed" | "failed" | "waiting"; reason?: string }> {
        const jobId = result?.PartnerParams?.job_id;
        if (typeof jobId !== "string" || !mongoose.isValidObjectId(jobId)) return { handled: false, reason: "Unknown job" };

        const verification = await Verification.findById(jobId).select("+idHash +bvnEnc +ninEnc +ninHash");
        if (!verification || verification.kind !== "bvn") return { handled: false, reason: "Unknown job" };
        if (result?.PartnerParams?.user_id !== this.smileRef(verification).userId) return { handled: false, reason: "Job doesn't match user" };
        if (verification.status !== "pending") return { handled: true, reason: "Already decided" };

        const resultCode = result?.ResultCode !== undefined ? String(result.ResultCode) : undefined;
        const details = {
            resultCode,
            resultText: typeof result?.ResultText === "string" ? result.ResultText : undefined,
            actions: result?.Actions && typeof result.Actions === "object" ? result.Actions : undefined,
            smileJobId: result?.SmileJobID ?? verification.smileJobId,
        };

        const isFinal = result?.IsFinalResult === true || result?.IsFinalResult === "true";
        if (!isFinal) {
            await Verification.updateOne({ _id: verification._id, status: "pending" }, { $set: details });
            return { handled: true, outcome: "waiting" };
        }

        const user = await User.findById(verification.user).select("firstName lastName email tier identity");
        if (!user) return { handled: false, reason: "User not found" };

        let outcome = this.evaluate(result, user);
        if (outcome.passed) {
            const info = personalInfoFrom(result);
            this.logRecordFields("bvn", info);
            try {
                await User.updateOne(
                    { _id: user._id },
                    {
                        $set: {
                            "identity.status": IDENTITY_STATUS.VERIFIED,
                            "identity.bvnHash": verification.idHash,
                            "identity.bvnLast4": verification.idLast4,
                            "identity.verifiedName": outcome.nameOnId,
                            "identity.verifiedAt": new Date(),
                            "identity.method": SMILE_METHOD,
                            ...this.detailsUpdate({
                                bvnEnc: verification.bvnEnc,
                                ninEnc: verification.ninEnc,
                                ninHash: verification.ninHash,
                                ninLast4: verification.ninLast4,
                                info,
                            }),
                        },
                        $unset: { "identity.failureReason": "" },
                    }
                );
            } catch (error: any) {
                if (error?.code !== 11000) throw error;
                outcome = { passed: false, reason: "This BVN or NIN is already linked to another SolutionPay account. Contact support if you think this is a mistake." };
            }
        }

        const claimed = await Verification.updateOne(
            { _id: verification._id, status: "pending" },
            {
                $set: {
                    ...details,
                    status: outcome.passed ? "passed" : "failed",
                    ...(outcome.passed ? {} : { reason: outcome.reason }),
                    nameOnId: outcome.nameOnId,
                    resultSource: source,
                    completedAt: new Date(),
                },
                // The numbers now live (encrypted) on the user, or aren't needed
                $unset: ENCRYPTED_IDS,
            }
        );
        // The webhook and a status lookup can race: only the first one finishes the job
        if (!claimed.modifiedCount) return { handled: true, reason: "Already decided" };

        if (outcome.passed) {
            const promoted = await User.updateOne(
                { _id: user._id, tier: { $lt: USER_TIER.INDIVIDUAL } },
                {
                    $set: { tier: USER_TIER.INDIVIDUAL },
                    $push: { tierHistory: { tier: USER_TIER.INDIVIDUAL, reason: "BVN verified", at: new Date() } },
                }
            );
            // Older accounts may have no tier field at all
            if (!promoted.modifiedCount) {
                await User.updateOne(
                    { _id: user._id, tier: { $exists: false } },
                    { $set: { tier: USER_TIER.INDIVIDUAL }, $push: { tierHistory: { tier: USER_TIER.INDIVIDUAL, reason: "BVN verified", at: new Date() } } }
                );
            }
        } else {
            await User.updateOne(
                { _id: user._id, "identity.status": { $ne: IDENTITY_STATUS.VERIFIED } },
                { $set: { "identity.status": IDENTITY_STATUS.FAILED, "identity.failureReason": outcome.reason } }
            );
        }

        logger.info("BVN verification decided", { verificationId: verification.id, outcome: outcome.passed ? "passed" : "failed", resultCode, source });
        await this.auditLog.logAction(undefined, String(user._id), outcome.passed ? "IDENTITY_BVN_VERIFIED" : "IDENTITY_BVN_FAILED", undefined, {
            verificationId: verification.id,
            resultCode,
            ...(outcome.passed ? {} : { reason: outcome.reason }),
        });
        await this.sendResultEmail(user, outcome);
        return { handled: true, outcome: outcome.passed ? "passed" : "failed", ...(outcome.passed ? {} : { reason: outcome.reason }) };
    }

    /** $set fields for the details YellowCard needs; only what's known is written */
    private detailsUpdate(input: { bvnEnc?: string; ninEnc?: string; ninHash?: string; ninLast4?: string; info?: SmilePersonalInfo; dob?: string; address?: string }) {
        const set: Record<string, unknown> = {};
        if (input.bvnEnc) set["identity.bvnEnc"] = input.bvnEnc;
        if (input.ninEnc) {
            set["identity.ninEnc"] = input.ninEnc;
            set["identity.ninHash"] = input.ninHash;
            set["identity.ninLast4"] = input.ninLast4;
        }
        const dob = input.info?.dob || input.dob;
        const address = input.info?.address || input.address;
        if (dob) set["identity.dob"] = dob;
        if (address) set["identity.address"] = address.slice(0, 300);
        if (toNigerianIntl(input.info?.phone)) set["identity.idPhone"] = toNigerianIntl(input.info?.phone);
        if (Object.keys(set).length) set["identity.detailsUpdatedAt"] = new Date();
        return set;
    }

    /**
     * Which fields an ID record came back with (never the values), so we can
     * see in production what Smile ID returns, e.g. whether the BVN record
     * carries a secondary ID number.
     */
    private logRecordFields(idType: string, info: SmilePersonalInfo) {
        logger.info("Smile ID record fields", {
            idType,
            present: Object.entries(info).filter(([, value]) => !!value).map(([key]) => key),
            secondaryIdDigits: info.secondaryIdNumber ? info.secondaryIdNumber.replace(/\D/g, "").length : 0,
        });
    }

    async transferDetails(userId: string): Promise<TransferDetailsView> {
        const user = await User.findById(userId).select("+identity.bvnEnc +identity.ninEnc").lean();
        if (!user) throw errorResponseMessage.resourceNotFound("User");
        return this.detailsView(user as IUser);
    }

    /**
     * Completes the details YellowCard needs, for verified accounts that don't
     * have them yet (verified before NIN was asked, or a record with no
     * address). The BVN must be the one they verified with; it's looked up
     * again (no selfie) to fill in date of birth, phone and address.
     */
    async submitTransferDetails(user: IUser, body: { bvn?: unknown; nin?: unknown; dob?: unknown; address?: unknown }): Promise<TransferDetailsView> {
        const userId = String(user._id);
        const current = await User.findById(userId).select("+identity.bvnHash +identity.bvnEnc +identity.ninEnc").lean();
        if (!current) throw errorResponseMessage.resourceNotFound("User");
        if (current.identity?.status !== IDENTITY_STATUS.VERIFIED) {
            throw errorResponseMessage.createError(403, "Verify your identity first. It takes about 2 minutes.", ErrorSeverity.LOW, { code: IDENTITY_REQUIRED_CODE });
        }
        const identity = current.identity;
        const set: Record<string, unknown> = {};
        let info: SmilePersonalInfo = {};

        // BVN: only if we don't hold it yet
        if (!identity.bvnEnc) {
            const bvn = body.bvn;
            if (!isBvn(bvn)) throw badRequest("Enter your 11-digit BVN", "INVALID_BVN");
            const bvnHash = this.hashBvn(bvn);
            if (identity.bvnHash && identity.bvnHash !== bvnHash) {
                throw badRequest(`That isn't the BVN you verified with (ending ${identity.bvnLast4}). Check the number and try again.`, "BVN_MISMATCH");
            }
            if (!identity.bvnHash && await User.exists({ _id: { $ne: current._id }, "identity.bvnHash": bvnHash })) {
                throw errorResponseMessage.createError(409, "This BVN is already linked to another SolutionPay account. Contact support if you think this is a mistake.", ErrorSeverity.LOW, { code: "BVN_IN_USE" });
            }
            const lookup = await this.lookup(current as IUser, "BVN", bvn);
            if (!lookup.verified) throw badRequest("We couldn't find that BVN. Check the number and try again.", "INVALID_BVN");
            // Accounts verified before BVN checks prove the BVN is theirs by name
            if (!identity.bvnHash) this.assertNameMatches(current as IUser, lookup.info, "BVN");
            info = lookup.info;
            this.logRecordFields("bvn", info);
            Object.assign(set, this.detailsUpdate({ bvnEnc: encryptIdentity(bvn), info }));
            if (!identity.bvnHash) {
                set["identity.bvnHash"] = bvnHash;
                set["identity.bvnLast4"] = bvn.slice(-4);
            }
        }

        // NIN
        if (!identity.ninEnc) {
            const nin = body.nin;
            if (!isNin(nin)) throw badRequest("Enter your 11-digit NIN", "INVALID_NIN");
            if (typeof body.bvn === "string" && nin === body.bvn) throw badRequest("Your NIN and BVN are different numbers. Check your NIN.", "INVALID_NIN");
            const ninHash = this.hashNin(nin);
            if (await User.exists({ _id: { $ne: current._id }, "identity.ninHash": ninHash })) {
                throw errorResponseMessage.createError(409, "This NIN is already linked to another SolutionPay account. Contact support if you think this is a mistake.", ErrorSeverity.LOW, { code: "NIN_IN_USE" });
            }
            if (config.SMILE_ID_VERIFY_NIN) {
                const lookup = await this.lookup(current as IUser, "NIN_V2", nin);
                if (!lookup.verified) throw badRequest("We couldn't find that NIN. Check the number and try again.", "INVALID_NIN");
                this.assertNameMatches(current as IUser, lookup.info, "NIN");
                this.logRecordFields("nin", lookup.info);
                info = { ...lookup.info, ...info };
            }
            Object.assign(set, this.detailsUpdate({ ninEnc: encryptIdentity(nin), ninHash, ninLast4: nin.slice(-4), info }));
        }

        // Date of birth and address: from the ID record, else what the user typed
        let typedProblem: ReturnType<typeof badRequest> | undefined;
        if (!((set["identity.dob"] as string) || identity.dob)) {
            const typed = typeof body.dob === "string" ? body.dob.trim() : "";
            if (!/^\d{4}-\d{2}-\d{2}$/.test(typed) || isNaN(Date.parse(typed))) typedProblem = badRequest("Enter your date of birth", "INVALID_DOB");
            else if (yearsSince(typed) < 18) typedProblem = badRequest("You must be at least 18 to send money abroad", "INVALID_DOB");
            else if (yearsSince(typed) > 120) typedProblem = badRequest("Check your date of birth", "INVALID_DOB");
            else set["identity.dob"] = typed;
        }
        if (!((set["identity.address"] as string) || identity.address)) {
            const typed = typeof body.address === "string" ? body.address.trim().replace(/\s+/g, " ") : "";
            if (typed.length < 10) typedProblem ??= badRequest("Enter your home address, including the street, town and state", "INVALID_ADDRESS");
            else set["identity.address"] = typed.slice(0, 300);
        }

        // Save what we have (e.g. a paid lookup's result) even if something typed needs fixing
        if (Object.keys(set).length) {
            set["identity.detailsUpdatedAt"] = new Date();
            try {
                await User.updateOne({ _id: current._id }, { $set: set });
            } catch (error: any) {
                if (error?.code !== 11000) throw error;
                throw errorResponseMessage.createError(409, "This BVN or NIN is already linked to another SolutionPay account. Contact support if you think this is a mistake.", ErrorSeverity.LOW, { code: "ID_IN_USE" });
            }
            await this.auditLog.logAction(undefined, userId, "IDENTITY_TRANSFER_DETAILS_UPDATED", undefined, {
                fields: Object.keys(set).filter((key) => !/Enc$|Hash$|detailsUpdatedAt/.test(key)).map((key) => key.replace("identity.", "")),
            });
        }
        if (typedProblem) throw typedProblem;
        return this.transferDetails(userId);
    }

    /** A paid Smile ID lookup, limited per user per day, and recorded for support */
    private async lookup(user: IUser, idType: "BVN" | "NIN_V2", idNumber: string) {
        const recent = await Verification.countDocuments({ user: user._id, kind: "details", createdAt: { $gte: new Date(Date.now() - BVN_ATTEMPT_WINDOW_MS) } });
        if (recent >= DETAILS_MAX_LOOKUPS) {
            throw errorResponseMessage.createError(429, "You've tried too many times today. Please try again tomorrow, or contact support for help.", ErrorSeverity.LOW, { code: "DETAILS_ATTEMPTS_EXCEEDED" });
        }
        const check = await Verification.create({ user: user._id, kind: "details", status: "pending", idLast4: idNumber.slice(-4), reason: `${idType} lookup` });
        try {
            const result = await this.smileId.lookupId(
                { userId: `${String(user._id)}-${check.id}`, jobId: String(check.id) },
                { firstName: user.firstName, lastName: user.lastName },
                idType,
                idNumber
            );
            await Verification.updateOne({ _id: check._id }, {
                $set: { status: result.verified ? "passed" : "failed", resultCode: result.resultCode, resultText: result.resultText, completedAt: new Date() },
            });
            return result;
        } catch (error) {
            await Verification.updateOne({ _id: check._id }, { $set: { status: "failed", reason: `${idType} lookup: Smile ID unavailable`, completedAt: new Date() } });
            throw errorResponseMessage.createError(500, "We couldn't reach our verification partner. Please try again in a few minutes.", ErrorSeverity.MEDIUM);
        }
    }

    private assertNameMatches(user: IUser, info: SmilePersonalInfo, idName: string) {
        if (process.env.FORCE_VERIFY === "true" && process.env.NODE_ENV !== "production") return;
        const name = matchNameOnId(user, { fullName: info.fullName, firstName: info.firstName, lastName: info.lastName, otherNames: info.otherNames });
        if (name.match === false) {
            throw badRequest(`The name on this ${idName} (${name.nameOnId}) doesn't match your account name (${user.firstName} ${user.lastName}). Contact support if your account name needs correcting.`, `${idName}_NAME_MISMATCH`);
        }
    }

    /** Refuses with TRANSFER_DETAILS_REQUIRED when YellowCard would need details that aren't on file */
    async assertTransferDetails(userId: string): Promise<void> {
        const view = await this.transferDetails(userId);
        if (view.required && !view.complete) {
            throw errorResponseMessage.createError(
                403,
                "Add your NIN and a few details to send or receive money abroad. You only need to do this once.",
                ErrorSeverity.LOW,
                { code: TRANSFER_DETAILS_REQUIRED_CODE, missing: view.missing }
            );
        }
    }

    /**
     * The person YellowCard needs on a transfer: the sender on sends, the
     * recipient on receives (always our user). Built only from our records,
     * never from the request. For Nigeria: NIN as the ID, BVN as the
     * additional ID. Missing details refuse the transfer, except on
     * YellowCard's sandbox, which gets placeholders.
     */
    async yellowCardPerson(userId: string): Promise<YellowCardPerson> {
        const user = await User.findById(userId).select("+identity.bvnEnc +identity.ninEnc").lean();
        if (!user) throw errorResponseMessage.resourceNotFound("User");
        const view = this.detailsView(user as IUser);
        const identity = user.identity;
        const name = `${user.firstName || ""} ${user.lastName || ""}`.trim() || identity?.verifiedName || "Customer";
        const phone = toNigerianIntl(identity?.idPhone) || toNigerianIntl(user.phoneNumber);

        if (!view.complete) {
            if (config.YELLOWCARD_REQUIRE_KYC) {
                throw errorResponseMessage.createError(
                    403,
                    "Add your NIN and a few details to send or receive money abroad. You only need to do this once.",
                    ErrorSeverity.LOW,
                    { code: TRANSFER_DETAILS_REQUIRED_CODE, missing: view.missing }
                );
            }
            logger.warn("YellowCard sandbox: using placeholder KYC details", { userId, missing: view.missing });
        }

        const bvn = identity?.bvnEnc ? decryptIdentity(identity.bvnEnc) : undefined;
        const nin = identity?.ninEnc ? decryptIdentity(identity.ninEnc) : undefined;
        return {
            name,
            country: "NG",
            phone: phone || "+2340000000000",
            address: identity?.address || "N/A",
            dob: identity?.dob || "1990-01-01",
            email: user.email || "",
            idType: nin ? "NIN" : "license",
            idNumber: nin || "0000",
            ...(bvn ? { additionalIdType: "BVN", additionalIdNumber: bvn } : {}),
        };
    }

    private async sendResultEmail(user: IUser, outcome: Outcome) {
        try {
            await this.notifications.emailService.sendNotificationEmail(user.email, outcome.passed
                ? {
                    title: "Your identity is verified",
                    eyebrow: "Verification",
                    name: user.firstName,
                    message: `Your identity is verified and your account is now on <strong>Tier 1 (${TIER_NAME[USER_TIER.INDIVIDUAL]})</strong>. You can start sending, receiving and exchanging money.`,
                    actionUrl: `${config.FRONTEND_URL}/dashboard/user`,
                    buttonText: "Go to Dashboard",
                }
                : {
                    title: "We couldn't verify your identity",
                    eyebrow: "Verification",
                    name: user.firstName,
                    message: `Your identity verification wasn't successful. ${escapeHtml(outcome.reason)}`,
                    actionUrl: `${config.FRONTEND_URL}/dashboard/user?verify=bvn`,
                    buttonText: "Try again",
                });
        } catch (error: any) {
            logger.error("Failed to send BVN verification email", { userId: String(user._id), error: error?.message });
        }
    }

    /** For the admin user page: state, attempts and recent checks */
    async adminSummary(userId: string) {
        const [status, recent] = await Promise.all([
            this.getStatus(userId),
            Verification.find({ user: userId }).sort({ createdAt: -1 }).limit(10)
                .select("kind status reason idLast4 smileJobId resultCode resultText nameOnId resultSource excludedFromAttempts createdAt completedAt")
                .lean(),
        ]);
        const user = await User.findById(userId).select("identity").lean();
        return {
            ...status,
            // transferDetails (in status) says what's on file, never the numbers
            verifiedName: user?.identity?.verifiedName,
            verifiedAt: user?.identity?.verifiedAt,
            method: user?.identity?.method,
            checks: recent.map((check) => ({ id: String(check._id), ...check, _id: undefined })),
        };
    }

    /**
     * Undoes a user's identity verification: back to Unverified (tier 0) with
     * nothing on file (BVN, NIN, date of birth, address), so they verify from
     * scratch. Also clears their failed attempts. For accounts verified in
     * error, or for testing the full flow again.
     */
    async adminResetVerification(admin: IUser, userId: string, reason: string) {
        const before = await User.findById(userId).select("tier identity").lean();
        if (!before) throw errorResponseMessage.resourceNotFound("User");
        await User.updateOne(
            { _id: userId },
            {
                $set: { tier: USER_TIER.UNVERIFIED, identity: { status: IDENTITY_STATUS.UNVERIFIED } },
                $push: { tierHistory: { tier: USER_TIER.UNVERIFIED, reason: `Verification reset by admin: ${reason}`, by: admin._id, at: new Date() } },
            }
        );
        // Any check still running is abandoned, and nothing counts against the next attempts
        await Verification.updateMany(
            { user: userId, status: "pending" },
            { $set: { status: "failed", reason: "Verification reset by admin", completedAt: new Date() }, $unset: ENCRYPTED_IDS }
        );
        await Verification.updateMany({ user: userId, kind: "bvn", status: "failed" }, { $set: { excludedFromAttempts: true } });
        await this.auditLog.logAction(
            undefined, userId, "IDENTITY_VERIFICATION_RESET",
            { tier: before.tier, status: before.identity?.status, bvnLast4: before.identity?.bvnLast4, ninLast4: before.identity?.ninLast4 },
            { tier: USER_TIER.UNVERIFIED, status: IDENTITY_STATUS.UNVERIFIED },
            undefined, undefined, { by: String(admin._id), reason }
        );
        logger.info("Identity verification reset by admin", { userId, by: String(admin._id), fromTier: before.tier });
        return this.adminSummary(userId);
    }

    /** Lets a user who used up their attempts try again (e.g. after support helped them) */
    async adminResetAttempts(admin: IUser, userId: string, reason: string) {
        const failures = await this.countedFailures(userId);
        if (failures.length) {
            await Verification.updateMany({ _id: { $in: failures.map((failure) => failure._id) } }, { $set: { excludedFromAttempts: true } });
        }
        await this.auditLog.logAction(undefined, userId, "IDENTITY_ATTEMPTS_RESET", { counted: failures.length }, { counted: 0 }, undefined, undefined, {
            by: String(admin._id),
            reason,
        });
        return this.adminSummary(userId);
    }
}

/** Encrypted numbers on a verification, removed once the check is decided */
const ENCRYPTED_IDS = { bvnEnc: "", ninEnc: "", ninHash: "" };

const escapeHtml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export default new IdentityService();
