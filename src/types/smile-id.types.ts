export interface SmileIdentityResponse {
    Actions: {
        Liveness_Check: string;
        Register_Selfie: string;
        Selfie_Provided: string;
        Verify_ID_Number: string;
        Human_Review_Compare: string;
        Return_Personal_Info: string;
        Selfie_To_ID_Card_Compare: string;
        Human_Review_Update_Selfie: string;
        Human_Review_Liveness_Check: string;
        Selfie_To_ID_Authority_Compare: string;
        Update_Registered_Selfie_On_File: string;
        Selfie_To_Registered_Selfie_Compare: string;
    };

    ConfidenceValue: string;

    PartnerParams: {
        job_id: string;
        job_type: string;
        user_id: string;
    };

    ResultCode: string;
    ResultText: string;
    SmileJobID: string;
    Source: string;
    timestamp: string;
    signature: string;
}