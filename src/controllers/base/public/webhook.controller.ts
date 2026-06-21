import { Request, Response, NextFunction } from "express";
import BaseController from "../base-controller";
import VerificationService from "../../../services/verification.service";
import errorResponseMessage from "../../../common/messages/error-response-message";
import TransactionService from "../../../services/transaction.service";
import { TRANSACTION_STATUS } from "../../../common/constant";
import NotificationService from "../../../utils/notification.utils";
import config from "../../../config/env.config";
import UserService from "../../../services/user.service";
import SmileId from "../../../services/smile-id.service";
import yellowCardService from "../../../services/yellowcard.service";
import ogatewayService from "../../../services/ogateway.service";
import paystackService from "../../../services/paystack.service";
import WalletService from "../../../services/wallet.service";
import logger from "../../../utils/logger.utils";
import webhookEventService from "../../../services/webhook-event.service";
import { WEBHOOK_PROVIDER } from "../../../common/constant";

class WebhookController extends BaseController {

    verificationService: VerificationService;
    transactionService: TransactionService;
    notificationService: NotificationService;
    userService: UserService;
    smileIdService: SmileId;
    walletService: WalletService;

    constructor () {
        super();
        this.verificationService = new VerificationService();
        this.transactionService = new TransactionService(["user"]);
        this.notificationService = new NotificationService();
        this.userService = new UserService();
        this.smileIdService = new SmileId();
        this.walletService = new WalletService();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.post("/smile-id-callback", this.smileIdCallback.bind(this));
        this.router.post("/yellowcard-callback", this.yellowCardCallback.bind(this));
        this.router.post("/ogateway", this.ogatewayCallback.bind(this));
        this.router.post("/paystack-callback", this.paystackCallback.bind(this));
    }

    private async smileIdCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
        const webhookData = req.body;
        const signature = webhookData?.signature;
        const timestamp = webhookData?.timestamp;
        const externalId = webhookData?.SmileJobID;

        let isValidSignature = false;
        if (signature && timestamp) {
            try {
                isValidSignature = this.smileIdService.verifySignature(signature, timestamp);
            } catch (error: any) {
                logger.error("Smile ID webhook: signature verification threw", {
                    error: error?.message || String(error),
                });
            }
        }

        const stored = await webhookEventService.record({
            provider: WEBHOOK_PROVIDER.SMILE_ID,
            req,
            payload: webhookData,
            signature: typeof signature === 'string' ? signature : undefined,
            signatureValid: isValidSignature,
            event: webhookData?.ResultCode,
            externalId,
        });
        const eventId = stored?._id?.toString();

