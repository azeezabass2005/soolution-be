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

class WebhookController extends BaseController {

    verificationService: VerificationService;
    transactionService: TransactionService;
    notificationService: NotificationService;
    userService: UserService;
    smileIdService: SmileId;

    constructor () {
        super();
        this.verificationService = new VerificationService();
        this.transactionService = new TransactionService();
        this.notificationService = new NotificationService();
        this.userService = new UserService();
        this.smileIdService = new SmileId();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.post("/smile-id-callback", this.smileIdCallback.bind(this));
    }

    private async smileIdCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const webhookData = req.body;
            
            // SECURITY: Verify webhook signature to ensure it's from Smile ID
            const signature = webhookData.signature;
            const timestamp = webhookData.timestamp;
            
            if (!signature || !timestamp) {
                console.error("❌ [SECURITY] Missing signature or timestamp in webhook payload");
                res.status(400).json({ error: "Invalid webhook payload - missing signature or timestamp" });
                return;
            }
            
            const isValidSignature = this.smileIdService.verifySignature(signature, timestamp);
            if (!isValidSignature) {
                console.error("❌ [SECURITY] Invalid webhook signature - potential security threat");
                console.error("   Signature:", signature);
                console.error("   Timestamp:", timestamp);
                res.status(401).json({ error: "Invalid webhook signature" });
                return;
            }
            
            console.log("✅ [SECURITY] Webhook signature verified successfully");
            
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
            // 0000: Complete verification success (final)
            // 0810: Enroll User (successful enrollment with all checks passed - final result)
            // 1012: ID Number Validated (ID verification successful - intermediate result, wait for final)
            const finalSuccessCodes = ["0000", "0810"];
            const intermediateSuccessCodes = ["1012"];
            const isFinalSuccessCode = finalSuccessCodes.includes(resultCode);
            const isIntermediateSuccessCode = intermediateSuccessCodes.includes(resultCode);
            const isFailedCode = resultCode.startsWith("09"); // Failure codes start with 09
            
            // Determine if this is a final result
            // 0810 and 0000 are always final, 1012 is always intermediate (regardless of IsFinalResult flag)
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
                // For final results, check that critical actions passed
                const criticalActionsPassed = 
                    (idVerificationStatus === "Verified" || idVerificationStatus === "Passed") &&
                    (selfieCheckStatus === "Passed" || selfieCheckStatus === "Verified") &&
                    (registerSelfieStatus === "Passed" || registerSelfieStatus === "Verified");
                
                isVerified = criticalActionsPassed;
            }
            
            console.log("=== Smile ID Verification Result ===");
            console.log(`Status: ${isVerified ? 'VERIFIED' : 'FAILED'}`);
            console.log(`Result Code: ${resultCode}`);
            console.log(`Result Text: ${resultText}`);
            console.log(`Is Final Result: ${isThisFinalResult}`);
            console.log(`Confidence: ${confidenceValue}`);
            console.log(`Job ID: ${smileJobID}`);
            console.log("\n=== Detailed Actions ===");
            console.log(`ID Number Verification: ${idVerificationStatus}`);
            console.log(`Selfie Check: ${selfieCheckStatus}`);
            console.log(`Register Selfie: ${registerSelfieStatus}`);
            console.log(`Personal Info: ${personalInfoStatus}`);
            
            // Get the reason for failure (with safe access)
            const failureReason = (actions?.Selfie_Check && typeof actions.Selfie_Check === 'object' && actions.Selfie_Check.ResultText) 
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
            
        } catch (error) {
            console.error("Error processing Smile ID webhook:", error);
            // Still return 200 to prevent retries
            res.status(200).json({ received: true, error: "Processing failed" });
        }
    }
    
    private getFailureReason(resultCode: string, actions: any): string {
        // Map result codes to user-friendly reasons
        const reasonMap: Record<string, string> = {
            "0000": "Verification successful",
            "0810": "Enroll User - Verification successful",
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
}

export default new WebhookController().router;