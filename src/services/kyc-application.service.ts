import z from "zod";
import { FilterQuery } from "mongoose";
import { IKycApplication, IKycDocument, IUser } from "../models/interface";
import KycApplication from "../models/kyc-application.model";
import DBService from "../utils/db.utils";
import errorResponseMessage, { ErrorResponseCode, ErrorSeverity } from "../common/messages/error-response-message";
import {
    KYC_ADMIN_TRANSITIONS,
    KYC_DOCUMENT_UPLOAD,
    KYC_DOCUMENTS,
    KYC_EDITABLE_STATUSES,
    KYC_QUESTIONS,
    KYC_STATUS,
    KYC_STEP,
    KYC_STEPS,
    KycDocumentDefinition,
    KycStatus,
    KycStep,
    KycType,
    UBO_SOURCE_OF_FUNDS_PREFIX,
} from "../common/kyc.constants";
import { getStepSchema } from "../validators/z-kyc";
import { FileUploadFactory } from "./file-upload.factory";
import { FileUploadService } from "./file-upload.service";
import NotificationService from "../utils/notification.utils";
import UserService from "./user.service";
import config from "../config/env.config";
import logger from "../utils/logger.utils";

/** Signed document links are short-lived because the files hold identity documents */
const DOCUMENT_URL_TTL_SECONDS = 60 * 60;

const escapeHtml = (value: unknown): string =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const validationError = (error: z.ZodError) => {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
        const path = issue.path.join(".") || "_";
        if (!fieldErrors[path]) fieldErrors[path] = issue.message;
    }
    return errorResponseMessage.createError(
        ErrorResponseCode.BAD_REQUEST,
        error.issues[0]?.message || "Some fields are invalid",
        ErrorSeverity.LOW,
        { fieldErrors }
    );
};

const badRequest = (message: string) =>
    errorResponseMessage.createError(ErrorResponseCode.BAD_REQUEST, message, ErrorSeverity.LOW);

class KycApplicationService extends DBService<IKycApplication> {
    private uploadService: FileUploadService;
    private notificationService: NotificationService;
    private userService: UserService;

    constructor(populatedFields: string[] = []) {
        super(KycApplication, populatedFields);
        this.uploadService = FileUploadFactory.createCustomUploadService(KYC_DOCUMENT_UPLOAD);
        this.notificationService = new NotificationService();
        this.userService = new UserService();
    }

    /**
     * Documents this application currently needs, including source-of-funds
     * evidence for every individual UBO declared as a PEP.
     */
    public getRequiredDocuments(application: IKycApplication): KycDocumentDefinition[] {
        const definitions = KYC_DOCUMENTS[application.type].map((definition) => {
            if (definition.slot === "id_back" && application.personal?.idType === "passport") {
                return { ...definition, required: false };
            }
            return definition;
        });

        if (application.type !== "business") return definitions;

        const uboDefinitions = (application.ubos || [])
            .filter((ubo) => ubo.kind === "individual" && ubo.isPep)
            .map((ubo) => ({
                slot: `${UBO_SOURCE_OF_FUNDS_PREFIX}${ubo.id}`,
                label: `Source of funds: ${ubo.fullName}`,
                description: "This beneficial owner is a PEP. Provide evidence such as bank statements and proof of address.",
                required: true,
                requiresIssueDate: false,
            }));

        return [...definitions, ...uboDefinitions];
    }

    private getMissingDocuments(application: IKycApplication): KycDocumentDefinition[] {
        const uploaded = new Set((application.documents || []).map((document) => document.slot));
        return this.getRequiredDocuments(application).filter((definition) => definition.required && !uploaded.has(definition.slot));
    }

    private getStepData(application: IKycApplication, step: KycStep): unknown {
        switch (step) {
            case KYC_STEP.GENERAL: return application.general;
            case KYC_STEP.PERSONAL: return application.personal;
            case KYC_STEP.UBOS: return application.ubos;
            case KYC_STEP.DIRECTORS: return application.directors;
            case KYC_STEP.QUESTIONNAIRE: return application.questionnaire;
            default: return undefined;
        }
    }

