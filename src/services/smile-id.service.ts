import { WebApi, Signature, Utilities } from "smile-identity-core";
import config from "../config/env.config";
import logger from "../utils/logger.utils";

/** Smile ID job type 1: Biometric KYC (ID number lookup plus a selfie compared with the ID photo) */
const BIOMETRIC_KYC_JOB_TYPE = 1;

export interface SmileImage {
    image: string;
    image_type_id: number;
}

export interface SmileJobRef {
    /** Our identifiers for the job, echoed back in PartnerParams */
    userId: string;
    jobId: string;
}

/**
 * Smile ID client. Never logs ID numbers, names or images: only job IDs and
 * Smile's result codes.
 */
class SmileId {
    private connection: WebApi;
    private signature: Signature;
    private utilities: Utilities;

    constructor() {
        this.connection = new WebApi(config.SMILE_ID_PARTNER_ID, config.SMILE_ID_CALLBACK_URL, config.SMILE_ID_API_KEY, config.SMILE_ID_SID_SERVER);
        this.signature = new Signature(config.SMILE_ID_PARTNER_ID, config.SMILE_ID_API_KEY);
        this.utilities = new Utilities(config.SMILE_ID_PARTNER_ID, config.SMILE_ID_API_KEY, config.SMILE_ID_SID_SERVER);
    }

    /** Checks the signature Smile ID puts on webhooks and job status responses */
    public verifySignature = (signature: unknown, timestamp: unknown): boolean => {
        if (typeof signature !== "string" || !signature) return false;
        if (typeof timestamp !== "string" && typeof timestamp !== "number") return false;
        try {
            // The SDK expects (timestamp, signature); an unparseable timestamp throws
            return this.signature.confirm_signature(timestamp, signature);
        } catch {
            return false;
        }
    };

    /**
     * Submits a Nigerian BVN with selfie images for Biometric KYC. Returns as soon
     * as Smile ID accepts the job; the result arrives by webhook (or `getJobStatus`).
     */
    public submitBvnBiometricKyc = async (
        ref: SmileJobRef,
        person: { firstName: string; lastName: string },
        bvn: string,
        images: SmileImage[]
    ): Promise<{ smileJobId?: string }> => {
        const partnerParams = { user_id: ref.userId, job_id: ref.jobId, job_type: BIOMETRIC_KYC_JOB_TYPE };
        const idInfo = {
            first_name: person.firstName,
            last_name: person.lastName,
            country: "NG",
            id_type: "BVN",
            id_number: bvn,
            entered: "true",
        };
        try {
            const response: any = await this.connection.submit_job(partnerParams, images, idInfo, {
                return_job_status: false,
                return_history: false,
                return_image_links: false,
            });
            logger.info("Smile ID: BVN job submitted", { jobId: ref.jobId, smileJobId: response?.smile_job_id });
            return { smileJobId: response?.smile_job_id };
        } catch (error: any) {
            const status = error?.response?.status;
            const data = error?.response?.data;
            const providerMessage = typeof data === "string" ? data : data?.error || data?.message || data?.code;
            logger.error("Smile ID: BVN job submission failed", { jobId: ref.jobId, status, providerMessage, error: error?.message });
            const wrapped = new Error(providerMessage || error?.message || "Smile ID submission failed");
            (wrapped as any).statusCode = status;
            throw wrapped;
        }
    };

    /** One job status lookup (no waiting); `result` matches the webhook payload once `job_complete` */
    public getJobStatus = async (ref: SmileJobRef): Promise<{ job_complete?: boolean; job_success?: boolean; result?: any } | null> => {
        try {
            return await this.utilities.get_job_status(ref.userId, ref.jobId, { return_history: false, return_images: false });
        } catch (error: any) {
            logger.warn("Smile ID: job status lookup failed", { jobId: ref.jobId, status: error?.response?.status, error: error?.message });
            return null;
        }
    };
}

export default SmileId;