        try {
            if (!signature || !timestamp) {
                logger.warn("Smile ID webhook: missing signature or timestamp");
                if (eventId) await webhookEventService.markFailed(eventId, 'missing signature/timestamp');
                res.status(400).json({ error: "Invalid webhook payload - missing signature or timestamp" });
                return;
            }

            if (!isValidSignature) {
                logger.error("Smile ID webhook: invalid signature — rejecting");
                if (eventId) await webhookEventService.markFailed(eventId, 'invalid signature');
                res.status(401).json({ error: "Invalid signature" });
                return;
            }
            
            // Extract key verification details with safe access
            const resultCode = webhookData.ResultCode;
            const resultText = webhookData.ResultText;
            const confidenceValue = webhookData.ConfidenceValue;
            const smileJobID = webhookData.SmileJobID;
            const isFinalResult = webhookData.IsFinalResult === true || webhookData.IsFinalResult === "true";
            
            // Get detailed actions to understand what failed (with safe access)
            const actions = webhookData.Actions || {};
            const selfieCheckStatus = actions.Selfie_Check || "Unknown";
            const registerSelfieStatus = actions.Register_Selfie || "Unknown";
            const idVerificationStatus = actions.Verify_ID_Number || "Unknown";
            const personalInfoStatus = actions.Return_Personal_Info || "Unknown";
            
            // Smile ID result codes:
            // 0000: Complete verification success (final) - job_type 1
            // 0810: Enroll User (successful enrollment with all checks passed - final result) - job_type 1
            // 0820: Authenticated (successful authentication - final result) - job_type 2
            // 0821: Failed Authentication - Possible Spoof Detected (failure for job_type 2)
            // 1012: ID Number Validated (ID verification successful - intermediate result, wait for final)
            const finalSuccessCodes = ["0000", "0810", "0820"]; // Added 0820 for job_type 2 authentication success
            const intermediateSuccessCodes = ["1012"];
            const authenticationFailureCodes = ["0821"]; // Authentication failures (job_type 2)
            const isFinalSuccessCode = finalSuccessCodes.includes(resultCode);
            const isIntermediateSuccessCode = intermediateSuccessCodes.includes(resultCode);
            const isAuthenticationFailure = authenticationFailureCodes.includes(resultCode);
            const isFailedCode = resultCode.startsWith("09") || isAuthenticationFailure; // Failure codes start with 09 or are authentication failures
            
            // Determine if this is a final result
            // 0810, 0820, and 0000 are always final, 1012 is always intermediate (regardless of IsFinalResult flag)
            // For other codes, use the IsFinalResult flag
            const isThisFinalResult = isIntermediateSuccessCode 
                ? false  // 1012 is always intermediate
                : (isFinalResult || isFinalSuccessCode || isFailedCode);
            
            // For intermediate success codes (like 1012), just acknowledge and wait for final result
            if (isIntermediateSuccessCode) {
                console.log("⚠️ [INFO] Intermediate result (1012) received, waiting for final result");
                res.status(200).json({ received: true, message: "Intermediate result, waiting for final result" });
                return;
            }
            
            // Determine overall verification status
            // Only mark as verified if:
            // 1. FORCE_VERIFY is enabled, OR
            // 2. It's a final success code AND critical actions passed
            let isVerified = false;
            if (process.env.FORCE_VERIFY === "true") {
                isVerified = true;
            } else if (isFinalSuccessCode && isThisFinalResult) {
                // For job_type 2 (Authentication), result code 0820 means authenticated successfully
                // For job_type 1 (Enrollment), check critical actions
                if (resultCode === "0820") {
                    // For authentication (job_type 2), check selfie comparison passed
                    const selfieToRegisteredSelfieStatus = actions.Selfie_To_Registered_Selfie_Compare || "Unknown";
                    const livenessCheckStatus = actions.Liveness_Check || "Unknown";
                    isVerified = (selfieToRegisteredSelfieStatus === "Passed" || selfieToRegisteredSelfieStatus === "Completed") &&
                                 (livenessCheckStatus === "Passed" || selfieCheckStatus === "Passed");
                } else {
                    // For enrollment (job_type 1), check that critical actions passed
                    const criticalActionsPassed = 
                        (idVerificationStatus === "Verified" || idVerificationStatus === "Passed") &&
                        (selfieCheckStatus === "Passed" || selfieCheckStatus === "Verified") &&
                        (registerSelfieStatus === "Passed" || registerSelfieStatus === "Verified");
                    
                    isVerified = criticalActionsPassed;
                }
            }
            
            console.log("=== Smile ID Verification Result ===");
            console.log(`Result Code: ${resultCode}`);
            console.log(`Result Text: ${resultText}`);
            console.log(`Is Final Result (from webhook): ${isFinalResult}`);
            console.log(`Is Final Result (calculated): ${isThisFinalResult}`);
            console.log(`Is Final Success Code: ${isFinalSuccessCode}`);
            console.log(`Is Failed Code: ${isFailedCode}`);
            console.log(`Status: ${isVerified ? 'VERIFIED' : 'FAILED'}`);
            console.log(`Confidence: ${confidenceValue}`);
            console.log(`Job ID: ${smileJobID}`);
            console.log("\n=== Detailed Actions ===");
            console.log(`ID Number Verification: ${idVerificationStatus}`);
            console.log(`Selfie Check: ${selfieCheckStatus}`);
            console.log(`Register Selfie: ${registerSelfieStatus}`);
            console.log(`Selfie To Registered Selfie Compare: ${actions.Selfie_To_Registered_Selfie_Compare || "Unknown"}`);
            console.log(`Liveness Check: ${actions.Liveness_Check || "Unknown"}`);
            console.log(`Personal Info: ${personalInfoStatus}`);
            
            // Get the reason for failure (with safe access)
            let failureReason = (actions?.Selfie_Check && typeof actions.Selfie_Check === 'object' && actions.Selfie_Check.ResultText) 
                ? actions.Selfie_Check.ResultText 
                : this.getFailureReason(resultCode, actions);
            
            console.log(`\nFailure Reason: ${failureReason}`);
            
            // Access image links if needed
            const selfieImage = webhookData.ImageLinks?.selfie_image;
            const idPhotoImage = webhookData.ImageLinks?.id_photo_image;

            console.log(webhookData.PartnerParams, "This is the partner params")
            
            // Get partner params (your custom data)
            const userID = webhookData.PartnerParams?.user_id;
            const jobID = webhookData.PartnerParams?.job_id;

            if (!userID) {
                console.error("❌ [ERROR] Missing user_id in webhook PartnerParams");
                res.status(400).json({ error: "Missing user_id in webhook payload" });
                return;
            }

            console.log({ user: userID, status: 'pending' }, "This is the query used for finding");
            
            // Find the pending verification record (or recently failed if this is a retry with success)
            let pendingVerification = await this.verificationService.findOne({ user: userID, status: 'pending' });
            
            // If no pending verification found and this is a successful final result,
            // check for recently failed verification that might need to be updated
            // This handles the case where an intermediate result (1012) was incorrectly marked as failed
            if (!pendingVerification && isVerified && isThisFinalResult) {
                console.log("⚠️ [INFO] No pending verification found, checking for failed verification to update");
                // Look for failed verifications with reason containing these success codes
                const failedVerification = await this.verificationService.findOne({ 
                    user: userID, 
                    status: 'failed'
                });
                
                // Check if the failure reason contains success codes (indicating it was incorrectly marked as failed)
                if (failedVerification && failedVerification.reason && 
                    (failedVerification.reason.includes("1012") || failedVerification.reason.includes("0810"))) {
                    console.log("✅ [INFO] Found failed verification that should be updated to passed");
                    pendingVerification = failedVerification;
                }
            }
            
            console.log(pendingVerification, "This is the pendingVerification gotten after findOne called");

            if(!pendingVerification) {
                console.error(`❌ [ERROR] No pending verification found for user: ${userID}`);
                // Return 200 to prevent retries, but log the error
                res.status(200).json({ received: true, error: "No pending verification found" });
                return;
            }
            
            // Only process final results or actual failures
            // Intermediate results should have been handled earlier
            if (!isThisFinalResult && !isFailedCode) {
                console.log("⚠️ [INFO] Skipping update - not a final result and not a failure");
                res.status(200).json({ received: true, message: "Intermediate result, waiting for final result" });
                return;
            }
            
            // NAME VALIDATION: Verify that the name on the account matches the name on the BVN
            // This is an additional security check to ensure the BVN belongs to the account holder
            let nameValidationResult: { match: boolean; reason?: string } | null = null;
            if (isVerified && isThisFinalResult) {
                try {
                    // Get user from database
                    const user = await this.userService.findById(userID);
                    if (!user) {
                        console.error(`❌ [ERROR] User not found for name validation: ${userID}`);
                        isVerified = false;
                        failureReason = "User account not found";
                    } else {
                        // Extract PersonalInfo from webhook response
                        // Smile ID returns personal info in different possible structures
                        const personalInfo = webhookData.PersonalInfo || webhookData.personalInfo || webhookData.personal_info;
                        
                        console.log("\n🔍 [NAME VALIDATION] Starting name comparison...");
                        console.log(`  User Account Name: ${user.firstName} ${user.lastName}`);
                        
                        if (personalInfo) {
                            console.log("  📋 PersonalInfo found in webhook response");
                            console.log("  📋 PersonalInfo structure:", JSON.stringify(personalInfo, null, 2));
                            
                            // Extract name fields (Smile ID may return different field names)
                            const bvnFirstName = personalInfo.firstName || personalInfo.first_name || personalInfo.FirstName || personalInfo.First_Name;
                            const bvnLastName = personalInfo.lastName || personalInfo.last_name || personalInfo.LastName || personalInfo.Last_Name;
                            const bvnFullName = personalInfo.fullName || personalInfo.full_name || personalInfo.FullName || personalInfo.Full_Name || 
                                               personalInfo.name || personalInfo.Name || personalInfo.nameOnCard || personalInfo.name_on_card;
                            
                            console.log(`  BVN First Name: ${bvnFirstName || 'N/A'}`);
                            console.log(`  BVN Last Name: ${bvnLastName || 'N/A'}`);
                            console.log(`  BVN Full Name: ${bvnFullName || 'N/A'}`);
                            
                            // Compare names
                            nameValidationResult = this.compareNames(
                                user.firstName,
                                user.lastName,
                                bvnFirstName,
                                bvnLastName,
                                bvnFullName
                            );
                            
                            if (!nameValidationResult.match) {
                                console.error(`❌ [NAME VALIDATION] Name mismatch detected: ${nameValidationResult.reason}`);
                                isVerified = false;
                                failureReason = nameValidationResult.reason || "Name on BVN does not match account name";
                            } else {
                                console.log("✅ [NAME VALIDATION] Names match successfully");
                            }
                        } else {
                            // Check if Return_Personal_Info action indicates personal info should be available
                            if (personalInfoStatus === "Passed" || personalInfoStatus === "Verified" || personalInfoStatus === "Completed") {
                                console.warn("⚠️ [NAME VALIDATION] PersonalInfo action passed but no PersonalInfo data in webhook response");
                                console.warn("⚠️ [NAME VALIDATION] This may indicate a webhook format change or missing data");
                                // Don't fail verification if personal info action passed but data is missing
                                // This is a graceful degradation - we'll log but not block verification
                            } else {
                                console.log("ℹ️  [NAME VALIDATION] PersonalInfo not available in webhook response (this is normal for some verification types)");
                                // For job_type 2 (Authentication), personal info might not be returned
                                // We'll allow verification to proceed but log the absence
                            }
                        }
                    }
                } catch (error: any) {
                    console.error("❌ [NAME VALIDATION] Error during name validation:", error?.message || error);
                    console.error("   Error stack:", error?.stack);
                    // If name validation fails due to an error, we should fail the verification for security
                    // However, we'll log it as a warning and allow verification if FORCE_VERIFY is enabled
                    if (process.env.FORCE_VERIFY !== "true") {
                        isVerified = false;
                        failureReason = "Name validation error: " + (error?.message || "Unknown error");
                    } else {
                        console.warn("⚠️ [NAME VALIDATION] Name validation error but FORCE_VERIFY is enabled, allowing verification");
                    }
                }
            }
            
            const updatedVerification = await this.verificationService.updateById(pendingVerification?.id!.toString(), {
                ...(isVerified ? {
                    status: 'passed'
                } : {
                    status: 'failed',
                    reason: failureReason,
                })
            });

            console.log(updatedVerification, "This is the updated verification")

            if(isVerified) {
                await this.userService.updateById(userID, {
                    isVerified: true,
                    isKYCDone: true
                })
                await this.transactionService.updateMany({
                    user: userID,
                    status: TRANSACTION_STATUS.AWAITING_KYC_VERIFICATION
                }, {
                    $set: { status: TRANSACTION_STATUS.AWAITING_CONFIRMATION }
                })

                // Send KYC verification completed email
                try {
                    const user = await this.userService.findById(userID);
                    if (user) {
                        await this.notificationService.emailService.sendNotificationEmail(
                            user.email,
                            {
                                title: '✅ KYC Verification Completed',
                                message: `Congratulations ${user.firstName}! Your KYC verification has been successfully completed. You can now enjoy full access to all Solution Pay features.`,
                                appName: 'Solution Pay',
                                actionUrl: `${config.FRONTEND_URL}/dashboard/user`,
                                buttonText: 'Go to Dashboard'
                            }
                        );
                    }
                } catch (error) {
                    console.error('Failed to send KYC verification completed email:', error);
                    // Don't fail webhook processing if email fails
                }
            } else {
                // Send KYC verification failed email
                try {
                    const user = await this.userService.findById(userID);
                    if (user) {
                        await this.notificationService.emailService.sendNotificationEmail(
                            user.email,
                            {
                                title: '❌ KYC Verification Failed',
                                message: `Hello ${user.firstName}, your KYC verification was unsuccessful. Reason: ${failureReason}. Please try again or contact support for assistance.`,
                                appName: 'Solution Pay',
                                actionUrl: `${config.FRONTEND_URL}/dashboard/user/profile`,
                                buttonText: 'Try Again'
                            }
                        );
                    }
                } catch (error) {
                    console.error('Failed to send KYC verification failed email:', error);
                    // Don't fail webhook processing if email fails
                }
            }

            // Always respond with 200 to acknowledge receipt
            res.status(200).json({ received: true });
            if (eventId) await webhookEventService.markProcessed(eventId);
        } catch (error) {
            console.error("Error processing Smile ID webhook:", error);
            if (eventId) await webhookEventService.markFailed(eventId, error);
            // Still return 200 to prevent retries
            if (!res.headersSent) {
                res.status(200).json({ received: true, error: "Processing failed" });
            }
        }
    }
    
    /**
     * Normalize a name string for comparison
     * - Converts to lowercase
     * - Removes extra whitespace
     * - Removes special characters (keeping only letters, spaces, and hyphens)
     */
    private normalizeName(name: string): string {
        if (!name) return '';
        return name
            .toLowerCase()
            .trim()
            .replace(/[^\w\s-]/g, '') // Remove special characters except hyphens
            .replace(/\s+/g, ' '); // Replace multiple spaces with single space
    }

    /**
     * Compare names from BVN with user's name on platform
     * Uses fuzzy matching to handle variations in name formatting
     */
    private compareNames(
        userFirstName: string,
        userLastName: string,
        bvnFirstName?: string,
        bvnLastName?: string,
        bvnFullName?: string
    ): { match: boolean; reason?: string } {
        // Normalize user names
        const normalizedUserFirst = this.normalizeName(userFirstName || '');
        const normalizedUserLast = this.normalizeName(userLastName || '');
        const normalizedUserFull = `${normalizedUserFirst} ${normalizedUserLast}`.trim();

        // If we have full name from BVN, try that first
        if (bvnFullName) {
            const normalizedBvnFull = this.normalizeName(bvnFullName);
            // Check if full names match (exact or contains)
            if (normalizedBvnFull === normalizedUserFull || 
                normalizedBvnFull.includes(normalizedUserFirst) && normalizedBvnFull.includes(normalizedUserLast) ||
                normalizedUserFull.includes(normalizedBvnFull.split(' ')[0]) && normalizedUserFull.includes(normalizedBvnFull.split(' ').slice(-1)[0])) {
                return { match: true };
            }
        }

        // Try individual first and last name comparison
        if (bvnFirstName && bvnLastName) {
            const normalizedBvnFirst = this.normalizeName(bvnFirstName);
            const normalizedBvnLast = this.normalizeName(bvnLastName);

            // Check if first and last names match (with some flexibility)
            const firstNameMatch = normalizedBvnFirst === normalizedUserFirst || 
                                  normalizedBvnFirst.includes(normalizedUserFirst) || 
                                  normalizedUserFirst.includes(normalizedBvnFirst);
            
            const lastNameMatch = normalizedBvnLast === normalizedUserLast || 
                                 normalizedBvnLast.includes(normalizedUserLast) || 
                                 normalizedUserLast.includes(normalizedBvnLast);

            if (firstNameMatch && lastNameMatch) {
                return { match: true };
            }

            // If only one matches, provide specific reason
            if (!firstNameMatch && !lastNameMatch) {
                return { 
                    match: false, 
                    reason: `Name mismatch: BVN name (${bvnFirstName} ${bvnLastName}) does not match account name (${userFirstName} ${userLastName})` 
                };
            } else if (!firstNameMatch) {
                return { 
                    match: false, 
                    reason: `First name mismatch: BVN first name (${bvnFirstName}) does not match account first name (${userFirstName})` 
                };
            } else {
                return { 
                    match: false, 
                    reason: `Last name mismatch: BVN last name (${bvnLastName}) does not match account last name (${userLastName})` 
                };
            }
        }

        // If we only have full name and it didn't match, or no name data at all
        if (bvnFullName) {
            return { 
                match: false, 
                reason: `Name mismatch: BVN name (${bvnFullName}) does not match account name (${userFirstName} ${userLastName})` 
            };
        }

        // If no BVN name data available, we can't validate (log warning but don't fail)
        console.warn("⚠️ [WARNING] No name data available from BVN for comparison");
        return { match: true }; // Don't fail if name data is missing (graceful degradation)
    }

    private getFailureReason(resultCode: string, actions: any): string {
        // Map result codes to user-friendly reasons
        const reasonMap: Record<string, string> = {
            "0000": "Verification successful",
            "0810": "Enroll User - Verification successful",
            "0820": "Authenticated - Verification successful",
            "0821": "Failed Authentication - Possible Spoof Detected. Please ensure you're using a clear, well-lit selfie and try again.",
            "1012": "ID Number Validated - Verification successful",
            "0911": "Images unusable - Anti-spoof check failed or poor image quality",
            "0812": "ID number not found in database",
            "0813": "ID information mismatch",
            "0814": "Selfie does not match ID photo",
            "0815": "Multiple identities detected",
            "0816": "ID number validation failed",
        };
        
        // Safety check for actions
        if (!actions || typeof actions !== 'object') {
            return reasonMap[resultCode] || `Verification failed with code: ${resultCode}`;
        }
        
        // Check specific action failures
        if (actions.Selfie_Check === "Failed") {
            return "Selfie verification failed - possible liveness/anti-spoof issue";
        }
        
        if (actions.Register_Selfie === "Rejected") {
            return "Selfie registration rejected - image quality issues";
        }
        
        if (actions.Verify_ID_Number === "Not Verified") {
            return "ID number could not be verified";
        }
        
        return reasonMap[resultCode] || `Verification failed with code: ${resultCode}`;
    }

    /**
     * YellowCard webhook handler.
     * Verifies the webhook signature and delegates processing to the transaction service.
     */
    /**
     * OGateway webhook handler — handles collection and payout outcome events.
     * Signature: HMAC-SHA512 hex over raw body, header `x-ogateway-signature`.
     * Idempotency keyed on `reference_business` (= our internal sequenceId).
     */
    private async ogatewayCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
        const rawBody = (req as any).rawBody || JSON.stringify(req.body);
        const signature = (req.headers["x-ogateway-signature"] as string) || undefined;
        const externalId = req.body?.reference_business || req.body?.id;
        const eventName = req.body?.channel
            ? `${(req.body.channel as string).toLowerCase()}.${(req.body.status || 'event').toLowerCase()}`
            : (req.body?.status || 'event').toLowerCase();

        const signatureValid = ogatewayService.verifyWebhookSignature(rawBody, signature);

        const stored = await webhookEventService.record({
            provider: WEBHOOK_PROVIDER.OGATEWAY,
            req,
            payload: req.body,
            signature,
            signatureValid,
            event: eventName,
            externalId,
        });
        const eventId = stored?._id?.toString();

        if (!signature) {
            logger.warn("OGateway webhook: missing signature header");
            if (eventId) await webhookEventService.markFailed(eventId, 'missing signature');
            res.status(400).json({ error: "Missing signature" });
            return;
        }
        if (!signatureValid) {
            logger.error("OGateway webhook: invalid signature");
            if (eventId) await webhookEventService.markFailed(eventId, 'invalid signature');
            res.status(401).json({ error: "Invalid signature" });
            return;
        }

        logger.info("OGateway webhook received", { event: eventName, reference: externalId });
        res.status(200).json({ received: true });

        try {
            await this.transactionService.handleOGatewayWebhook(req.body);
            if (eventId) await webhookEventService.markProcessed(eventId);
        } catch (error: any) {
            logger.error("OGateway webhook processing error", { error: error?.message || error });
            if (eventId) await webhookEventService.markFailed(eventId, error);
        }
    }

    private async yellowCardCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
        const rawBody = (req as any).rawBody || JSON.stringify(req.body);
        const signature = (req.headers["x-yc-signature"] as string) || (req.headers["x-yellowcard-signature"] as string) || undefined;
        const event: string | undefined = req.body?.event;
        const externalId = req.body?.data?.sequenceId || req.body?.data?.id;

        const signatureValid = !!signature && yellowCardService.verifyWebhookSignature(rawBody, signature);

        const stored = await webhookEventService.record({
            provider: WEBHOOK_PROVIDER.YELLOWCARD,
            req,
            payload: req.body,
            signature,
            signatureValid,
            event,
            externalId,
        });
        const eventId = stored?._id?.toString();

        if (!signature) {
            logger.warn("YellowCard webhook: missing signature header");
            if (eventId) await webhookEventService.markFailed(eventId, 'missing signature');
            res.status(400).json({ error: "Missing signature" });
            return;
        }
        if (!signatureValid) {
            logger.error("YellowCard webhook: invalid signature");
            if (eventId) await webhookEventService.markFailed(eventId, 'invalid signature');
            res.status(401).json({ error: "Invalid signature" });
            return;
        }

        logger.info("YellowCard webhook received", { event, sequenceId: externalId });
        res.status(200).json({ received: true });

        try {
            await this.transactionService.handleYellowCardWebhook(req.body);
            if (eventId) await webhookEventService.markProcessed(eventId);
        } catch (error: any) {
            logger.error("YellowCard webhook processing error", { error: error?.message || error });
            if (eventId) await webhookEventService.markFailed(eventId, error);
        }
    }
    /**
     * Paystack webhook handler for wallet funding and withdrawal events.
     * Verifies HMAC SHA512 signature and processes:
     * - charge.success → wallet funding
     * - transfer.success → withdrawal completed
     * - transfer.failed / transfer.reversed → withdrawal failed, reverse balance
     */
    private async paystackCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
        const rawBody = (req as any).rawBody || JSON.stringify(req.body);
        const signature = req.headers["x-paystack-signature"] as string | undefined;
        const event: string | undefined = req.body?.event;
        const data = req.body?.data;
        const externalId = data?.reference || data?.id?.toString();

        // Verify signature first. We still record the event row so that
        // tampered/missing-signature attempts are visible to admins.
        const signatureValid = !!signature && paystackService.verifyWebhookSignature(rawBody, signature);

        const stored = await webhookEventService.record({
            provider: WEBHOOK_PROVIDER.PAYSTACK,
            req,
            payload: req.body,
            signature,
            signatureValid,
            event,
            externalId,
        });
        const eventId = stored?._id?.toString();

        if (!signature) {
            logger.warn("Paystack webhook: missing signature header");
            if (eventId) await webhookEventService.markFailed(eventId, 'missing signature');
            res.status(400).json({ error: "Missing signature" });
            return;
        }

        if (!signatureValid) {
            logger.error("Paystack webhook: invalid signature");
            if (eventId) await webhookEventService.markFailed(eventId, 'invalid signature');
            res.status(401).json({ error: "Invalid signature" });
            return;
        }

        // Respond 200 immediately to avoid timeouts. Processing continues async.
        res.status(200).json({ received: true });
        logger.info("Paystack webhook received", { event, reference: data?.reference });

        try {
            switch (event) {
                case "charge.success":
                    await this.walletService.processFunding(
                        data.reference,
                        data.amount,
                        data
                    );
                    break;
                case "transfer.success":
                    await this.walletService.processWithdrawalSuccess(
                        data.transfer_code,
                        data.reference
                    );
                    break;
                case "transfer.failed":
                case "transfer.reversed":
                    await this.walletService.processWithdrawalFailure(
                        data.transfer_code,
                        data.reference,
                        data.reason || `Transfer ${event.split('.')[1]}`
                    );
                    break;
                default:
                    logger.info("Paystack webhook: unhandled event", { event });
                    if (eventId) await webhookEventService.markIgnored(eventId, `unhandled event: ${event}`);
                    return;
            }
            if (eventId) await webhookEventService.markProcessed(eventId);
        } catch (error: any) {
            logger.error("Paystack webhook processing error", { error: error?.message || error });
            if (eventId) await webhookEventService.markFailed(eventId, error);
        }
    }
}

export default new WebhookController().router;