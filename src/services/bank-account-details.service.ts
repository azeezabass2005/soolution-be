import bankAccountRepository, { type BankAccountUpdate } from "../repositories/bank-account.repository";
import type { BankAccountDetails } from "../types/entities";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { withTransaction } from "../db/transaction";
import { ZUserBankAccount } from "../validators/z-bank-account-details";

/**
 * Two kinds of account live here and must never mix:
 *  - company accounts (user: null): where customers pay us for manual transfers;
 *    the default one per currency is shown to every customer
 *  - users' own saved accounts (user set): only ever seen and used by that user
 */
const COMPANY = null;

const parseUserAccount = (body: unknown) => {
    const parsed = ZUserBankAccount.safeParse(body ?? {});
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
        throw errorResponseMessage.createError(400, issues[0].message, ErrorSeverity.LOW, { issues });
    }
    return parsed.data;
};

/** Only the editable account fields (never the owner or default flag) */
const accountFields = (data: Record<string, unknown>): BankAccountUpdate => ({
    currency: typeof data.currency === "string" ? data.currency : undefined,
    accountNumber: typeof data.accountNumber === "string" ? data.accountNumber : undefined,
    accountName: typeof data.accountName === "string" ? data.accountName : undefined,
    bankName: typeof data.bankName === "string" ? data.bankName : undefined,
    bankCode: typeof data.bankCode === "string" ? data.bankCode : undefined,
});

class BankAccountDetailsService {
    public getAccountDetails = async (): Promise<{ NGN: BankAccountDetails[]; GHS: BankAccountDetails[]; KES: BankAccountDetails[]; XAF: BankAccountDetails[] }> => {
        const accountDetails = await bankAccountRepository.list(COMPANY);
        const grouped = { NGN: [] as BankAccountDetails[], GHS: [] as BankAccountDetails[], KES: [] as BankAccountDetails[], XAF: [] as BankAccountDetails[] };
        for (const account of accountDetails) {
            if (account.currency in grouped) grouped[account.currency as keyof typeof grouped].push(account);
        }
        return grouped;
    };

    public createAccountDetails = async (data: Record<string, unknown>) => {
        const fields = accountFields(data);
        if (!fields.currency || !fields.accountNumber || !fields.accountName || !fields.bankName) {
            throw errorResponseMessage.payloadIncorrect("currency, accountNumber, accountName and bankName are required");
        }
        const currencyAccountDetailsCount = await bankAccountRepository.count(COMPANY, fields.currency);
        return bankAccountRepository.create({
            currency: fields.currency,
            accountNumber: fields.accountNumber,
            accountName: fields.accountName,
            bankName: fields.bankName,
            bankCode: fields.bankCode,
            user: null,
            isDefault: currencyAccountDetailsCount === 0,
        });
    };

    public updateAccountDetails = async (id: string, updateData: Record<string, unknown>) => {
        if (Object.keys(updateData).includes("isDefault")) {
            throw errorResponseMessage.unableToComplete("You can't update the isDefault value through here.");
        }
        const accountDetails = await bankAccountRepository.findOwned(id, COMPANY);
        if (!accountDetails) {
            throw errorResponseMessage.resourceNotFound("Account Details");
        }
        return bankAccountRepository.update(id, accountFields(updateData));
    };

    /** Make this the company default for its currency (the old default is cleared in the same transaction) */
    public makeDefaultAccountDetails = async (id: string) => {
        const accountDetails = await bankAccountRepository.findOwned(id, COMPANY);
        if (!accountDetails) {
            throw errorResponseMessage.resourceNotFound("Account Details");
        }
        if (accountDetails.isDefault) {
            throw errorResponseMessage.resourceAlreadyExist("Account Details is already default", true);
        }
        return withTransaction(async (tx) => {
            await bankAccountRepository.clearCompanyDefault(accountDetails.currency, tx);
            return bankAccountRepository.update(accountDetails.id, { isDefault: true }, tx);
        });
    };

    public deleteAccountDetails = async (id: string) => {
        const accountDetails = await bankAccountRepository.findOwned(id, COMPANY);
        if (!accountDetails) {
            throw errorResponseMessage.resourceNotFound("Account Details");
        }
        const currencyAccountDetailsCount = await bankAccountRepository.count(COMPANY, accountDetails.currency);
        if (currencyAccountDetailsCount <= 1) {
            throw errorResponseMessage.unableToComplete(`You can't delete the only account details for ${accountDetails.currency}`);
        }
        return bankAccountRepository.delete(id);
    };

    public getAccountDetailsForCurrency = async (currency: string) => {
        return bankAccountRepository.list(COMPANY, { currency });
    };

    // User-specific methods (accounts linked to a particular user)

    public getUserAccountDetails = async (userId: string) => {
        return bankAccountRepository.list(userId);
    };

    /** The company account customers pay into for this currency (never a user's saved account) */
    public getCompanyDefault = async (currency: string) => {
        return bankAccountRepository.findCompanyDefault(currency);
    };

    /** Only the allowed fields are kept; a user's account is never a company default */
    public createUserAccountDetails = async (userId: string, data: unknown) => {
        const fields = parseUserAccount(data);
        const duplicate = await bankAccountRepository.findUserDuplicate(userId, fields);
        if (duplicate) return duplicate;
        return bankAccountRepository.create({ ...fields, user: userId, isDefault: false });
    };

    public updateUserAccountDetails = async (userId: string, id: string, updateData: unknown) => {
        const account = await bankAccountRepository.findOwned(id, userId);
        if (!account) throw errorResponseMessage.resourceNotFound("Account");
        const fields = parseUserAccount(updateData);
        return bankAccountRepository.update(id, { ...fields, isDefault: false });
    };

    public deleteUserAccountDetails = async (userId: string, id: string) => {
        const account = await bankAccountRepository.findOwned(id, userId);
        if (!account) throw errorResponseMessage.resourceNotFound("Account");
        return bankAccountRepository.delete(id);
    };
}

export default BankAccountDetailsService;