    private computeDisplayName(type: KycType, general?: Record<string, any>, personal?: Record<string, any>): string | undefined {
        if (type === "business") return general?.businessName?.trim() || undefined;
        const name = [personal?.firstName, personal?.lastName].filter(Boolean).join(" ").trim();
        return name || undefined;
    }

    private assertEditable(application: IKycApplication) {
        if (!KYC_EDITABLE_STATUSES.includes(application.status)) {
            throw errorResponseMessage.createError(
                ErrorResponseCode.UNABLE_TO_COMPLETE,
                "This application has been submitted and can no longer be edited",
                ErrorSeverity.LOW
            );
        }
    }

    private async getOwnApplication(userId: string) {
        const application = await this.findOne({ user: userId });
        if (!application) throw errorResponseMessage.resourceNotFound("KYC application");
        return application;
    }

    /**
     * Shapes an application for the client: adds the step/question/document
     * definitions it needs and fresh signed URLs for every uploaded document.
     */
    public async toClient(application: IKycApplication) {
        const plain: any = (application as any).toJSON ? (application as any).toJSON() : application;
        const steps = KYC_STEPS[application.type];

        const documents = await Promise.all((plain.documents || []).map(async (document: IKycDocument) => {
            let url: string | null = null;
            try {
                url = await this.uploadService.getFileUrl(document.key, DOCUMENT_URL_TTL_SECONDS);
            } catch (error) {
                logger.warn("Failed to sign KYC document URL", { key: document.key, error });
            }
            const { key, ...rest } = document;
            return { ...rest, url };
        }));

        return {
            ...plain,
            documents,
            progress: Math.round((application.completedSteps.filter((step) => steps.includes(step)).length / steps.length) * 100),
            config: {
                steps,
                questions: KYC_QUESTIONS[application.type],
                documents: this.getRequiredDocuments(application),
            },
        };
    }

    /**
     * Starts an application, or switches the type of a draft that has no saved data yet
     */
    public async start(userId: string, type: KycType) {
        const existing = await this.findOne({ user: userId });

        if (!existing) {
            return this.create({ user: userId, type, status: KYC_STATUS.DRAFT });
        }

        if (existing.type === type) return existing;

        this.assertEditable(existing);
        if (existing.status !== KYC_STATUS.DRAFT) {
            throw badRequest("You cannot change the application type after a review");
        }

        // Switching type discards data that only belongs to the old type
        for (const document of existing.documents) {
            await this.uploadService.deleteFile(document.key);
        }
        return this.updateById(existing.id, {
            $set: {
                type,
                completedSteps: [],
                general: {},
                personal: {},
                ubos: [],
                directors: [],
                questionnaire: {},
                documents: [],
            },
            $unset: { displayName: 1 },
        });
    }

    /**
     * Saves one step. With `complete` the data must be fully valid and the step
     * is marked done; otherwise it is kept as a draft so nothing typed is lost.
     */
    public async saveStep(userId: string, step: KycStep, data: unknown, complete: boolean) {
        const application = await this.getOwnApplication(userId);
        this.assertEditable(application);

        if (!KYC_STEPS[application.type].includes(step)) {
            throw badRequest(`"${step}" is not a step of a ${application.type} application`);
        }

        const schema = getStepSchema(application.type, step, complete)!;
        const parsed = schema.safeParse(data);
        if (!parsed.success) throw validationError(parsed.error);

        const update: Record<string, any> = {};

        if (step === KYC_STEP.DOCUMENTS) {
            if (complete) {
                const missing = this.getMissingDocuments(application);
                if (missing.length) {
                    throw badRequest(`Please upload: ${missing.map((definition) => definition.label).join(", ")}`);
                }
            }
        } else {
            update[step] = parsed.data;
        }

        if (step === KYC_STEP.GENERAL || step === KYC_STEP.PERSONAL) {
            update.displayName = this.computeDisplayName(
                application.type,
                step === KYC_STEP.GENERAL ? parsed.data : application.general,
                step === KYC_STEP.PERSONAL ? parsed.data : application.personal,
            );
        }

        const completedSteps = new Set(application.completedSteps);
        if (complete) completedSteps.add(step); else completedSteps.delete(step);
        update.completedSteps = KYC_STEPS[application.type].filter((s) => completedSteps.has(s));

        // Remove source-of-funds files for UBOs that were deleted or are no longer PEPs
        if (step === KYC_STEP.UBOS) {
            const stillRequired = new Set(
                (parsed.data as any[])
                    .filter((ubo) => ubo.kind === "individual" && ubo.isPep)
                    .map((ubo) => `${UBO_SOURCE_OF_FUNDS_PREFIX}${ubo.id}`)
            );
            const [keep, drop] = this.partitionDocuments(application.documents, (document) =>
                !document.slot.startsWith(UBO_SOURCE_OF_FUNDS_PREFIX) || stillRequired.has(document.slot));
            if (drop.length) {
                update.documents = keep;
                await Promise.all(drop.map((document) => this.uploadService.deleteFile(document.key)));
            }
        }

        return this.updateById(application.id, { $set: update });
    }

