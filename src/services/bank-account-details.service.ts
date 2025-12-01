import DBService from "../utils/db.utils";
import {IBankAccountDetails} from "../models/interface";
import BankAccount from "../models/bank-account-details.model";
import errorResponseMessage from "../common/messages/error-response-message";
import mongoose from "mongoose";

class BankAccountDetailsService extends DBService<IBankAccountDetails> {
    constructor() {
        super(BankAccount, []);
    }

    public getAccountDetails = async (): Promise<{ NGN: IBankAccountDetails[], GHS: IBankAccountDetails[] }> => {
        const accountDetails = await this.find();
        const ngnAccounts: IBankAccountDetails[] = [];
        const ghsAccounts: IBankAccountDetails[] = [];
        accountDetails?.map((account) => {
            if (account.currency === 'NGN') {
                ngnAccounts.push(account.toObject())
            } else if (account.currency === 'GHS') {
                ghsAccounts.push(account.toObject())
            }
        })
        return { NGN: ngnAccounts, GHS: ghsAccounts }
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
}

export default BankAccountDetailsService;