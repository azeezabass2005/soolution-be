import { WebApi, Signature } from "smile-identity-core";
import config from "../config/env.config";
import { IUser } from "../models/interface";
import { randomUUID } from "crypto"

class SmileId {
    connection;
    signatureConnection;

    constructor () {
        this.connection = new WebApi(config.SMILE_ID_PARTNER_ID, config.SMILE_ID_CALLBACK_URL, config.SMILE_ID_API_KEY, config.SMILE_ID_SID_SERVER)
        this.signatureConnection = new Signature(config.SMILE_ID_PARTNER_ID, config.SMILE_ID_API_KEY);
    }

    private generateSignature = (): { signature: string; timestamp: string | number; } => {
        return this.signatureConnection.generate_signature(Date.now());
    }

    public verifySignature = (signature: string, timestamp: string): boolean => {
        return this.signatureConnection.confirm_signature(signature, timestamp);
    }

    public verifyBvnWithSelfie = async (user: IUser, bvn: string, images: { image: string; image_type_id: number; }[]) => {
        console.log("\n==========================================");
        console.log("🚀 VERIFY BVN WITH SELFIE - START");
        console.log("==========================================\n");

        // Log function entry with parameters
        console.log("📋 [LOG] Function called: verifyBvnWithSelfie");
        console.log("📋 [LOG] Timestamp:", new Date().toISOString());
        console.log("📋 [LOG] User ID:", user._id?.toString());
        console.log("📋 [LOG] User Email:", user.email);
        console.log("📋 [LOG] User Name:", `${user.firstName} ${user.lastName}`);
        console.log("📋 [LOG] BVN:", bvn);
        console.log("📋 [LOG] Number of images provided:", images?.length || 0);

        // Validate inputs
        if (!user) {
            console.error("❌ [ERROR] User object is missing");
            throw new Error("User object is required for BVN verification");
        }

        if (!bvn) {
            console.error("❌ [ERROR] BVN is missing");
            throw new Error("BVN is required for verification");
        }

        if (!images || images.length === 0) {
            console.error("❌ [ERROR] No images provided");
            throw new Error("At least one image is required for BVN verification");
        }

        // Log image details
        console.log("\n📸 [LOG] Image Details:");
        images.forEach((img, index) => {
            console.log(`  Image ${index + 1}:`);
            console.log(`    - Image Type ID: ${img.image_type_id}`);
            console.log(`    - Image Length: ${img.image?.length || 0} characters`);
            console.log(`    - Image Size: ${((img.image?.length || 0) / 1024 / 1024).toFixed(2)}MB (base64)`);
            console.log(`    - Image Preview: ${img.image?.substring(0, 50)}...`);
        });

        // Generate job ID
        let job_id = randomUUID();
        console.log("\n🆔 [LOG] Generated Job ID:", job_id);

        // Prepare partner parameters
        let partner_params = {
            job_id: job_id,
            user_id: user._id as string,
            job_type: 1 // Job type 1 = Basic KYC
        };

        console.log("\n📦 [LOG] Partner Parameters:");
        console.log(JSON.stringify(partner_params, null, 2));

        // Prepare ID information for BVN
        let id_info = {
            first_name: user.firstName,
            last_name: user.lastName,
            country: 'NG',
            id_type: 'BVN',
            id_number: bvn,
            entered: 'true'
        };

        console.log("\n🪪 [LOG] ID Information:");
        console.log(JSON.stringify(id_info, null, 2));

        // Prepare options
        let options = {
            return_job_status: true,
            return_history: true,
            return_image_links: true,
            signature: true
        };

        console.log("\n⚙️  [LOG] Request Options:");
        console.log(JSON.stringify(options, null, 2));

        // Log before API call
        console.log("\n📡 [LOG] Preparing to submit job to Smile ID API...");
        console.log("📡 [LOG] API Endpoint: Smile ID WebApi.submit_job");
        console.log("📡 [LOG] Partner ID:", config.SMILE_ID_PARTNER_ID);
        console.log("📡 [LOG] Callback URL:", config.SMILE_ID_CALLBACK_URL);
        console.log("📡 [LOG] Server:", config.SMILE_ID_SID_SERVER);

        try {
            // Submit job to Smile ID
            console.log("\n⏳ [LOG] Submitting job to Smile ID...");
            const startTime = Date.now();

            const response: any = await this.connection.submit_job(partner_params, images, id_info, options);

            const endTime = Date.now();
            const duration = endTime - startTime;

            console.log("\n✅ [LOG] API Call Completed");
            console.log("⏱️  [LOG] Request Duration:", `${duration}ms`);

            // Log response
            console.log("\n📥 [LOG] Smile ID API Response:");
            if (response?.result) {
                console.log("  ✅ Result object exists");
                console.log("  📋 Result Code:", response.result.ResultCode || 'N/A');
                console.log("  📋 Result Text:", response.result.ResultText || 'N/A');
                console.log("  🆔 Smile Job ID:", response.result.SmileJobID || 'N/A');
            } else {
                console.warn("  ⚠️  No result object in response");
                console.log("  📋 Full Response:", JSON.stringify(response, null, 2));
            }

            // Determine success
            const success = !!response?.result;
            console.log("\n🎯 [LOG] Verification Submission Result:");
            console.log("  - Success:", success);
            console.log("  - Job ID:", job_id);

            const returnValue = {
                success: success,
                smile_job_id: job_id
            };

            console.log("\n==========================================");
            console.log("✅ VERIFY BVN WITH SELFIE - END");
            console.log("==========================================\n");

            return returnValue;

        } catch (error: any) {
            console.error("\n❌ [ERROR] Exception occurred during Smile ID API call");
            console.error("❌ [ERROR] Error Type:", error?.constructor?.name || 'Unknown');
            console.error("❌ [ERROR] Error Message:", error?.message || 'No error message');
            console.error("❌ [ERROR] Error Stack:", error?.stack || 'No stack trace');

            if (error?.response) {
                console.error("❌ [ERROR] API Error Response:");
                console.error(JSON.stringify(error.response, null, 2));
            }

            if (error?.request) {
                console.error("❌ [ERROR] Request Details:");
                console.error(JSON.stringify(error.request, null, 2));
            }

            console.error("\n==========================================");
            console.error("❌ VERIFY BVN WITH SELFIE - FAILED");
            console.error("==========================================\n");

            // Re-throw error to be handled by caller
            throw error;
        }
    }