    private partitionDocuments(documents: IKycDocument[], predicate: (document: IKycDocument) => boolean) {
        const keep: IKycDocument[] = [];
        const drop: IKycDocument[] = [];
        for (const document of documents) (predicate(document) ? keep : drop).push(document);
        return [keep, drop] as const;
    }

    /**
     * Uploads (or replaces) the file for one document slot
     */
    public async uploadDocument(userId: string, slot: string, file: Express.Multer.File | undefined, issueDate?: string) {
        const application = await this.getOwnApplication(userId);
        this.assertEditable(application);

        if (!file) throw badRequest("Please choose a file to upload");

        const definition = this.getRequiredDocuments(application).find((d) => d.slot === slot);
        if (!definition) throw badRequest("Unknown document type");

        let parsedIssueDate: Date | undefined;
        if (issueDate) {
            parsedIssueDate = new Date(issueDate);
            if (isNaN(parsedIssueDate.getTime())) throw badRequest("Issue date is invalid");
            if (parsedIssueDate > new Date()) throw badRequest("Issue date cannot be in the future");
        } else if (definition.requiresIssueDate) {
            throw badRequest("Issue date is required for this document");
        }

        const upload = await this.uploadService.uploadFile(file, {
            folder: `${KYC_DOCUMENT_UPLOAD.uploadPath}${application.id}/`,
            customFilename: slot,
            makePublic: false,
        });
        if (!upload.success || !upload.file) {
            throw errorResponseMessage.unableToComplete(upload.error || "Failed to upload document");
        }

        const previous = application.documents.find((document) => document.slot === slot);
        const document: IKycDocument = {
            slot,
            key: upload.file.key,
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size,
            issueDate: parsedIssueDate,
            uploadedAt: new Date(),
        };

        const updated = await this.updateById(application.id, {
            $set: { documents: [...application.documents.filter((d) => d.slot !== slot), document] },
        });

        if (previous) await this.uploadService.deleteFile(previous.key);

        return updated;
    }

    public async removeDocument(userId: string, slot: string) {
        const application = await this.getOwnApplication(userId);
        this.assertEditable(application);

        const document = application.documents.find((d) => d.slot === slot);
        if (!document) throw errorResponseMessage.resourceNotFound("Document");

        const completedSteps = application.completedSteps.filter((step) => step !== KYC_STEP.DOCUMENTS);
        const updated = await this.updateById(application.id, {
            $set: { documents: application.documents.filter((d) => d.slot !== slot), completedSteps },
        });
        await this.uploadService.deleteFile(document.key);
        return updated;
    }

