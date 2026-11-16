import z from "zod";
import kycApplicationRepository, { type KycAdminFilter } from "../repositories/kyc-application.repository";
import userRepository from "../repositories/user.repository";
import transactionRepository from "../repositories/transaction.repository";
import type { KycApplication as IKycApplication, KycDocument as IKycDocument, User as IUser } from "../types/entities";
import errorResponseMessage, { ErrorResponseCode, ErrorSeverity } from "../common/messages/error-response-message";
import {
    KYC_ADMIN_TRANSITIONS,
    KYC_DOCUMENT_UPLOAD,
    KYC_EDITABLE_STATUSES,
    KYC_MAX_TIER,
    KYC_QUESTIONS,
    KYC_STATUS,
    KYC_STEP,
    KYC_TYPE,
    getKycDocuments,
    getKycSteps,
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
import config from "../config/env.config";
import logger from "../utils/logger.utils";
import { TRANSACTION_STATUS } from "../common/constant";
import { TIER_NAME, USER_TIER, UserTier, isUserTier } from "../common/tier.constants";
import { IDENTITY_REQUIRED_CODE } from "../common/identity.constants";
import platformSettingsService from "./platform-settings.service";

/** Signed document links are short-lived because the files hold identity documents */
const DOCUMENT_URL_TTL_SECONDS = 60 * 60;

const escapeHtml = (value: unknown): string =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

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

/** Tier an application is for (applications from before tiers: full KYB = 3, KYC = 2) */
export const applicationTier = (application: Pick<IKycApplication, "type" | "tier">): UserTier =>
    isUserTier(application.tier) && application.tier > USER_TIER.INDIVIDUAL
        ? application.tier
        : application.type === "business" ? USER_TIER.INSTITUTION : USER_TIER.BUSINESS;

const stepsOf = (application: Pick<IKycApplication, "type" | "tier">) => getKycSteps(application.type, applicationTier(application));

const userTier = (user: Pick<IUser, "tier">): UserTier => isUserTier(user.tier) ? user.tier : USER_TIER.UNVERIFIED;

/** Higher tiers build on a verified BVN (Tier 1) */
const assertBvnVerified = (tier: UserTier) => {
    if (tier >= USER_TIER.INDIVIDUAL) return;
    throw errorResponseMessage.createError(403, "Verify your identity first with your BVN, NIN and a quick selfie. It takes about 2 minutes and moves you to Tier 1.", ErrorSeverity.LOW, { code: IDENTITY_REQUIRED_CODE });
};

const formatUsd = (value: number) => `$${value.toLocaleString("en-US")}`;

class KycApplicationService {
    private uploadService: FileUploadService;
    private notificationService: NotificationService;

    constructor() {
        this.uploadService = FileUploadFactory.createCustomUploadService(KYC_DOCUMENT_UPLOAD);
        this.notificationService = new NotificationService();
    }

    /**
     * Documents this application currently needs, including source-of-funds
     * evidence for every individual UBO declared as a PEP.
     */
    public getRequiredDocuments(application: IKycApplication): KycDocumentDefinition[] {
        const definitions = getKycDocuments(application.type, applicationTier(application)).map((definition) => {
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

    /** Source-of-funds slots still needed for these owners */
    private sourceOfFundsSlots(ubos: Record<string, any>[]): Set<string> {
        return new Set(
            ubos.filter((ubo) => ubo.kind === "individual" && ubo.isPep).map((ubo) => `${UBO_SOURCE_OF_FUNDS_PREFIX}${ubo.id}`)
        );
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

    /** Update an application; 404 if it has gone */
    private async write(...args: Parameters<typeof kycApplicationRepository.update>): Promise<IKycApplication> {
        const updated = await kycApplicationRepository.update(...args);
        if (!updated) throw errorResponseMessage.resourceNotFound("KYC application");
        return updated;
    }

    /** The user's application, if they've started one */
    public async findForUser(userId: string): Promise<IKycApplication | undefined> {
        return kycApplicationRepository.findByUser(userId);
    }

    private async getOwnApplication(userId: string) {
        const application = await kycApplicationRepository.findByUser(userId);
        if (!application) throw errorResponseMessage.resourceNotFound("KYC application");
        return application;
    }

    /**
     * Shapes an application for the client: adds the step/question/document
     * definitions it needs and fresh signed URLs for every uploaded document.
     */
    public async toClient(application: IKycApplication) {
        const plain: any = application;
        const steps = stepsOf(application);

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
            tier: applicationTier(application),
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
     * Starts (or changes) the user's upgrade application.
     *  - No application yet: creates one for the requested tier.
     *  - Draft/rejected: changes its tier (data is kept) or type (data is discarded).
     *  - Approved: starts an upgrade to a higher tier. Same type reuses the approved
     *    details; a different type archives them (with their documents) and starts fresh.
     */
    public async start(user: IUser, type: KycType, tier: UserTier) {
        if (tier > KYC_MAX_TIER[type]) {
            throw badRequest(`Tier ${tier} (${TIER_NAME[tier]}) is for registered businesses. Please apply as a business.`);
        }

        const currentTier = userTier(user);
        assertBvnVerified(currentTier);
        const existing = await kycApplicationRepository.findByUser(user.id);

        if (existing && existing.status !== KYC_STATUS.APPROVED && existing.type === type && applicationTier(existing) === tier) {
            return existing;
        }
        if (existing && [KYC_STATUS.SUBMITTED, KYC_STATUS.UNDER_REVIEW].includes(existing.status as any)) {
            throw badRequest("Your application is being reviewed. You can change it once we've responded.");
        }
        if (tier <= currentTier) {
            throw badRequest(`You're already on Tier ${currentTier} (${TIER_NAME[currentTier]}). Choose a higher tier to upgrade.`);
        }

        if (!existing) {
            return kycApplicationRepository.create({ user: user.id, type, tier, status: KYC_STATUS.DRAFT, ...this.prefillFromProfile(user, type) });
        }

        if (existing.status === KYC_STATUS.APPROVED) {
            const history = { status: KYC_STATUS.DRAFT, note: `Upgrade to Tier ${tier} (${TIER_NAME[tier]}) started`, by: user.id, at: new Date() };

            if (existing.type === type) {
                // Keep the approved details; new steps and documents still need completing
                const steps = getKycSteps(type, tier);
                return this.write(
                    existing.id,
                    {
                        tier,
                        status: KYC_STATUS.DRAFT,
                        completedSteps: existing.completedSteps.filter((step) => steps.includes(step) && step !== KYC_STEP.DOCUMENTS),
                        rejectionReason: null,
                    },
                    { history }
                );
            }

            const plain: any = existing;
            const snapshot = {
                type: plain.type,
                tier: applicationTier(existing),
                displayName: plain.displayName,
                general: plain.general,
                personal: plain.personal,
                ubos: plain.ubos,
                directors: plain.directors,
                questionnaire: plain.questionnaire,
                documents: plain.documents,
                submittedAt: plain.submittedAt,
                reviewedAt: plain.reviewedAt,
                reviewedBy: plain.reviewedBy,
                archivedAt: new Date(),
            };
            return this.write(
                existing.id,
                {
                    ...this.emptyApplicationData(),
                    ...this.prefillFromProfile(user, type),
                    type,
                    tier,
                    status: KYC_STATUS.DRAFT,
                    displayName: null,
                    rejectionReason: null,
                    submittedAt: null,
                    reviewedAt: null,
                    reviewedBy: null,
                },
                { archive: snapshot, history }
            );
        }

        this.assertEditable(existing);

        if (existing.type === type) {
            // Same details, different requirements: documents must be checked again
            const steps = getKycSteps(type, tier);
            return this.write(existing.id, {
                tier,
                completedSteps: existing.completedSteps.filter((step) => steps.includes(step) && step !== KYC_STEP.DOCUMENTS),
            });
        }

        if (existing.status !== KYC_STATUS.DRAFT) {
            throw badRequest("You cannot change the application type after a review");
        }

        // Switching type discards data that only belongs to the old type
        for (const document of existing.documents) {
            await this.uploadService.deleteFile(document.key);
        }
        return this.write(existing.id, {
            ...this.emptyApplicationData(),
            ...this.prefillFromProfile(user, type),
            type,
            tier,
            displayName: null,
        });
    }

    /**
     * Starts a new application from what the user gave at sign-up, so they
     * don't type their name, email and phone twice. Everything stays editable.
     */
    private prefillFromProfile(user: IUser, type: KycType) {
        const country = user.countryOfResidence || undefined;
        const address = country ? { country } : {};
        const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");

        if (type === KYC_TYPE.BUSINESS) {
            return { general: this.compact({ applicantName: fullName || undefined, applicantEmail: user.email, address }) };
        }
        return {
            personal: this.compact({
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                phoneNumber: user.phoneNumber,
                nationality: user.countryOfOrigin,
                address,
            }),
        };
    }

    private compact(values: Record<string, unknown>) {
        return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ""));
    }

    private emptyApplicationData() {
        return {
            completedSteps: [] as KycStep[],
            general: {},
            personal: {},
            ubos: [],
            directors: [],
            questionnaire: {},
            documents: [] as IKycDocument[],
        };
    }

    /**
     * Saves one step. With `complete` the data must be fully valid and the step
     * is marked done; otherwise it is kept as a draft so nothing typed is lost.
     */
    public async saveStep(userId: string, step: KycStep, data: unknown, complete: boolean) {
        const application = await this.getOwnApplication(userId);
        this.assertEditable(application);

        if (!stepsOf(application).includes(step)) {
            throw badRequest(`"${step}" is not a step of this application`);
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
        update.completedSteps = stepsOf(application).filter((s) => completedSteps.has(s));

        // Remove source-of-funds files for owners that were deleted or are no longer PEPs
        if (step === KYC_STEP.UBOS) {
            const stillRequired = this.sourceOfFundsSlots(update.ubos);
            const [keep, drop] = this.partitionDocuments(application.documents, (document) =>
                !document.slot.startsWith(UBO_SOURCE_OF_FUNDS_PREFIX) || stillRequired.has(document.slot));
            if (drop.length) {
                update.documents = keep;
                await Promise.all(drop.map((document) => this.uploadService.deleteFile(document.key)));
            }
        }

        return this.write(application.id, update);
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

        const updated = await this.write(application.id, {
            documents: [...application.documents.filter((d) => d.slot !== slot), document],
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
        const updated = await this.write(application.id, {
            documents: application.documents.filter((d) => d.slot !== slot),
            completedSteps,
        });
        await this.uploadService.deleteFile(document.key);
        return updated;
    }

    /**
     * Final submission: re-validates every step (earlier steps may have been edited)
     * and notifies admins and the applicant by email.
     */
    public async submit(user: IUser) {
        const application = await this.getOwnApplication(user.id);
        this.assertEditable(application);

        const currentTier = userTier(user);
        assertBvnVerified(currentTier);
        if (applicationTier(application) <= currentTier) {
            throw badRequest(`You're already on Tier ${currentTier}. Choose a higher tier to upgrade.`);
        }

        for (const step of stepsOf(application)) {
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
        const updated = await this.write(
            application.id,
            {
                status: KYC_STATUS.SUBMITTED,
                submittedAt: new Date(),
                completedSteps: stepsOf(application),
                rejectionReason: null,
            },
            { history: { status: KYC_STATUS.SUBMITTED, by: user.id, at: new Date() } }
        );
        if (!updated) throw errorResponseMessage.resourceNotFound("KYC application");

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
                    message: `<strong>${escapeHtml(name)}</strong> (${escapeHtml(user.email)}) has ${wasResubmission ? "resubmitted" : "submitted"} their ${label} application for <strong>Tier ${applicationTier(application)} (${TIER_NAME[applicationTier(application)]})</strong> and uploaded ${application.documents.length} document(s). Please review it.`,
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
    public async adminList(params: { status?: string; type?: string; tier?: number; search?: string; page?: number; limit?: number }) {
        const filter: KycAdminFilter = {};
        if (params.tier && isUserTier(params.tier)) filter.tier = params.tier;
        if (params.status && Object.values(KYC_STATUS).includes(params.status as KycStatus)) filter.status = params.status as KycStatus;
        if (params.type && (params.type === "individual" || params.type === "business")) filter.type = params.type;

        if (params.search?.trim()) {
            const text = params.search.trim();
            filter.search = { text, userIds: await userRepository.searchIds(text, 200) };
        }

        const result = await kycApplicationRepository.paginate(filter, { page: params.page || 1, limit: Math.min(params.limit || 20, 100) });

        const countsRaw = await kycApplicationRepository.countByStatus();
        const counts: Record<string, number> = Object.fromEntries(Object.values(KYC_STATUS).map((status) => [status, 0]));
        for (const [status, count] of Object.entries(countsRaw)) counts[status] = count;

        const owners = new Map((await userRepository.findManyByIds(result.data.map((a) => a.user))).map((u) => [u.id, u]));
        const data = result.data.map((application) => {
            const user = owners.get(application.user);
            const steps = stepsOf(application);
            return {
                id: application.id,
                type: application.type,
                tier: applicationTier(application),
                status: application.status,
                displayName: application.displayName,
                completedSteps: application.completedSteps,
                submittedAt: application.submittedAt,
                reviewedAt: application.reviewedAt,
                createdAt: application.createdAt,
                updatedAt: application.updatedAt,
                user: user ? { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, tier: userTier(user) } : null,
                progress: Math.round((application.completedSteps.filter((s: KycStep) => steps.includes(s)).length / steps.length) * 100),
            };
        });

        return { ...result, data, counts };
    }

    public async adminGet(id: string) {
        const application = await kycApplicationRepository.findById(id);
        if (!application) throw errorResponseMessage.resourceNotFound("KYC application");
        const client: any = await this.toClient(application);

        // "Populate" the applicant, the reviewer and whoever acted in the history
        const ids = [application.user, application.reviewedBy, ...(application.history || []).map((event) => event.by)].filter(Boolean) as string[];
        const people = new Map((await userRepository.findManyByIds(ids)).map((u) => [u.id, u]));
        const pickUser = (id?: string) => {
            const u = id ? people.get(id) : undefined;
            return u
                ? { id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email, phoneNumber: u.phoneNumber, whatsappNumber: u.whatsappNumber, countryOfResidence: u.countryOfResidence, tier: userTier(u) }
                : id;
        };
        client.user = pickUser(application.user);
        client.reviewedBy = pickUser(application.reviewedBy);
        client.history = (application.history || []).map((event) => ({ ...event, by: pickUser(event.by) }));
        return client;
    }

    /**
     * Admin decision; approving raises the user to the application's tier
     */
    public async adminReview(admin: IUser, id: string, status: KycStatus, note?: string) {
        const application = await kycApplicationRepository.findById(id);
        if (!application) throw errorResponseMessage.resourceNotFound("KYC application");

        const allowedFrom = KYC_ADMIN_TRANSITIONS[status] || [];
        if (!allowedFrom.includes(application.status)) {
            throw badRequest(`Cannot move an application from "${application.status}" to "${status}"`);
        }

        await this.write(
            application.id,
            {
                status,
                reviewedAt: new Date(),
                reviewedBy: admin.id,
                ...(status === KYC_STATUS.REJECTED ? { rejectionReason: note ?? null } : {}),
            },
            { history: { status, note, by: admin.id, at: new Date() } }
        );

        const applicant = await userRepository.findById(application.user);
        if (!applicant) throw errorResponseMessage.resourceNotFound("User");
        if (status === KYC_STATUS.APPROVED) {
            const tier = applicationTier(application);
            if (tier > userTier(applicant)) {
                await userRepository.setTier(
                    applicant.id,
                    tier,
                    { reason: `${application.type === "business" ? "KYB" : "KYC"} application approved`, by: admin.id },
                    { extra: { isKYCDone: true, isKYCRejected: false } }
                );
            } else {
                await userRepository.update(applicant.id, { isKYCDone: true, isKYCRejected: false });
            }
            // Release transactions that were waiting on verification (as a Smile ID pass does)
            await transactionRepository.moveStatusForUser(
                applicant.id,
                TRANSACTION_STATUS.AWAITING_KYC_VERIFICATION as "awaiting_kyc_verification",
                TRANSACTION_STATUS.AWAITING_CONFIRMATION as "awaiting_confirmation"
            );
        }

        if (status !== KYC_STATUS.UNDER_REVIEW) {
            await this.sendDecisionEmail(applicant, application, status, note);
        }

        return this.adminGet(id);
    }

    private async sendDecisionEmail(user: IUser, application: IKycApplication, status: KycStatus, note?: string) {
        const label = application.type === "business" ? "KYB" : "KYC";
        const approved = status === KYC_STATUS.APPROVED;
        const tier = applicationTier(application);
        const limit = await platformSettingsService.getTierDailyLimitUsd(tier).catch(() => undefined);
        const limitText = limit === null ? "with no daily limit" : limit ? `with a daily limit of ${formatUsd(limit)}` : "with a higher daily limit";
        try {
            await this.notificationService.emailService.sendNotificationEmail(user.email, {
                title: approved ? `🎉 Your ${label} has been approved` : `Action needed on your ${label} application`,
                eyebrow: "Verification",
                name: user.firstName,
                message: approved
                    ? `Good news! Your ${label} application has been approved and your account is now on <strong>Tier ${tier} (${TIER_NAME[tier]})</strong>, ${limitText}.`
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
