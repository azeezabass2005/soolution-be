import { createHmac } from "crypto";
import userRepository from "../repositories/user.repository";
import verificationRepository, { ENCRYPTED_IDS_CLEARED } from "../repositories/verification.repository";
import { isUuid } from "../utils/id.utils";
import { isUniqueViolation } from "../db/errors";
import type { User as IUser, UserIdentity, Verification as IVerification } from "../types/entities";
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
import { FileUploadFactory } from "./file-upload.factory";
import type { IdentityAddressParts, IdentityProofOfAddress } from "../common/identity.constants";

/** Proof of address: an image or PDF, up to 5 MB */
const PROOF_OF_ADDRESS_UPLOAD = {
    maxFileSize: 5 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
    allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".pdf"],
    uploadPath: "identity/proof-of-address/",
};
const proofUploads = FileUploadFactory.createCustomUploadService(PROOF_OF_ADDRESS_UPLOAD);

const clean = (value: unknown, max: number) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "");

/** The typed date of birth (YYYY-MM-DD, 18 or over), or a problem */
const parseDob = (value: unknown): { dob?: string; problem?: string } => {
    const typed = typeof value === "string" ? value.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(typed) || isNaN(Date.parse(typed))) return { problem: "Enter your date of birth" };
    if (yearsSince(typed) < 18) return { problem: "You must be at least 18 to use Solution Pay" };
    if (yearsSince(typed) > 120) return { problem: "Check your date of birth" };
    return { dob: typed };
};

/** The typed home address: street, city, state, and LGA in Nigeria */
export const parseAddressParts = (value: any): { parts?: IdentityAddressParts; problem?: { field: string; message: string } } => {
    const country = clean(value?.country, 2).toUpperCase() || "NG";
    const parts: IdentityAddressParts = {
        street: clean(value?.street, 200),
        city: clean(value?.city, 80),
        state: clean(value?.state, 80),
        ...(country === "NG" ? { lga: clean(value?.lga, 80) } : {}),
        country,
    };
    if (parts.street.length < 5) return { problem: { field: "street", message: "Enter your house number and street" } };
    if (parts.city.length < 2) return { problem: { field: "city", message: "Enter your city or town" } };
    if (parts.state.length < 2) return { problem: { field: "state", message: country === "NG" ? "Choose your state" : "Enter your state or region" } };
    if (country === "NG" && !(parts.lga && parts.lga.length >= 2)) return { problem: { field: "lga", message: "Choose your LGA" } };
    return { parts };
};

/** "12 Allen Avenue, Ikeja, Ikeja LGA, Lagos, NG" */
export const joinAddress = (parts: IdentityAddressParts) =>
    [parts.street, parts.city, parts.lga ? `${parts.lga} LGA` : "", parts.state, parts.country].filter(Boolean).join(", ").slice(0, 300);

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
/**
 * "+2348012345678", or undefined when it isn't a Nigerian mobile number.
 * YellowCard rejects any other phone for a Nigerian sender or recipient
 * ("invalid phone in recipient"), even a valid foreign one.
 */
