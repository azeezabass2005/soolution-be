import { Request, Response, NextFunction } from "express";
import VerificationService from "../../../services/verification.service";
import BaseController from "../base-controller";
import errorResponseMessage from "../../../common/messages/error-response-message";
import SmileId from "../../../services/smile-id.service";
import { IUser } from "../../../models/interface";
import NotificationService from "../../../utils/notification.utils";
import config from "../../../config/env.config";

class VerificationController extends BaseController {

    verificationService: VerificationService;
    smileIdService: SmileId;
    notificationService: NotificationService;

    constructor () {
        super();
        this.verificationService = new VerificationService();
        this.smileIdService = new SmileId();
        this.notificationService = new NotificationService();
        this.setupRoutes();
    }


    protected setupRoutes(): void {
        // Endpoint to submit a kyc verification request
        this.router.post("/", this.verifyUser.bind(this));
 
        // Endpoint to get web token for web integrations (biometric/enhanced KYC)
        this.router.get("/web-token", this.getVerificationToken.bind(this));
        
        // Endpoint to cancel pending verification (useful for testing)
        this.router.delete("/cancel", this.cancelPendingVerification.bind(this));
    }

    private async getVerificationToken(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = res.locals.user;
            const result = await this.smileIdService.getWebToken(user);
            return this.sendSuccess(res,  {
                message: "Verification token created successfully",
                result
            })
        } catch (error) {
            next(error)
        }
    }

    private async verifyUser(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = res.locals.user;

            if(user?.isVerified) {
                return next(errorResponseMessage.resourceAlreadyExist('You are already verified', true));
            }

            const {
                bvn,
                ghanaCardNumber,
                images,
            } = req.body;

            // TODO: I will move the two validations below to the zod and use it as middleware here
            if(user?.country === "NG" && !bvn) {
                return next(errorResponseMessage.payloadIncorrect("bvn"))
            }

            if(user?.country === "GH" && !ghanaCardNumber) {
                return next(errorResponseMessage.payloadIncorrect("ghanaCardNumber"))
            }

            if(!images || images.length < 1) {
                return next(errorResponseMessage.payloadIncorrect("images"));
            }
            
            // Check for existing pending verification
            const existingPendingVerification = await this.verificationService.findOne({ user: user._id, status: 'pending' });
            
            if (existingPendingVerification) {
                // Check if the pending verification is stale (older than 24 hours)
                // This allows users to retry if a verification got stuck or they want to test again
                const createdAt = (existingPendingVerification as any).createdAt;
                const verificationAge = createdAt 
                    ? Date.now() - new Date(createdAt).getTime()
                    : Infinity; // If no createdAt, treat as very old to allow retry
                const STALE_VERIFICATION_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
                
                if (verificationAge > STALE_VERIFICATION_THRESHOLD) {
                    // Mark the old verification as failed/expired
                    console.log(`⚠️ [INFO] Expiring stale pending verification for user ${user._id} (age: ${Math.round(verificationAge / (60 * 60 * 1000))} hours)`);
                    await this.verificationService.updateById(existingPendingVerification.id!.toString(), {
                        status: 'failed',
                        reason: 'Verification expired - please try again'
                    });
                } else {
                    // Verification is still fresh, don't allow a new one
                    return next(errorResponseMessage.resourceAlreadyExist('Ongoing verification Already Exists'))
                }
            }
            // Validate image format and size before processing
            if (!Array.isArray(images)) {
                return next(errorResponseMessage.payloadIncorrect("Images must be an array"));
            }

            // Validate each image
            for (let i = 0; i < images.length; i++) {
                const img = images[i];
                if (!img || typeof img !== 'object') {
                    return next(errorResponseMessage.payloadIncorrect(`Image at index ${i} is invalid`));
                }
                if (!img.image || typeof img.image !== 'string') {
                    return next(errorResponseMessage.payloadIncorrect(`Image at index ${i} is missing image data`));
                }
                if (!img.image_type_id || typeof img.image_type_id !== 'number') {
                    return next(errorResponseMessage.payloadIncorrect(`Image at index ${i} is missing image_type_id`));
                }
                
                // Check if image is base64 and validate size (max 5MB per image when base64 encoded)
                // Base64 encoding increases size by ~33%, so 5MB raw ≈ 6.7MB base64
                const base64Size = img.image.length;
                const maxBase64Size = 7 * 1024 * 1024; // 7MB in characters
                
                if (base64Size > maxBase64Size) {
                    console.error(`❌ [ERROR] Image at index ${i} is too large: ${(base64Size / 1024 / 1024).toFixed(2)}MB (max: 7MB)`);
                    return next(errorResponseMessage.payloadIncorrect(`Image at index ${i} is too large. Maximum size is 5MB per image.`));
                }
            }

            const verification = await this.verificationService.create({
                user: user._id,
                status: 'pending',
            })
            
            let verificationSubmissionRes: any;
            try {
                if(user?.country === 'GH') {
                    verificationSubmissionRes = await this.smileIdService.verifyGhanaCardWithSelfie(user! as IUser, ghanaCardNumber, images);
                } else {
                    verificationSubmissionRes = await this.smileIdService.verifyBvnWithSelfie(user! as IUser, bvn, images);
                }
            } catch (error: any) {
                console.error('❌ [ERROR] Smile ID API call failed');
                console.error('❌ [ERROR] Error Message:', error?.message || 'Unknown error');
                console.error('❌ [ERROR] Error Status Code:', error?.statusCode || error?.response?.status || 'N/A');
                
                // Safely extract error response data
                let errorResponseData = null;
                if (error?.responseData) {
                    try {
                        errorResponseData = typeof error.responseData === 'string' 
                            ? error.responseData 
                            : JSON.stringify(error.responseData);
                    } catch (e) {
                        errorResponseData = String(error.responseData);
                    }
                } else if (error?.response?.data) {
                    try {
                        errorResponseData = typeof error.response.data === 'string' 
                            ? error.response.data 
                            : JSON.stringify(error.response.data);
                    } catch (e) {
                        errorResponseData = String(error.response.data);
                    }
                }
                
                if (errorResponseData) {
                    console.error('❌ [ERROR] Smile ID API Error Response:', errorResponseData);
                }
                
                // Clean up the pending verification since submission failed
                await this.verificationService.updateById(verification.id, {
                    status: 'failed',
                    reason: error?.message || 'Failed to submit verification to Smile ID'
                });

                // Extract a user-friendly error message
                let errorMessage = 'Failed to submit verification data to Smile ID';
                
                if (error?.responseData) {
                    // Try to extract message from response data
                    if (typeof error.responseData === 'object') {
                        errorMessage = error.responseData.message 
                            || error.responseData.error 
                            || error.responseData.detail 
                            || errorMessage;
                    } else if (typeof error.responseData === 'string') {
                        errorMessage = error.responseData;
                    }
                } else if (error?.message && !error.message.includes('circular')) {
                    errorMessage = error.message;
                }
                
                // Add status code context if available
                if (error?.statusCode || error?.response?.status) {
                    const statusCode = error?.statusCode || error?.response?.status;
                    if (statusCode === 400) {
                        errorMessage = `Invalid request to Smile ID: ${errorMessage}`;
                    } else if (statusCode === 401) {
                        errorMessage = `Authentication failed with Smile ID: ${errorMessage}`;
                    } else if (statusCode === 403) {
                        errorMessage = `Access denied by Smile ID: ${errorMessage}`;
                    } else if (statusCode >= 500) {
                        errorMessage = `Smile ID service error: ${errorMessage}`;
                    }
                }
                
                return next(errorResponseMessage.unableToComplete(errorMessage));
            }

            if(!verificationSubmissionRes?.success) {
                // Clean up the pending verification since submission failed
                await this.verificationService.updateById(verification.id, {
                    status: 'failed',
                    reason: 'Smile ID API returned unsuccessful response'
                });
                
                return next(errorResponseMessage.unableToComplete("Failed to submit verification data to Smile ID"));
            }
            const updatedVerification = await this.verificationService.updateById(verification.id, {
                jobId: verificationSubmissionRes?.smile_job_id! as string,
            });

            // Send KYC verification initiated email
            try {
                await this.notificationService.emailService.sendNotificationEmail(
                    user.email,
                    {
                        title: '📋 KYC Verification Initiated',
                        message: `Hello ${user.firstName}, your KYC verification has been successfully submitted. We're processing your verification and will notify you once it's completed.`,
                        appName: 'Solution Pay',
                        actionUrl: `${config.FRONTEND_URL}/dashboard/user/profile`,
                        buttonText: 'View Profile'
                    }
                );
            } catch (error) {
                console.error('Failed to send KYC verification initiated email:', error);
                // Don't fail verification submission if email fails
            }

            return this.sendSuccess(res, {
                    message: "Verification data submitted successfully, check profile page to confirm completion",
                    verification: { ...updatedVerification }
                })
        } catch (error) {
            next(error);
        }
    }

    /**
     * Cancels a pending verification for the current user
     * Useful for testing when a verification gets stuck in pending state
     */
    private async cancelPendingVerification(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = res.locals.user;

            const pendingVerification = await this.verificationService.findOne({ 
                user: user._id, 
                status: 'pending' 
            });

            if (!pendingVerification) {
                return next(errorResponseMessage.resourceNotFound('No pending verification found'));
            }

            // Mark the verification as failed with cancellation reason
            await this.verificationService.updateById(pendingVerification.id!.toString(), {
                status: 'failed',
                reason: 'Verification cancelled by user'
            });

            return this.sendSuccess(res, {
                message: "Pending verification cancelled successfully. You can now submit a new verification.",
            });
        } catch (error) {
            next(error);
        }
    }
}

export default new VerificationController().router;