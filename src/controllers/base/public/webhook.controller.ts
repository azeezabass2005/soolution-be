import { Request, Response, NextFunction } from "express";
import BaseController from "../base-controller";
import VerificationService from "../../../services/verification.service";
import errorResponseMessage from "../../../common/messages/error-response-message";
import TransactionService from "../../../services/transaction.service";
import { TRANSACTION_STATUS } from "../../../common/constant";
import NotificationService from "../../../utils/notification.utils";
import config from "../../../config/env.config";

class WebhookController extends BaseController {

    verificationService: VerificationService;
    transactionService: TransactionService;
    notificationService: NotificationService;

    constructor () {
        super();
        this.verificationService = new VerificationService();
        this.transactionService = new TransactionService();
        this.notificationService = new NotificationService();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.post("/smile-id-callback", this.smileIdCallback.bind(this));
    }

    private async smileIdCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const webhookData = req.body;
            
            // Extract key verification details
            const resultCode = webhookData.ResultCode; // "0911"
            const resultText = webhookData.ResultText; // "Failed Enroll - images unusable"
            const confidenceValue = webhookData.ConfidenceValue; // "0"
            const smileJobID = webhookData.SmileJobID; // "1000000018"
            
            // Get detailed actions to understand what failed
            const actions = webhookData.Actions;
            const selfieCheckStatus = actions.Selfie_Check; // "Failed"
            const registerSelfieStatus = actions.Register_Selfie; // "Rejected"
            const idVerificationStatus = actions.Verify_ID_Number; // "Verified"
            const personalInfoStatus = actions.Return_Personal_Info; // "Not Returned"
            
            // Determine overall verification status
            const isVerified =
                process.env.FORCE_VERIFY === "true"
                    ? true
                    : resultCode === "0000";
            const isFailed = resultCode.startsWith("09"); // Failure codes start with 09
            
            console.log("=== Smile ID Verification Result ===");
            console.log(`Status: ${isVerified ? 'VERIFIED' : 'FAILED'}`);
            console.log(`Result Code: ${resultCode}`);
            console.log(`Result Text: ${resultText}`);
            console.log(`Confidence: ${confidenceValue}`);
            console.log(`Job ID: ${smileJobID}`);
            console.log("\n=== Detailed Actions ===");
            console.log(`ID Number Verification: ${idVerificationStatus}`);
            console.log(`Selfie Check: ${selfieCheckStatus}`);
            console.log(`Register Selfie: ${registerSelfieStatus}`);
            console.log(`Personal Info: ${personalInfoStatus}`);
            
            // Get the reason for failure
            const failureReason = actions?.Selfie_Check?.ResultText || this.getFailureReason(resultCode, actions);
;
            console.log(`\nFailure Reason: ${failureReason}`);
            
            // Access image links if needed
            const selfieImage = webhookData.ImageLinks?.selfie_image;
            const idPhotoImage = webhookData.ImageLinks?.id_photo_image;

            console.log(webhookData.PartnerParams, "This is the partner params")
            
            // Get partner params (your custom data)
            const userID = webhookData.PartnerParams?.user_id;
            const jobID = webhookData.PartnerParams?.job_id;

            console.log({ user: userID, status: 'pending' }, "This is the query used for finding");
            
            // TODO: Update your database with the verification result
            const pendingVerification = await this.verificationService.findOne({ user: userID, status: 'pending' });
            
            console.log(pendingVerification, "This is the pendingVerification gotten after findOne called");

            if(!pendingVerification) {
                throw errorResponseMessage.resourceNotFound('Pending verification');
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
            "0911": "Images unusable - Anti-spoof check failed or poor image quality",
            "0812": "ID number not found in database",
            "0813": "ID information mismatch",
            "0814": "Selfie does not match ID photo",
            "0815": "Multiple identities detected",
            "0816": "ID number validation failed",
        };
        
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