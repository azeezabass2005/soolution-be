import kycApplicationRepository from "../repositories/kyc-application.repository";
import { KYC_STATUS, KYC_TYPE } from "../common/kyc.constants";

/**
 * The approved business name of a user, if they have one: from their
 * approved business application, or the last approved one archived when
 * they started a new application. Undefined for personal accounts.
 */
export async function approvedBusinessName(userId: string): Promise<string | undefined> {
    const application = await kycApplicationRepository.findByUser(userId);
    if (!application) return undefined;
    const nameOf = (entry: { type?: string; status?: string; general?: Record<string, any>; displayName?: string }) =>
        entry?.type === KYC_TYPE.BUSINESS && entry?.status === KYC_STATUS.APPROVED
            ? (String(entry.general?.businessName || entry.displayName || "").trim() || undefined)
            : undefined;
    const current = nameOf(application as any);
    if (current) return current;
    const archived = [...((application as any).archive ?? [])].reverse().map((entry: any) => nameOf(entry)).find(Boolean);
    return archived;
}
