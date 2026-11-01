import { IDApi, WebApi, Signature, Utilities } from "smile-identity-core";
import config from "../config/env.config";
import logger from "../utils/logger.utils";

/** Smile ID job type 1: Biometric KYC (ID number lookup plus a selfie compared with the ID photo) */
const BIOMETRIC_KYC_JOB_TYPE = 1;
/** Job type 5: Enhanced KYC (ID number lookup only, answered straight away) */
const ENHANCED_KYC_JOB_TYPE = 5;

/** What an ID authority holds for a person, from a Smile ID result (fields are often missing) */
export interface SmilePersonalInfo {
    fullName?: string;
    firstName?: string;
    lastName?: string;
    otherNames?: string;
    /** YYYY-MM-DD */
    dob?: string;
    phone?: string;
    address?: string;
    secondaryIdNumber?: string;
}

const text = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed && !/^(n\/a|null|undefined|not available)$/i.test(trimmed) ? trimmed : undefined;
};

/** Smile ID returns dates as YYYY-MM-DD or DD-MM-YYYY depending on the authority */
const isoDate = (value: unknown): string | undefined => {
    const raw = text(value);
    if (!raw) return undefined;
    let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return undefined;
};

/** Reads personal details from a job result (top-level fields, or FullData / PersonalInfo on some products) */
export const personalInfoFrom = (result: any): SmilePersonalInfo => {
    const sources = [result, result?.PersonalInfo, result?.personal_info, result?.FullData].filter((s) => s && typeof s === "object");
    const pick = (...keys: string[]) => {
        for (const source of sources) for (const key of keys) if (text(source[key])) return text(source[key]);
        return undefined;
    };
    return {
        fullName: pick("FullName", "full_name"),
        firstName: pick("FirstName", "first_name", "firstName"),
        lastName: pick("LastName", "last_name", "lastName", "surname"),
        otherNames: pick("OtherNames", "MiddleName", "other_names", "middle_name", "middleName"),
        dob: isoDate(pick("DOB", "date_of_birth", "dateOfBirth", "birthdate")),
        phone: pick("PhoneNumber", "phone_number", "phoneNumber1", "phoneNumber"),
        address: pick("Address", "address_unparsed", "residentialAddress"),
        secondaryIdNumber: pick("SecondaryIDNumber", "secondary_id_number"),
    };
};

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

    /**
     * Looks an ID number up with its authority (Enhanced KYC, no selfie) and
     * returns the record. Used to fill in details for accounts that already
     * passed a selfie check, and to check NINs.
     */
    public lookupId = async (
        ref: SmileJobRef,
        person: { firstName: string; lastName: string },
        idType: "BVN" | "NIN_V2",
        idNumber: string
    ): Promise<{ verified: boolean; resultCode?: string; resultText?: string; info: SmilePersonalInfo }> => {
        const api = new IDApi(config.SMILE_ID_PARTNER_ID, config.SMILE_ID_API_KEY, config.SMILE_ID_SID_SERVER);
        const partnerParams = { user_id: ref.userId, job_id: ref.jobId, job_type: ENHANCED_KYC_JOB_TYPE };
        try {
            const result: any = await api.submit_job(partnerParams, {
                first_name: person.firstName,
                last_name: person.lastName,
                country: "NG",
                id_type: idType,
                id_number: idNumber,
            });
            const verified = result?.Actions?.Verify_ID_Number === "Verified";
            logger.info("Smile ID: ID lookup finished", { jobId: ref.jobId, idType, resultCode: result?.ResultCode, verified });
            return { verified, resultCode: result?.ResultCode, resultText: result?.ResultText, info: verified ? personalInfoFrom(result) : {} };
        } catch (error: any) {
            const data = error?.response?.data;
            const providerMessage = typeof data === "string" ? data : data?.error || data?.message || data?.code;
            logger.error("Smile ID: ID lookup failed", { jobId: ref.jobId, idType, status: error?.response?.status, providerMessage, error: error?.message });
            const wrapped = new Error(providerMessage || error?.message || "Smile ID lookup failed");
            (wrapped as any).statusCode = error?.response?.status;
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
