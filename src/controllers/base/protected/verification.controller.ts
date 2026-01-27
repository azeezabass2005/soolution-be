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
        
    }

    private async getVerificationToken(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = res.locals.user;
            const result = this.smileIdService.getWebToken(user);
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
            const existingPendingVerification = await this.verificationService.findOne({ user: user._id, status: 'pending' });
            
            if (existingPendingVerification) {
                return next(errorResponseMessage.resourceAlreadyExist('Ongoing verification'))
            }
            const verification = await this.verificationService.create({
                user: user._id,
                status: 'pending',
            })
            let verificationSubmissionRes: any;
            if(user?.country === 'GH') {
                verificationSubmissionRes = await this.smileIdService.verifyGhanaCardWithSelfie(user! as IUser, ghanaCardNumber, images);
            } else {
                verificationSubmissionRes = await this.smileIdService.verifyBvnWithSelfie(user! as IUser, bvn, images);
            }
            // verificationSubmissionRes = await this.smileIdService.verifyBvnWithSelfie(user! as IUser, bvn, images);

            if(!verificationSubmissionRes?.success) {
                return next(errorResponseMessage?.unableToComplete("Failed to submit verification data"));
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
}

export default new VerificationController().router;