    /**
     * Final submission: re-validates every step (earlier steps may have been edited)
     * and notifies admins and the applicant by email.
     */
    public async submit(user: IUser) {
        const application = await this.getOwnApplication(String(user._id));
        this.assertEditable(application);

        for (const step of KYC_STEPS[application.type]) {
            if (step === KYC_STEP.DOCUMENTS) continue;
            const parsed = getStepSchema(application.type, step, true)!.safeParse(this.getStepData(application, step));
            if (!parsed.success) {
                throw errorResponseMessage.createError(
                    ErrorResponseCode.BAD_REQUEST,
                    `Please complete the "${step}" step: ${parsed.error.issues[0]?.message}`,
                    ErrorSeverity.LOW,
                    { step }
                );
            }
        }

        const missing = this.getMissingDocuments(application);
        if (missing.length) {
            throw errorResponseMessage.createError(
                ErrorResponseCode.BAD_REQUEST,
                `Please upload: ${missing.map((definition) => definition.label).join(", ")}`,
                ErrorSeverity.LOW,
                { step: KYC_STEP.DOCUMENTS }
            );
        }

        const wasResubmission = application.status === KYC_STATUS.REJECTED;
        const updated = await this.updateById(application.id, {
            $set: {
                status: KYC_STATUS.SUBMITTED,
                submittedAt: new Date(),
                completedSteps: KYC_STEPS[application.type],
            },
            $unset: { rejectionReason: 1 },
            $push: { history: { status: KYC_STATUS.SUBMITTED, by: user._id, at: new Date() } },
        });

        await this.sendSubmissionEmails(user, updated, wasResubmission);
        return updated;
    }

    private async sendSubmissionEmails(user: IUser, application: IKycApplication, wasResubmission: boolean) {
        const label = application.type === "business" ? "KYB" : "KYC";
        const name = application.displayName || `${user.firstName} ${user.lastName}`;

        const adminEmails = config.ADMIN_EMAILS.split(",").map((email) => email.trim()).filter(Boolean);
        await Promise.all(adminEmails.map(async (email) => {
            try {
                await this.notificationService.emailService.sendNotificationEmail(email, {
                    title: `📋 New ${label} documents ${wasResubmission ? "resubmitted" : "submitted"}`,
                    eyebrow: "Admin · Verification",
                    name: "Admin",
                    message: `<strong>${escapeHtml(name)}</strong> (${escapeHtml(user.email)}) has ${wasResubmission ? "resubmitted" : "submitted"} their ${label} application and uploaded ${application.documents.length} document(s). Please review it.`,
                    actionUrl: `${config.FRONTEND_URL}/dashboard/admin/kyc/${application.id}`,
                    buttonText: "Review Application",
                });
            } catch (error) {
                logger.error("Failed to send KYC submission email to admin", { email, error });
            }
        }));

        try {
            await this.notificationService.emailService.sendNotificationEmail(user.email, {
                title: `✅ ${label} documents received`,
                eyebrow: "Verification",
                name: user.firstName,
                message: `Thank you, we've received your ${label} documents${application.type === "business" ? ` for <strong>${escapeHtml(name)}</strong>` : ""} and will update you within 72 hours.`,
                actionUrl: `${config.FRONTEND_URL}/kyc`,
                buttonText: "View Status",
            });
        } catch (error) {
            logger.error("Failed to send KYC submission email to applicant", { email: user.email, error });
        }
    }

