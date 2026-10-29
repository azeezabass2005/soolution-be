import { createHmac } from "crypto";
import mongoose from "mongoose";
import User from "../models/user.model";
import Verification from "../models/verification.model";
import { IUser, IVerification } from "../models/interface";
import SmileId, { SmileImage, SmileJobRef } from "./smile-id.service";
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
    IDENTITY_STATUS,
    IdentityStatus,
    isBvn,
} from "../common/identity.constants";
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
}

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

        const user = await User.findById(userId).select("tier identity").lean();
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
        };
    }

    /** Starts a BVN check: validates, enforces limits, and submits to Smile ID */
    async submitBvn(user: IUser, bvn: unknown, images: unknown): Promise<IdentityStatusView> {
        const userId = String(user._id);
        if ((user.tier ?? USER_TIER.UNVERIFIED) >= USER_TIER.INDIVIDUAL || user.identity?.status === IDENTITY_STATUS.VERIFIED) {
            throw errorResponseMessage.createError(409, "Your identity is already verified", ErrorSeverity.LOW, { code: "IDENTITY_ALREADY_VERIFIED" });
        }
        if (!isBvn(bvn)) throw badRequest("Enter your 11-digit BVN", "INVALID_BVN");
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

        let verification;
        try {
            verification = await Verification.create({ user: user._id, kind: "bvn", status: "pending", idHash, idLast4: bvn.slice(-4) });
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
                { $set: { status: "failed", reason: "Submission to Smile ID failed", excludedFromAttempts: true, completedAt: new Date() } }
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
                { $set: { status: "failed", reason: "No result from Smile ID in time", excludedFromAttempts: true, completedAt: new Date() } }
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

        const verification = await Verification.findById(jobId).select("+idHash");
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
                        },
                        $unset: { "identity.failureReason": "" },
                    }
                );
            } catch (error: any) {
                if (error?.code !== 11000) throw error;
                outcome = { passed: false, reason: "This BVN is already linked to another SolutionPay account. Contact support if you think this is a mistake." };
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

    private async sendResultEmail(user: IUser, outcome: Outcome) {
        try {
            await this.notifications.emailService.sendNotificationEmail(user.email, outcome.passed
                ? {
                    title: "✅ Your BVN is verified",
                    eyebrow: "Verification",
                    name: user.firstName,
                    message: `Your identity is verified and your account is now on <strong>Tier 1 (${TIER_NAME[USER_TIER.INDIVIDUAL]})</strong>. You can start sending, receiving and exchanging money.`,
                    actionUrl: `${config.FRONTEND_URL}/dashboard/user`,
                    buttonText: "Go to Dashboard",
                }
                : {
                    title: "We couldn't verify your BVN",
                    eyebrow: "Verification",
                    name: user.firstName,
                    message: `Your BVN verification wasn't successful. ${escapeHtml(outcome.reason)}`,
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
            verifiedName: user?.identity?.verifiedName,
            verifiedAt: user?.identity?.verifiedAt,
            method: user?.identity?.method,
            checks: recent.map((check) => ({ id: String(check._id), ...check, _id: undefined })),
        };
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

const escapeHtml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export default new IdentityService();