export const toNigerianIntl = (phone?: string): string | undefined => {
    let digits = (phone || "").replace(/\D/g, "");
    if (digits.startsWith("234")) digits = digits.slice(3);
    if (digits.startsWith("0")) digits = digits.slice(1);
    return /^[789]\d{9}$/.test(digits) ? `+234${digits}` : undefined;
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
        return verificationRepository.countedFailuresSince(userId, new Date(Date.now() - BVN_ATTEMPT_WINDOW_MS));
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
        let pending = await verificationRepository.findPendingBvn(userId);
        if (pending) {
            await this.checkPending(pending);
            pending = await verificationRepository.findPendingBvn(userId);
        }

        const user = await userRepository.findById(userId, { withSecrets: true });
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
            transferDetails: this.detailsView(user),
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
    async submitBvn(user: IUser, bvn: unknown, images: unknown, nin?: unknown, personal?: { dob?: unknown; address?: unknown }): Promise<IdentityStatusView> {
        const userId = user.id;
        if ((user.tier ?? USER_TIER.UNVERIFIED) >= USER_TIER.INDIVIDUAL || user.identity?.status === IDENTITY_STATUS.VERIFIED) {
            throw errorResponseMessage.createError(409, "Your identity is already verified", ErrorSeverity.LOW, { code: "IDENTITY_ALREADY_VERIFIED" });
        }
        if (!isBvn(bvn)) throw badRequest("Enter your 11-digit BVN", "INVALID_BVN");
        if (!isNin(nin)) throw badRequest("Enter your 11-digit NIN", "INVALID_NIN");
        if (nin === bvn) throw badRequest("Your NIN and BVN are different numbers. Check your NIN.", "INVALID_NIN");
        // Date of birth, home address and proof of address come before the selfie
        const { dob, problem: dobProblem } = parseDob(personal?.dob);
        if (dobProblem) throw badRequest(dobProblem, "INVALID_DOB");
        const { parts: addressParts, problem: addressProblem } = parseAddressParts(personal?.address);
        if (addressProblem) throw errorResponseMessage.createError(400, addressProblem.message, ErrorSeverity.LOW, { code: "INVALID_ADDRESS", field: addressProblem.field });
        const stored = await userRepository.findById(userId);
        if (!stored?.identity?.proofOfAddress) throw badRequest("Upload a proof of address", "PROOF_OF_ADDRESS_REQUIRED");
        const selfie = this.validateImages(images);

        const existing = await verificationRepository.findPendingBvn(userId);
        if (existing) {
            await this.checkPending(existing);
            if (await verificationRepository.isPending(existing.id)) {
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
        if (await userRepository.identityHashInUse("bvnHash", idHash, userId)) {
            throw errorResponseMessage.createError(409, "This BVN is already linked to another SolutionPay account. Contact support if you think this is a mistake.", ErrorSeverity.LOW, { code: "BVN_IN_USE" });
        }

        const ninHash = this.hashNin(nin);
        if (await userRepository.identityHashInUse("ninHash", ninHash, userId)) {
            throw errorResponseMessage.createError(409, "This NIN is already linked to another SolutionPay account. Contact support if you think this is a mistake.", ErrorSeverity.LOW, { code: "NIN_IN_USE" });
        }

        let verification;
        try {
            verification = await verificationRepository.create({
                user: userId, kind: "bvn", status: "pending", idHash, idLast4: bvn.slice(-4),
                bvnEnc: encryptIdentity(bvn), ninEnc: encryptIdentity(nin), ninHash, ninLast4: nin.slice(-4),
            });
        } catch (error: any) {
            if (isUniqueViolation(error, "verifications_pending_bvn_key")) {
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
            await verificationRepository.update(verification.id, { smileJobId });
        } catch (error: any) {
            // Our partner didn't take the job: not the user's fault, so it doesn't use an attempt
            await verificationRepository.update(verification.id, {
                status: "failed",
                reason: "Submission to our verification partner failed",
                excludedFromAttempts: true,
                completedAt: new Date(),
                ...ENCRYPTED_IDS_CLEARED,
            });
            throw errorResponseMessage.createError(500, "We couldn't start your verification. Please try again in a few minutes.", ErrorSeverity.MEDIUM);
        }

        await userRepository.updateIdentity(
            userId,
            { status: IDENTITY_STATUS.PENDING, failureReason: null, dob, address: joinAddress(addressParts!), addressParts, detailsUpdatedAt: new Date() },
            { statusIsNot: IDENTITY_STATUS.VERIFIED }
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
            await verificationRepository.update(verification.id, { lastPolledAt: new Date() });
            const status = await this.smileId.getJobStatus(this.smileRef(verification));
            if (status?.job_complete && status.result && typeof status.result === "object") {
                await this.handleSmileResult(status.result, "poll");
                return;
            }
        }

        if (age >= BVN_PENDING_TIMEOUT_MS) {
            const expired = await verificationRepository.updateIfPending(verification.id, {
                status: "failed",
                reason: "No verification result in time",
                excludedFromAttempts: true,
                completedAt: new Date(),
                ...ENCRYPTED_IDS_CLEARED,
            });
            if (expired) {
                await userRepository.updateIdentity(
                    verification.user,
                    { status: IDENTITY_STATUS.FAILED, failureReason: "We didn't get a result in time. Please try again." },
                    { statusIs: IDENTITY_STATUS.PENDING }
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
        // Smile ID's sandbox compares against a stand-in photo for its test BVN, so no real face matches it
        const skipFaceMatch = config.SMILE_ID_SANDBOX_SKIP_FACE_MATCH;
        // 0811 "No Face Match": the selfie was fine, it just isn't the face on the BVN record
        const faceMismatch = result?.ResultCode === "0811" || actions.Selfie_To_ID_Authority_Compare === "Failed";
        if (faceMismatch && !skipFaceMatch) {
            return { passed: false, reason: "Your selfie didn't match the photo on your BVN record. Check that the BVN is your own, then try again facing the camera." };
        }
        if (actions.Register_Selfie === "Rejected" && !(faceMismatch && skipFaceMatch)) {
            return { passed: false, reason: "Your selfie couldn't be used. Try again in good light, without glasses or a face covering." };
        }
        if (!PASSING.compare.includes(actions.Selfie_To_ID_Authority_Compare) && !skipFaceMatch) {
            return { passed: false, reason: "Your selfie didn't match the photo on your BVN record. Check that the BVN is your own, then try again facing the camera." };
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
        if (typeof jobId !== "string" || !isUuid(jobId)) return { handled: false, reason: "Unknown job" };

        const verification = await verificationRepository.findById(jobId, { withSecrets: true });
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
            await verificationRepository.updateIfPending(verification.id, details);
            return { handled: true, outcome: "waiting" };
        }

        const user = await userRepository.findById(verification.user);
        if (!user) return { handled: false, reason: "User not found" };

        let outcome = this.evaluate(result, user);
        if (outcome.passed) {
            const record = personalInfoFrom(result);
            // What the user typed at verification wins over the BVN record (often out of date)
            const info = { ...record, dob: user.identity?.dob ? undefined : record.dob, address: user.identity?.address ? undefined : record.address };
            this.logRecordFields("bvn", info);
            try {
                await userRepository.updateIdentity(user.id, {
                    status: IDENTITY_STATUS.VERIFIED,
                    bvnHash: verification.idHash,
                    bvnLast4: verification.idLast4,
                    verifiedName: outcome.nameOnId,
                    verifiedAt: new Date(),
                    method: SMILE_METHOD,
                    ...this.detailsUpdate({
                        bvnEnc: verification.bvnEnc,
                        ninEnc: verification.ninEnc,
                        ninHash: verification.ninHash,
                        ninLast4: verification.ninLast4,
                        info,
                    }),
                    failureReason: null,
                });
            } catch (error: any) {
                if (!isUniqueViolation(error)) throw error;
                outcome = { passed: false, reason: "This BVN or NIN is already linked to another SolutionPay account. Contact support if you think this is a mistake." };
            }
        }

        const claimed = await verificationRepository.updateIfPending(verification.id, {
            ...details,
            status: outcome.passed ? "passed" : "failed",
            ...(outcome.passed ? {} : { reason: outcome.reason }),
            nameOnId: outcome.nameOnId,
            resultSource: source,
            completedAt: new Date(),
            // The numbers now live (encrypted) on the user, or aren't needed
            ...ENCRYPTED_IDS_CLEARED,
        });
        // The webhook and a status lookup can race: only the first one finishes the job
        if (!claimed) return { handled: true, reason: "Already decided" };

        if (outcome.passed) {
            await userRepository.setTier(user.id, USER_TIER.INDIVIDUAL, { reason: "BVN verified" }, { onlyIfBelow: true });
        } else {
            await userRepository.updateIdentity(
                user.id,
                { status: IDENTITY_STATUS.FAILED, failureReason: outcome.reason },
                { statusIsNot: IDENTITY_STATUS.VERIFIED }
            );
        }

        logger.info("BVN verification decided", { verificationId: verification.id, outcome: outcome.passed ? "passed" : "failed", resultCode, source });
        await this.auditLog.logAction(undefined, user.id, outcome.passed ? "IDENTITY_BVN_VERIFIED" : "IDENTITY_BVN_FAILED", undefined, {
            verificationId: verification.id,
            resultCode,
            ...(outcome.passed ? {} : { reason: outcome.reason }),
        });
        await this.sendResultEmail(user, outcome);
        return { handled: true, outcome: outcome.passed ? "passed" : "failed", ...(outcome.passed ? {} : { reason: outcome.reason }) };
    }

    /** Identity fields for the details YellowCard needs; only what's known is written */
    private detailsUpdate(input: { bvnEnc?: string; ninEnc?: string; ninHash?: string; ninLast4?: string; info?: SmilePersonalInfo; dob?: string; address?: string }) {
        const set: Partial<UserIdentity> = {};
        if (input.bvnEnc) set.bvnEnc = input.bvnEnc;
        if (input.ninEnc) {
            set.ninEnc = input.ninEnc;
            set.ninHash = input.ninHash;
            set.ninLast4 = input.ninLast4;
        }
        const dob = input.info?.dob || input.dob;
        const address = input.info?.address || input.address;
        if (dob) set.dob = dob;
        if (address) set.address = address.slice(0, 300);
        if (toNigerianIntl(input.info?.phone)) set.idPhone = toNigerianIntl(input.info?.phone);
        if (Object.keys(set).length) set.detailsUpdatedAt = new Date();
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
        const user = await userRepository.findById(userId, { withSecrets: true });
        if (!user) throw errorResponseMessage.resourceNotFound("User");
        return this.detailsView(user);
    }

    /**
     * Completes the details YellowCard needs, for verified accounts that don't
     * have them yet (verified before NIN was asked, or a record with no
     * address). The BVN must be the one they verified with; it's looked up
     * again (no selfie) to fill in date of birth, phone and address.
     */
    async submitTransferDetails(user: IUser, body: { bvn?: unknown; nin?: unknown; dob?: unknown; address?: unknown; phone?: unknown }): Promise<TransferDetailsView> {
        const userId = user.id;
        const current = await userRepository.findById(userId, { withSecrets: true });
        if (!current) throw errorResponseMessage.resourceNotFound("User");
        if (current.identity?.status !== IDENTITY_STATUS.VERIFIED) {
            throw errorResponseMessage.createError(403, "Verify your identity first. It takes about 2 minutes.", ErrorSeverity.LOW, { code: IDENTITY_REQUIRED_CODE });
        }
        const identity = current.identity;
        const set: Partial<UserIdentity> = {};
        let info: SmilePersonalInfo = {};

        // BVN: only if we don't hold it yet
        if (!identity.bvnEnc) {
            const bvn = body.bvn;
            if (!isBvn(bvn)) throw badRequest("Enter your 11-digit BVN", "INVALID_BVN");
            const bvnHash = this.hashBvn(bvn);
            if (identity.bvnHash && identity.bvnHash !== bvnHash) {
                throw badRequest(`That isn't the BVN you verified with (ending ${identity.bvnLast4}). Check the number and try again.`, "BVN_MISMATCH");
            }
            if (!identity.bvnHash && await userRepository.identityHashInUse("bvnHash", bvnHash, current.id)) {
                throw errorResponseMessage.createError(409, "This BVN is already linked to another SolutionPay account. Contact support if you think this is a mistake.", ErrorSeverity.LOW, { code: "BVN_IN_USE" });
            }
            const lookup = await this.lookup(current, "BVN", bvn);
            if (!lookup.verified) throw badRequest("We couldn't find that BVN. Check the number and try again.", "INVALID_BVN");
            // Accounts verified before BVN checks prove the BVN is theirs by name
            if (!identity.bvnHash) this.assertNameMatches(current, lookup.info, "BVN");
            info = lookup.info;
            this.logRecordFields("bvn", info);
            Object.assign(set, this.detailsUpdate({ bvnEnc: encryptIdentity(bvn), info }));
            if (!identity.bvnHash) {
                set.bvnHash = bvnHash;
                set.bvnLast4 = bvn.slice(-4);
            }
        }

        // NIN
        if (!identity.ninEnc) {
            const nin = body.nin;
            if (!isNin(nin)) throw badRequest("Enter your 11-digit NIN", "INVALID_NIN");
            if (typeof body.bvn === "string" && nin === body.bvn) throw badRequest("Your NIN and BVN are different numbers. Check your NIN.", "INVALID_NIN");
            const ninHash = this.hashNin(nin);
            if (await userRepository.identityHashInUse("ninHash", ninHash, current.id)) {
                throw errorResponseMessage.createError(409, "This NIN is already linked to another SolutionPay account. Contact support if you think this is a mistake.", ErrorSeverity.LOW, { code: "NIN_IN_USE" });
            }
            if (config.SMILE_ID_VERIFY_NIN) {
                const lookup = await this.lookup(current, "NIN_V2", nin);
                if (!lookup.verified) throw badRequest("We couldn't find that NIN. Check the number and try again.", "INVALID_NIN");
                this.assertNameMatches(current, lookup.info, "NIN");
                this.logRecordFields("nin", lookup.info);
                info = { ...lookup.info, ...info };
            }
            Object.assign(set, this.detailsUpdate({ ninEnc: encryptIdentity(nin), ninHash, ninLast4: nin.slice(-4), info }));
        }

        // Date of birth and address: from the ID record, else what the user typed
        let typedProblem: ReturnType<typeof badRequest> | undefined;
        if (!(set.dob || identity.dob)) {
            const typed = typeof body.dob === "string" ? body.dob.trim() : "";
            if (!/^\d{4}-\d{2}-\d{2}$/.test(typed) || isNaN(Date.parse(typed))) typedProblem = badRequest("Enter your date of birth", "INVALID_DOB");
            else if (yearsSince(typed) < 18) typedProblem = badRequest("You must be at least 18 to send money abroad", "INVALID_DOB");
            else if (yearsSince(typed) > 120) typedProblem = badRequest("Check your date of birth", "INVALID_DOB");
            else set.dob = typed;
        }
        if (!(set.address || identity.address)) {
            const typed = typeof body.address === "string" ? body.address.trim().replace(/\s+/g, " ") : "";
            if (typed.length < 10) typedProblem ??= badRequest("Enter your home address, including the street, town and state", "INVALID_ADDRESS");
            else set.address = typed.slice(0, 300);
        }
        // Phone: YellowCard takes only a Nigerian number, so a foreign profile phone needs one here
        if (!toNigerianIntl(set.idPhone || identity.idPhone) && !toNigerianIntl(current.phoneNumber)) {
            const typed = toNigerianIntl(typeof body.phone === "string" ? body.phone : "");
            if (!typed) typedProblem ??= badRequest("Enter your Nigerian phone number", "INVALID_PHONE");
            else set.idPhone = typed;
        }

        // Save what we have (e.g. a paid lookup's result) even if something typed needs fixing
        if (Object.keys(set).length) {
            set.detailsUpdatedAt = new Date();
            try {
                await userRepository.updateIdentity(current.id, set);
            } catch (error: any) {
                if (!isUniqueViolation(error)) throw error;
                throw errorResponseMessage.createError(409, "This BVN or NIN is already linked to another SolutionPay account. Contact support if you think this is a mistake.", ErrorSeverity.LOW, { code: "ID_IN_USE" });
            }
            await this.auditLog.logAction(undefined, userId, "IDENTITY_TRANSFER_DETAILS_UPDATED", undefined, {
                fields: Object.keys(set).filter((key) => !/Enc$|Hash$|detailsUpdatedAt/.test(key)),
            });
        }
        if (typedProblem) throw typedProblem;
        return this.transferDetails(userId);
    }

    /** A paid Smile ID lookup, limited per user per day, and recorded for support */
    private async lookup(user: IUser, idType: "BVN" | "NIN_V2", idNumber: string) {
        const recent = await verificationRepository.countSince(user.id, "details", new Date(Date.now() - BVN_ATTEMPT_WINDOW_MS));
        if (recent >= DETAILS_MAX_LOOKUPS) {
            throw errorResponseMessage.createError(429, "You've tried too many times today. Please try again tomorrow, or contact support for help.", ErrorSeverity.LOW, { code: "DETAILS_ATTEMPTS_EXCEEDED" });
        }
        const check = await verificationRepository.create({ user: user.id, kind: "details", status: "pending", idLast4: idNumber.slice(-4), reason: `${idType} lookup` });
        try {
            const result = await this.smileId.lookupId(
                { userId: `${user.id}-${check.id}`, jobId: check.id },
                { firstName: user.firstName, lastName: user.lastName },
                idType,
                idNumber
            );
            await verificationRepository.update(check.id, {
                status: result.verified ? "passed" : "failed",
                resultCode: result.resultCode,
                resultText: result.resultText,
                completedAt: new Date(),
            });
            return result;
        } catch (error) {
            await verificationRepository.update(check.id, { status: "failed", reason: `${idType} lookup unavailable`, completedAt: new Date() });
            throw errorResponseMessage.createError(500, "We couldn't start your verification. Please try again in a few minutes.", ErrorSeverity.MEDIUM);
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
        const user = await userRepository.findById(userId, { withSecrets: true });
        if (!user) throw errorResponseMessage.resourceNotFound("User");
        const view = this.detailsView(user);
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
            logger.error("Failed to send BVN verification email", { userId: user.id, error: error?.message });
        }
    }

    /** For the admin user page: state, attempts and recent checks */
    /** Saves the user's proof of address (replacing an earlier one). Kept for review, not verified. */
    async uploadProofOfAddress(user: IUser, file: Express.Multer.File | undefined): Promise<{ name: string; uploadedAt: string }> {
        if (!file) throw badRequest("Choose a file to upload", "PROOF_OF_ADDRESS_REQUIRED");
        if (!PROOF_OF_ADDRESS_UPLOAD.allowedMimeTypes.includes(file.mimetype)) throw badRequest("Upload a photo or PDF", "INVALID_FILE");
        if (file.size > PROOF_OF_ADDRESS_UPLOAD.maxFileSize) throw badRequest("That file is over 5 MB", "INVALID_FILE");
        const upload = await proofUploads.uploadFile(file, {
            folder: `${PROOF_OF_ADDRESS_UPLOAD.uploadPath}${user.id}/`,
            customFilename: `proof-${Date.now()}`,
            makePublic: false,
        });
        if (!upload.success || !upload.file) throw errorResponseMessage.unableToComplete(upload.error || "We couldn't upload that file. Please try again.");
        const previous = (await userRepository.findById(user.id))?.identity?.proofOfAddress;
        const proof: IdentityProofOfAddress = {
            key: upload.file.key,
            name: clean(file.originalname, 120) || "proof-of-address",
            mimeType: file.mimetype,
            size: file.size,
            uploadedAt: new Date().toISOString(),
        };
        await userRepository.updateIdentity(user.id, { proofOfAddress: proof });
        if (previous?.key && previous.key !== proof.key) {
            proofUploads.deleteFile(previous.key).catch(() => false);
        }
        return { name: proof.name, uploadedAt: proof.uploadedAt };
    }

    /** Everything the user gave at verification, for admins (never the full BVN or NIN) */
    private async adminDetails(userId: string) {
        const user = await userRepository.findById(userId);
        const identity = user?.identity;
        if (!identity) return null;
        let proofUrl: string | undefined;
        if (identity.proofOfAddress?.key) {
            try {
                proofUrl = await proofUploads.getFileUrl(identity.proofOfAddress.key, 15 * 60);
            } catch (error: any) {
                logger.warn("Proof of address link failed", { userId, error: error?.message });
            }
        }
        return {
            bvnLast4: identity.bvnLast4,
            ninLast4: identity.ninLast4,
            dob: identity.dob,
            address: identity.address,
            addressParts: identity.addressParts,
            phoneOnId: identity.idPhone,
            proofOfAddress: identity.proofOfAddress
                ? { name: identity.proofOfAddress.name, mimeType: identity.proofOfAddress.mimeType, size: identity.proofOfAddress.size, uploadedAt: identity.proofOfAddress.uploadedAt, url: proofUrl }
                : null,
            detailsUpdatedAt: identity.detailsUpdatedAt,
        };
    }

    async adminSummary(userId: string) {
        const [status, recent] = await Promise.all([
            this.getStatus(userId),
            verificationRepository.listForUser(userId, 10),
        ]);
        const user = await userRepository.findById(userId);
        return {
            ...status,
            // transferDetails (in status) says what's on file, never the numbers
            verifiedName: user?.identity?.verifiedName,
            verifiedAt: user?.identity?.verifiedAt,
            method: user?.identity?.method,
            details: await this.adminDetails(userId),
            checks: recent.map((check) => ({
                id: check.id,
                kind: check.kind,
                status: check.status,
                reason: check.reason,
                idLast4: check.idLast4,
                smileJobId: check.smileJobId,
                resultCode: check.resultCode,
                resultText: check.resultText,
                nameOnId: check.nameOnId,
                resultSource: check.resultSource,
                excludedFromAttempts: check.excludedFromAttempts,
                createdAt: check.createdAt,
                completedAt: check.completedAt,
            })),
        };
    }

    /**
     * Undoes a user's identity verification: back to Unverified (tier 0) with
     * nothing on file (BVN, NIN, date of birth, address), so they verify from
     * scratch. Also clears their failed attempts. For accounts verified in
     * error, or for testing the full flow again.
     */
    async adminResetVerification(admin: IUser, userId: string, reason: string) {
        const before = await userRepository.findById(userId);
        if (!before) throw errorResponseMessage.resourceNotFound("User");
        await userRepository.resetIdentity(userId);
        await userRepository.setTier(userId, USER_TIER.UNVERIFIED, { reason: `Verification reset by admin: ${reason}`, by: admin.id });
        // Any check still running is abandoned, and nothing counts against the next attempts
        await verificationRepository.updateManyForUser(
            userId,
            { status: "pending" },
            { status: "failed", reason: "Verification reset by admin", completedAt: new Date(), ...ENCRYPTED_IDS_CLEARED }
        );
        await verificationRepository.updateManyForUser(userId, { kind: "bvn", status: "failed" }, { excludedFromAttempts: true });
        await this.auditLog.logAction(
            undefined, userId, "IDENTITY_VERIFICATION_RESET",
            { tier: before.tier, status: before.identity?.status, bvnLast4: before.identity?.bvnLast4, ninLast4: before.identity?.ninLast4 },
            { tier: USER_TIER.UNVERIFIED, status: IDENTITY_STATUS.UNVERIFIED },
            undefined, undefined, { by: admin.id, reason }
        );
        logger.info("Identity verification reset by admin", { userId, by: admin.id, fromTier: before.tier });
        return this.adminSummary(userId);
    }

    /** Lets a user who used up their attempts try again (e.g. after support helped them) */
    async adminResetAttempts(admin: IUser, userId: string, reason: string) {
        const failures = await this.countedFailures(userId);
        if (failures.length) {
            await verificationRepository.updateMany(failures.map((failure) => failure.id), { excludedFromAttempts: true });
        }
        await this.auditLog.logAction(undefined, userId, "IDENTITY_ATTEMPTS_RESET", { counted: failures.length }, { counted: 0 }, undefined, undefined, {
            by: admin.id,
            reason,
        });
        return this.adminSummary(userId);
    }
}

const escapeHtml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export default new IdentityService();
