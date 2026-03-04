import DBService from "../utils/db.utils";
import {IBankAccountDetails} from "../models/interface";
import BankAccount from "../models/bank-account-details.model";
import errorResponseMessage from "../common/messages/error-response-message";
import mongoose from "mongoose";

class BankAccountDetailsService extends DBService<IBankAccountDetails> {
    constructor() {
        super(BankAccount, []);
    }

    public getAccountDetails = async (): Promise<{ NGN: IBankAccountDetails[], GHS: IBankAccountDetails[], KES: IBankAccountDetails[], XAF: IBankAccountDetails[] }> => {
        const accountDetails = await this.find();
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
        const currencyAccountDetailsCount = await this.count({ currency: data.currency! });
        return await this.create({
            ...data,
            isDefault: currencyAccountDetailsCount === 0,
        })
    }

    public updateAccountDetails = async (id: string, updateData: Partial<IBankAccountDetails>) => {
        if(Object.keys(updateData).includes("isDefault")) {
            throw errorResponseMessage.unableToComplete("You can't update the isDefault value through here.")
        }
        const accountDetails = await this.findById(id);
        if(!accountDetails) {
            throw errorResponseMessage.resourceNotFound("Account Details")
        }
        return await this.updateById(id, updateData);
    }

    public makeDefaultAccountDetails = async (id: string) => {
        const accountDetails = await this.findById(id);
        if(!accountDetails) {
            throw errorResponseMessage.resourceNotFound("Account Details")
        }
        if(accountDetails.isDefault) {
            throw errorResponseMessage.resourceAlreadyExist("Account Details is already default", true);
        }
        const currentDefault = await this.findOne({ currency: accountDetails.currency, isDefault: true });
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
        const accountDetails = await this.findById(id);
        if(!accountDetails) {
            throw errorResponseMessage.resourceNotFound("Account Details")
        }
        const currencyAccountDetailsCount = await this.count({ currency: accountDetails.currency });
        if(currencyAccountDetailsCount <= 1) {
            throw errorResponseMessage.unableToComplete(`You can't delete the only account details for ${accountDetails.currency}`);
        }
        return await this.deleteById(id);
    }

    public getAccountDetailsForCurrency = async (currency: string) => {
        const accountDetails = await this.find({ currency: currency });
        if(!accountDetails) {
            throw errorResponseMessage.resourceNotFound("Account Details");
        }
        return accountDetails;
    }

    // User-specific methods (accounts linked to a particular user)

    public getUserAccountDetails = async (userId: string) => {
        return await this.find({ user: userId });
    }

    public createUserAccountDetails = async (userId: string, data: Partial<IBankAccountDetails>) => {
        return await this.create({ ...data, user: userId });
    }

    public updateUserAccountDetails = async (userId: string, id: string, updateData: Partial<IBankAccountDetails>) => {
        const account = await this.findOne({ _id: id, user: userId } as any);
        if (!account) throw errorResponseMessage.resourceNotFound("Account");
        return await this.updateById(id, updateData);
    }

    public deleteUserAccountDetails = async (userId: string, id: string) => {
        const account = await this.findOne({ _id: id, user: userId } as any);
        if (!account) throw errorResponseMessage.resourceNotFound("Account");
        return await this.deleteById(id);
    }
}

export default BankAccountDetailsService;