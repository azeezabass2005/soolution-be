import { IVerification } from "../models/interface";
import Verification from "../models/verification.model";
import DBService from "../utils/db.utils";

class VerificationService extends DBService<IVerification> {
    constructor (populatedFields: string[] = []) {
        super(Verification, populatedFields);
    }
}

export default VerificationService;