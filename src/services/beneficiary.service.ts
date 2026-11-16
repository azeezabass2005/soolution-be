import beneficiaryRepository from "../repositories/beneficiary.repository";
import type { Beneficiary as IBeneficiary } from "../types/entities";
import type { BeneficiaryKind } from "../types/enums";
import errorResponseMessage, { ErrorResponseCode, ErrorSeverity } from "../common/messages/error-response-message";
import { BENEFICIARY_KIND, MAX_BENEFICIARIES_PER_USER, RMB_KINDS } from "../common/beneficiary.constants";
import { ZCreateBeneficiary } from "../validators/z-beneficiary";
import { FileUploadFactory } from "./file-upload.factory";
import logger from "../utils/logger.utils";

const QR_MAX_BYTES = 10 * 1024 * 1024;

const badRequest = (message: string, details?: unknown) =>
    errorResponseMessage.createError(ErrorResponseCode.BAD_REQUEST, message, ErrorSeverity.LOW, details);

/** The account identifier that makes two beneficiaries the same recipient */
const identityOf = (b: Partial<Pick<IBeneficiary, "kind" | "bankName" | "accountNumber" | "momoNetwork" | "momoNumber" | "alipayNo" | "alipayName">>) => {
    const digits = (value?: string) => (value || "").replace(/[^0-9A-Za-z]/g, "").toLowerCase();
    if (b.kind === BENEFICIARY_KIND.BANK) return `${(b.bankName || "").trim().toLowerCase()}|${digits(b.accountNumber)}`;
    if (b.kind === BENEFICIARY_KIND.MOMO) return `${(b.momoNetwork || "").trim().toLowerCase()}|${digits(b.momoNumber)}`;
    return `${digits(b.alipayNo)}|${(b.alipayName || "").trim().toLowerCase()}`;
};

class BeneficiaryService {
    private uploadService = FileUploadFactory.getGeneralUploadService();

    /** The user's beneficiaries, most recently used first, optionally for one currency */
    async list(userId: string, currency?: string) {
        return beneficiaryRepository.listForUser(userId, currency);
    }

    /** A beneficiary owned by this user, or 404 (never reveals other users' beneficiaries) */
    async getOwned(userId: string, id: string) {
        const beneficiary = await beneficiaryRepository.findOwned(id, userId);
        if (!beneficiary) throw errorResponseMessage.resourceNotFound("Beneficiary");
        return beneficiary;
    }

    async create(userId: string, body: unknown, qrCode?: Express.Multer.File) {
        const parsed = ZCreateBeneficiary.safeParse(body ?? {});
        if (!parsed.success) {
            const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
            throw badRequest(issues[0].message, { issues });
        }
        const data = parsed.data as Partial<IBeneficiary> & Record<string, any>;
        const isRmb = RMB_KINDS.includes(data.kind as any);

        // Only the fields that belong to this kind are kept
        const fields: Partial<IBeneficiary> = { currency: data.currency, kind: data.kind, nickname: data.nickname };
        if (data.kind === BENEFICIARY_KIND.BANK) Object.assign(fields, { bankName: data.bankName, bankCode: (data as any).bankCode, accountNumber: data.accountNumber, accountName: data.accountName });
        if (data.kind === BENEFICIARY_KIND.MOMO) Object.assign(fields, { momoNetwork: data.momoNetwork, momoNumber: data.momoNumber, momoName: data.momoName });
        if (isRmb) Object.assign(fields, { alipayNo: data.alipayNo, alipayName: data.alipayName, ...(data.kind === BENEFICIARY_KIND.ALIPAY ? { alipayType: data.alipayType } : {}) });

        if (isRmb) {
            if (!qrCode) throw badRequest("Upload the beneficiary's QR code", { issues: [{ path: "qrCode", message: "QR code is required" }] });
            if (!qrCode.mimetype?.startsWith("image/") || qrCode.size > QR_MAX_BYTES) {
                throw badRequest("The QR code must be an image under 10MB", { issues: [{ path: "qrCode", message: "Upload an image under 10MB" }] });
            }
        }

        const existing = await beneficiaryRepository.listForUserOfKind(userId, fields.currency!, fields.kind as BeneficiaryKind);
        const duplicate = existing.find((b) => identityOf(b) === identityOf(fields));
        if (duplicate) {
            throw errorResponseMessage.createError(ErrorResponseCode.RESOURCE_ALREADY_EXISTS, "You've already saved this beneficiary.", ErrorSeverity.LOW, { beneficiaryId: duplicate.id });
        }
        if ((await beneficiaryRepository.countForUser(userId)) >= MAX_BENEFICIARIES_PER_USER) {
            throw badRequest(`You can save up to ${MAX_BENEFICIARIES_PER_USER} beneficiaries. Remove one you no longer use to add another.`);
        }

        if (isRmb && qrCode) {
            const upload = await this.uploadService.uploadFile(qrCode, {
                folder: "qrcodes/beneficiaries/",
                customFilename: `${fields.kind}_qrcode_${Date.now()}`,
                makePublic: true,
            });
            if (!upload.success || !upload.file?.url) {
                logger.error("Beneficiary QR code upload failed", { userId, error: upload.error });
                throw errorResponseMessage.unableToComplete("We couldn't upload the QR code. Please try again.");
            }
            fields.qrCodeUrl = upload.file.url;
        }

        return beneficiaryRepository.create({
            user: userId,
            currency: fields.currency!,
            kind: fields.kind as BeneficiaryKind,
            nickname: fields.nickname?.trim(),
            bankName: fields.bankName?.trim(),
            bankCode: fields.bankCode?.trim(),
            accountNumber: fields.accountNumber?.trim(),
            accountName: fields.accountName?.trim(),
            momoNetwork: fields.momoNetwork?.trim(),
            momoNumber: fields.momoNumber?.trim(),
            momoName: fields.momoName?.trim(),
            alipayType: fields.alipayType?.trim(),
            alipayNo: fields.alipayNo?.trim(),
            alipayName: fields.alipayName?.trim(),
            qrCodeUrl: fields.qrCodeUrl,
        });
    }

    async remove(userId: string, id: string) {
        const beneficiary = await this.getOwned(userId, id);
        // The QR image stays: past transactions still link to it
        await beneficiaryRepository.delete(beneficiary.id);
    }

    async markUsed(id: string) {
        await beneficiaryRepository.touchLastUsed(id).catch(() => undefined);
    }
}

export default new BeneficiaryService();
