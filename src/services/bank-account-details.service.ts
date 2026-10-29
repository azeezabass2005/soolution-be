import DBService from "../utils/db.utils";
import {IBankAccountDetails} from "../models/interface";
import BankAccount from "../models/bank-account-details.model";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import mongoose from "mongoose";
import { ZUserBankAccount } from "../validators/z-bank-account-details";

/**
 * Two kinds of account live here and must never mix:
 *  - company accounts (user: null): where customers pay us for manual transfers;
 *    the default one per currency is shown to every customer
 *  - users' own saved accounts (user set): only ever seen and used by that user
 */
const COMPANY = { user: null } as const;

const parseUserAccount = (body: unknown) => {
    const parsed = ZUserBankAccount.safeParse(body ?? {});
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
        throw errorResponseMessage.createError(400, issues[0].message, ErrorSeverity.LOW, { issues });
    }
    return parsed.data;
};

class BankAccountDetailsService extends DBService<IBankAccountDetails> {
    constructor() {
        super(BankAccount, []);
    }

    public getAccountDetails = async (): Promise<{ NGN: IBankAccountDetails[], GHS: IBankAccountDetails[], KES: IBankAccountDetails[], XAF: IBankAccountDetails[] }> => {
        const accountDetails = await this.find(COMPANY as any);
        const ngnAccounts: IBankAccountDetails[] = [];
        const ghsAccounts: IBankAccountDetails[] = [];
        const kesAccounts: IBankAccountDetails[] = [];
        const xafAccounts: IBankAccountDetails[] = [];
        
        accountDetails?.forEach((account) => {
            const accountObj = account.toObject();
            if (account.currency === 'NGN') {
                ngnAccounts.push(accountObj);
            } else if (account.currency === 'GHS') {
                ghsAccounts.push(accountObj);
            } else if (account.currency === 'KES') {
                kesAccounts.push(accountObj);
            } else if (account.currency === 'XAF') {
                xafAccounts.push(accountObj);
            }
        });
        
        return { 
            NGN: ngnAccounts, 
            GHS: ghsAccounts, 
            KES: kesAccounts, 
            XAF: xafAccounts 
        };
    }

    public createAccountDetails = async (data: Partial<IBankAccountDetails>) => {
        const currencyAccountDetailsCount = await this.count({ ...COMPANY, currency: data.currency! } as any);
        return await this.create({
            ...data,
            user: null as any,
            isDefault: currencyAccountDetailsCount === 0,
        })
    }

    public updateAccountDetails = async (id: string, updateData: Partial<IBankAccountDetails>) => {
        if(Object.keys(updateData).includes("isDefault")) {
            throw errorResponseMessage.unableToComplete("You can't update the isDefault value through here.")
        }
        const accountDetails = await this.findOne({ _id: id, ...COMPANY } as any);
        if(!accountDetails) {
            throw errorResponseMessage.resourceNotFound("Account Details")
        }
        const { user: _ignored, ...safeUpdate } = updateData as any;
        return await this.updateById(id, safeUpdate);
    }

    public makeDefaultAccountDetails = async (id: string) => {
        const accountDetails = await this.findOne({ _id: id, ...COMPANY } as any);
        if(!accountDetails) {
            throw errorResponseMessage.resourceNotFound("Account Details")
        }
        if(accountDetails.isDefault) {
            throw errorResponseMessage.resourceAlreadyExist("Account Details is already default", true);
        }
        const currentDefault = await this.findOne({ ...COMPANY, currency: accountDetails.currency, isDefault: true } as any);
        const session = await mongoose.startSession();
        if(currentDefault) {
            await this.updateById(currentDefault.id, { isDefault: false }, session);
        }
        const updatedDetails = await this.updateById(accountDetails.id, { isDefault: true }, session);
        session.endSession().then(() => {
            return updatedDetails;
        })
    }

    public deleteAccountDetails = async (id: string) => {
        const accountDetails = await this.findOne({ _id: id, ...COMPANY } as any);
        if(!accountDetails) {
            throw errorResponseMessage.resourceNotFound("Account Details")
        }
        const currencyAccountDetailsCount = await this.count({ ...COMPANY, currency: accountDetails.currency } as any);
        if(currencyAccountDetailsCount <= 1) {
            throw errorResponseMessage.unableToComplete(`You can't delete the only account details for ${accountDetails.currency}`);
        }
        return await this.deleteById(id);
    }

    public getAccountDetailsForCurrency = async (currency: string) => {
        const accountDetails = await this.find({ ...COMPANY, currency: currency } as any);
        if(!accountDetails) {
            throw errorResponseMessage.resourceNotFound("Account Details");
        }
        return accountDetails;
    }

    // User-specific methods (accounts linked to a particular user)

    public getUserAccountDetails = async (userId: string) => {
        return await this.find({ user: userId });
    }

    /** The company account customers pay into for this currency (never a user's saved account) */
    public getCompanyDefault = async (currency: string) => {
        return await this.findOne({ ...COMPANY, isDefault: true, currency } as any);
    }

    /** Only the allowed fields are kept; a user's account is never a company default */
    public createUserAccountDetails = async (userId: string, data: unknown) => {
        const fields = parseUserAccount(data);
        const duplicate = await this.findOne({ user: userId, currency: fields.currency, accountNumber: fields.accountNumber, ...(fields.bankCode ? { bankCode: fields.bankCode } : { bankName: fields.bankName }) } as any);
        if (duplicate) return duplicate;
        return await this.create({ ...fields, user: userId, isDefault: false } as any);
    }

    public updateUserAccountDetails = async (userId: string, id: string, updateData: unknown) => {
        const account = await this.findOne({ _id: id, user: userId } as any);
        if (!account) throw errorResponseMessage.resourceNotFound("Account");
        const fields = parseUserAccount(updateData);
        return await this.updateById(id, { ...fields, isDefault: false } as any);
    }

    public deleteUserAccountDetails = async (userId: string, id: string) => {
        const account = await this.findOne({ _id: id, user: userId } as any);
        if (!account) throw errorResponseMessage.resourceNotFound("Account");
        return await this.deleteById(id);
    }
}

export default BankAccountDetailsService;