    public verifyGhanaCardWithSelfie = async (user: IUser, ghanaCardNumber: string, images: { image: string, image_type_id: number; }[]) => {
        console.log("\n==========================================");
        console.log("🚀 VERIFY GHANA CARD WITH SELFIE - START");
        console.log("==========================================\n");

        // Log function entry with parameters
        console.log("📋 [LOG] Function called: verifyGhanaCardWithSelfie");
        console.log("📋 [LOG] Timestamp:", new Date().toISOString());
        console.log("📋 [LOG] User ID:", user._id?.toString());
        console.log("📋 [LOG] User Email:", user.email);
        console.log("📋 [LOG] User Name:", `${user.firstName} ${user.lastName}`);
        console.log("📋 [LOG] User Country:", user.countryOfOrigin || user.countryOfResidence || 'Not specified');
        console.log("📋 [LOG] Ghana Card Number:", ghanaCardNumber);
        console.log("📋 [LOG] Number of images provided:", images?.length || 0);

        // Validate inputs
        if (!user) {
            console.error("❌ [ERROR] User object is missing");
            throw new Error("User object is required for Ghana Card verification");
        }

        if (!ghanaCardNumber) {
            console.error("❌ [ERROR] Ghana Card number is missing");
            throw new Error("Ghana Card number is required for verification");
        }

        if (!images || images.length === 0) {
            console.error("❌ [ERROR] No images provided");
            throw new Error("At least one image is required for Ghana Card verification");
        }

        // Log image details
        console.log("\n📸 [LOG] Image Details:");
        images.forEach((img, index) => {
            console.log(`  Image ${index + 1}:`);
            console.log(`    - Image Type ID: ${img.image_type_id}`);
            console.log(`    - Image Length: ${img.image?.length || 0} characters`);
            console.log(`    - Image Preview: ${img.image?.substring(0, 50)}...`);
        });

        // Generate job ID
        let job_id = randomUUID();
        console.log("\n🆔 [LOG] Generated Job ID:", job_id);

        // Prepare partner parameters
        let partner_params = {
            job_id: job_id,
            user_id: user._id as string,
            job_type: 1 // Job type 1 = Basic KYC
        };

        console.log("\n📦 [LOG] Partner Parameters:");
        console.log(JSON.stringify(partner_params, null, 2));

        // Prepare ID information for Ghana Card
        let id_info = {
            first_name: user.firstName,
            last_name: user.lastName,
            country: 'GH', // Ghana country code
            id_type: 'GHANA_CARD', // Ghana Card ID type
            id_number: ghanaCardNumber, // Ghana Card number - required by SDK
            entered: 'true' // Indicates data was manually entered
        };

        console.log("\n🪪 [LOG] ID Information:");
        console.log(JSON.stringify(id_info, null, 2));
        console.log("ℹ️  [INFO] Ghana Card number provided:", ghanaCardNumber);

        // Prepare options
        let options = {
            return_job_status: true, // Get job result synchronously
            return_history: true, // Return results of all previous jobs for this user
            return_image_links: true, // Receive selfie and liveness images
            signature: true // Include signature in response
        };

        console.log("\n⚙️  [LOG] Request Options:");
        console.log(JSON.stringify(options, null, 2));
        console.log("ℹ️  [INFO] Signature will be automatically generated by Smile ID SDK");

        // Log before API call
        console.log("\n📡 [LOG] Preparing to submit job to Smile ID API...");
        console.log("📡 [LOG] API Endpoint: Smile ID WebApi.submit_job");
        console.log("📡 [LOG] Partner ID:", config.SMILE_ID_PARTNER_ID);
        console.log("📡 [LOG] Callback URL:", config.SMILE_ID_CALLBACK_URL);
        console.log("📡 [LOG] Server:", config.SMILE_ID_SID_SERVER);

        try {
            // Submit job to Smile ID
            console.log("\n⏳ [LOG] Submitting job to Smile ID...");
            const startTime = Date.now();

            const response: any = await this.connection.submit_job(
                partner_params,
                images,
                id_info,
                options
            );

            const endTime = Date.now();
            const duration = endTime - startTime;

            console.log("\n✅ [LOG] API Call Completed");
            console.log("⏱️  [LOG] Request Duration:", `${duration}ms`);

            // Log full response
            console.log("\n📥 [LOG] Full Smile ID API Response:");
            console.log(JSON.stringify(response, null, 2));

            // Parse and log response details
            if (response) {
                console.log("\n📊 [LOG] Response Analysis:");

                if (response.result) {
                    console.log("  ✅ Result object exists");
                    console.log("  📋 Result Code:", response.result.ResultCode || 'N/A');
                    console.log("  📋 Result Text:", response.result.ResultText || 'N/A');
                    console.log("  🆔 Smile Job ID:", response.result.SmileJobID || 'N/A');
                    console.log("  📈 Confidence Value:", response.result.ConfidenceValue || 'N/A');

                    if (response.result.Actions) {
                        console.log("\n  🔍 Detailed Actions:");
                        const actions = response.result.Actions;
                        Object.keys(actions).forEach(key => {
                            console.log(`    - ${key}: ${actions[key]}`);
                        });
                    }

                    if (response.result.PartnerParams) {
                        console.log("\n  👤 Partner Parameters (from response):");
                        console.log("    - Job ID:", response.result.PartnerParams.job_id);
                        console.log("    - User ID:", response.result.PartnerParams.user_id);
                        console.log("    - Job Type:", response.result.PartnerParams.job_type);
                    }
                } else {
                    console.log("  ⚠️  No result object in response");
                }

                if (response.code) {
                    console.log("  📋 Response Code:", response.code);
                }

                if (response.status) {
                    console.log("  📋 Response Status:", response.status);
                }

                if (response.error) {
                    console.error("  ❌ Error in response:", response.error);
                }
            } else {
                console.warn("  ⚠️  Response is null or undefined");
            }

            // Determine success
            const success = !!response?.result;
            console.log("\n🎯 [LOG] Verification Submission Result:");
            console.log("  - Success:", success);
            console.log("  - Job ID:", job_id);

            const returnValue = {
                success: success,
                smile_job_id: job_id
            };

            console.log("\n📤 [LOG] Return Value:");
            console.log(JSON.stringify(returnValue, null, 2));

            console.log("\n==========================================");
            console.log("✅ VERIFY GHANA CARD WITH SELFIE - END");
            console.log("==========================================\n");

            return returnValue;

        } catch (error: any) {
            console.error("\n❌ [ERROR] Exception occurred during Smile ID API call");
            console.error("❌ [ERROR] Error Type:", error?.constructor?.name || 'Unknown');
            console.error("❌ [ERROR] Error Message:", error?.message || 'No error message');
            console.error("❌ [ERROR] Error Stack:", error?.stack || 'No stack trace');

            if (error?.response) {
                console.error("❌ [ERROR] API Error Response:");
                console.error(JSON.stringify(error.response, null, 2));
            }

            if (error?.request) {
                console.error("❌ [ERROR] Request Details:");
                console.error(JSON.stringify(error.request, null, 2));
            }

            console.error("\n==========================================");
            console.error("❌ VERIFY GHANA CARD WITH SELFIE - FAILED");
            console.error("==========================================\n");

            // Re-throw error to be handled by caller
            throw error;
        }
    }

    public getWebToken = async (user: IUser) => {
        const request_params = {
            user_id: user?._id!.toString(),
            job_id: `job-${randomUUID()}`,
            product: 'biometric_kyc', // Choose one of 'authentication', 'basic_kyc', 'smartselfie', 'biometric_kyc', 'enhanced_kyc', 'doc_verification'
            callback_url: config.SMILE_ID_CALLBACK_URL
        };

        return await this.connection.get_web_token(
            request_params
        )
    }
}

export default SmileId;