    /**
     * Admin listing with status/type filters, search and per-status counts
     */
    public async adminList(params: { status?: string; type?: string; search?: string; page?: number; limit?: number }) {
        const query: FilterQuery<IKycApplication> = {};
        if (params.status && Object.values(KYC_STATUS).includes(params.status as KycStatus)) query.status = params.status;
        if (params.type && (params.type === "individual" || params.type === "business")) query.type = params.type;

        if (params.search?.trim()) {
            const pattern = new RegExp(escapeRegex(params.search.trim()), "i");
            const users = await this.userService.find(
                { $or: [{ email: pattern }, { firstName: pattern }, { lastName: pattern }] },
                { select: ["_id"], limit: 200 }
            );
            query.$or = [{ displayName: pattern }, { user: { $in: users.map((u) => u._id) } }];
        }

        const result = await this.paginate(query, {
            page: params.page || 1,
            limit: Math.min(params.limit || 20, 100),
            sort: { updatedAt: -1 },
            select: ["user", "type", "status", "displayName", "completedSteps", "submittedAt", "reviewedAt", "createdAt", "updatedAt"],
            populate: ["user"],
        });

        const countsRaw = await this.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]);
        const counts: Record<string, number> = Object.fromEntries(Object.values(KYC_STATUS).map((status) => [status, 0]));
        for (const { _id, count } of countsRaw) counts[_id] = count;

        const data = result.data.map((application: any) => {
            const plain = application.toJSON();
            const user = plain.user;
            const steps = KYC_STEPS[plain.type as KycType];
            return {
                ...plain,
                user: user ? { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email } : null,
                progress: Math.round((plain.completedSteps.filter((s: KycStep) => steps.includes(s)).length / steps.length) * 100),
            };
        });

        return { ...result, data, counts };
    }

    public async adminGet(id: string) {
        const application = await this.findById(id, { populate: ["user", "history.by", "reviewedBy"] });
        if (!application) throw errorResponseMessage.resourceNotFound("KYC application");
        const client: any = await this.toClient(application);

        const pickUser = (u: any) => u && typeof u === "object" && u.email
            ? { id: u.id ?? String(u._id), firstName: u.firstName, lastName: u.lastName, email: u.email, phoneNumber: u.phoneNumber, whatsappNumber: u.whatsappNumber, countryOfResidence: u.countryOfResidence }
            : u;
        client.user = pickUser(client.user);
        client.reviewedBy = pickUser(client.reviewedBy);
        client.history = (client.history || []).map((event: any) => ({ ...event, by: pickUser(event.by) }));
        return client;
    }

    /**
     * Admin decision; approving also marks the user as KYC verified
     */
    public async adminReview(admin: IUser, id: string, status: KycStatus, note?: string) {
        const application = await this.findById(id, { populate: ["user"] });
        if (!application) throw errorResponseMessage.resourceNotFound("KYC application");

        const allowedFrom = KYC_ADMIN_TRANSITIONS[status] || [];
        if (!allowedFrom.includes(application.status)) {
            throw badRequest(`Cannot move an application from "${application.status}" to "${status}"`);
        }

        const update: Record<string, any> = {
            $set: { status, reviewedAt: new Date(), reviewedBy: admin._id },
            $push: { history: { status, note, by: admin._id, at: new Date() } },
        };
        if (status === KYC_STATUS.REJECTED) update.$set.rejectionReason = note;

        await this.updateById(application.id, update);

        const applicant = application.user as IUser;
        if (status === KYC_STATUS.APPROVED) {
            await this.userService.updateById(String(applicant._id), { isKYCDone: true, isKYCRejected: false });
        }

        if (status !== KYC_STATUS.UNDER_REVIEW) {
            await this.sendDecisionEmail(applicant, application, status, note);
        }

        return this.adminGet(id);
    }

    private async sendDecisionEmail(user: IUser, application: IKycApplication, status: KycStatus, note?: string) {
        const label = application.type === "business" ? "KYB" : "KYC";
        const approved = status === KYC_STATUS.APPROVED;
        try {
            await this.notificationService.emailService.sendNotificationEmail(user.email, {
                title: approved ? `🎉 Your ${label} has been approved` : `Action needed on your ${label} application`,
                eyebrow: "Verification",
                name: user.firstName,
                message: approved
                    ? `Good news! Your ${label} application has been reviewed and approved.`
                    : `We reviewed your ${label} application and need a few changes before we can approve it. You can update your details and resubmit.`,
                additionalInfo: !approved && note ? `<strong>Reason:</strong> ${escapeHtml(note)}` : undefined,
                actionUrl: approved ? `${config.FRONTEND_URL}/dashboard/user` : `${config.FRONTEND_URL}/kyc`,
                buttonText: approved ? "Go to Dashboard" : "Update Application",
            });
        } catch (error) {
            logger.error("Failed to send KYC decision email", { email: user.email, error });
        }
    }
}

export default KycApplicationService;
