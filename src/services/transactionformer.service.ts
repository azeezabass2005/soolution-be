/**
 * Service class for Order-related operations
 *
 * @description Extends the generic DBService with Order-specific operations
 * @extends {DBService<ITransaction>}
 */
import DBService from "../utils/db.utils";
import {ITransaction, ITransactionDetail, IUser} from "../models/interface";
import Transaction from "../models/transaction.model";
import TransactionDetailsService from "./transaction-details.service";
import {FileUploadFactory} from "./file-upload.factory";
import errorResponseMessage from "../common/messages/error-response-message";
import {DETAIL_TYPE, TRANSACTION_STATUS} from "../common/constant";
import {ObjectId} from "mongoose";
import RateUtils from "../utils/rate.utils";
import BankAccountDetailsService from "./bank-account-details.service";
import EmailService from "../utils/email.utils";
import config from "../config/env.config";
import { StorageService } from "./storage.service";

class TransactionService extends DBService<ITransaction> {

    transactionDetailsService: TransactionDetailsService;
    bankAccountDetailsService: BankAccountDetailsService;
    emailService: EmailService;
    storageService: StorageService;


    /**
     * Creates an instance of TransactionService
     * @constructor
     * @param populatedField
     * @example
     * new TransactionService(['user'])
     */
    constructor(populatedField: string[] = ['user']) {
        super(Transaction, populatedField);
        this.transactionDetailsService = new TransactionDetailsService();
        this.bankAccountDetailsService = new BankAccountDetailsService();
        this.emailService = new EmailService();
        this.storageService = new StorageService();
    }

    private receiptUploadService = FileUploadFactory.getGeneralUploadService();


    private generateTransactionReference = () => {
        const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 22).toUpperCase();
        return `ALIPAY_TX_${randomPart}`;
    };

    public createAlipayTransaction = async (transactionData: Partial<ITransaction & ITransactionDetail>, alipayQrCode: Express.Multer.File, user: string,) =>  {
        const { amount, platform, alipayNo, alipayName, fromCurrency } = transactionData;
        const bankAccountDetails = await this.bankAccountDetailsService.findOne({ isDefault: true, currency: fromCurrency });
        if(!bankAccountDetails) {
            throw errorResponseMessage.resourceNotFound(`Bank details for ${fromCurrency}`)
        }
        const uploadResult = await this.receiptUploadService.uploadFile(alipayQrCode as Express.Multer.File, {
            folder: 'qrcodes/',
            customFilename: `alipay_qrcode_${Date.now()}`,
            makePublic: true,
        });
        if(!uploadResult.success) {
            throw errorResponseMessage.unableToComplete("Alipay Qrcode upload failed");
        }

        const transaction = await this.create({
            user,
            reference: this.generateTransactionReference(),
            amount,
            // convertedAmount,
            fromCurrency,
            currency: "RMB",
            detailType: DETAIL_TYPE.ALIPAY,
            status: TRANSACTION_STATUS.PENDING_INPUT,
            initiatedAt: Date.now(),
        })

        const transactionDetails = await this.transactionDetailsService.create({
            transactionId: transaction._id,
            type: DETAIL_TYPE.ALIPAY,
            platform,
            alipayNo,
            alipayName,
            qrCodeUrl: uploadResult.file?.url!,
            bankAccountDetails: bankAccountDetails.toObject(),
        })
        return { ...transaction.toObject(), details: { ...transactionDetails.toObject() } } 
    }

    public uploadUserPaymentReceipt = async (transactionId: string, receipt: Express.Multer.File, isKycDone: boolean) => {
        const uploadResult = await this.receiptUploadService.uploadFile(receipt as Express.Multer.File, {
            folder: 'pay_in/',
            customFilename: `pay_in_receipt${Date.now()}`,
            makePublic: true,
        });
        if(!uploadResult.success) {
            console.log(uploadResult, "This is the user payment receipt upload result");
            throw errorResponseMessage.unableToComplete("Payment receipt upload failed");
        }
        const transaction = await this.findById(transactionId);
        let fromAmount = await new RateUtils(transaction?.fromCurrency!, "RMB").convertAmount(transaction?.amount!);
        await this.transactionDetailsService.update({ transactionId }, {payInReceiptUrl: uploadResult.file?.url, fromAmount: fromAmount});
        // TODO: I'm gonna handle the status below later when I'm implementing KYC for now the status should just be awaiting confirmation
        // await this.updateById(transactionId, { status: isKycDone ? TRANSACTION_STATUS.AWAITING_CONFIRMATION : TRANSACTION_STATUS.AWAITING_KYC_VERIFICATION })
        await this.updateById(transactionId, { status: TRANSACTION_STATUS.AWAITING_CONFIRMATION });

        config.ADMIN_EMAILS.split(",").map(async (email) => {
            await this.emailService.sendNotificationEmail(
                email,
                {
                    title: "New RMB Payment",
                    message: "A customer has initiated a new RMB payment and has paid, you can find the QRCode and the Payment Receipt attached to this email",
                    actionUrl: `${config.FRONTEND_URL}/dashboard/admin/payments`,
                    buttonText: "Go to dashboard"
                },
                [
                    {
                        filename: 'alipay_qrcode.png',
                        content: await this.storageService.downloadFile(transaction?.details?.qrCodeUrl!),
                        contentType: 'image/png'
                    },
                    {
                        filename: 'user_payment_receipt.png',
                        content: await this.storageService.downloadFile(uploadResult.file?.url!),
                        contentType: 'image/png'
                    }
                ]
            )
        })

    }

    public uploadAdminPaymentReceipt = async (transactionId: string, receipt: Express.Multer.File) => {
        const uploadResult = await this.receiptUploadService.uploadFile(receipt as Express.Multer.File, {
            folder: 'pay_out/',
            customFilename: `pay_out_receipt${Date.now()}`,
            makePublic: true,
        });
        if(!uploadResult.success) {
            console.log(uploadResult, "This is the admin payment receipt upload result")
            throw errorResponseMessage.unableToComplete("Payment receipt upload failed");
        }
        const transaction = await this.findById(transactionId);
        await this.transactionDetailsService.update({ transactionId }, { payOutReceiptUrl: uploadResult.file?.url });
        await this.updateById(transactionId, { status: TRANSACTION_STATUS.COMPLETED });
        console.log(transaction, "This is the transaction fetched");
        await this.emailService.sendNotificationEmail(
            (transaction?.user as IUser)?.email,
            {
                title: "Payment Completed",
                message: `Your RMB Payment to ${transaction?.details?.alipayName} has been completed and you can find the Payment Receipt attached to this email`,
                actionUrl: `${config.FRONTEND_URL}/dashboard/user/payments`,
                buttonText: "Go to dashboard"
            },
            [
                {
                    filename: 'payment_receipt.png',
                    content: await this.storageService.downloadFile(uploadResult.file?.url!),
                    contentType: 'image/png'
                }
            ]
        )
    }

    public markAlipayTransactionAsCompleted = async (receipt: Express.Multer.File) =>  {
        /*
            TODO:
            - Upload the receipt file to r2
            - Save the URL to the database and change the status to completed
            - return the transaction to show success
         */
    }

    /**
     * Search transactions with flexible text matching
     * @param searchTerm - The term to search for
     * @param filters - Additional filters
     * @param options - Pagination and sorting options
     */
    public async searchTransactions(
        searchTerm: string,
        filters: Partial<ITransaction> = {},
        options: {
            page?: number;
            limit?: number;
            useTextSearch?: boolean;
        } = {}
    ) {
        const { page = 1, limit = 10, useTextSearch = false } = options;

        let query: any = { ...filters };
        let sortOptions: Record<string, any> = { createdAt: -1 };

        if (searchTerm?.trim()) {
            const cleanedSearchTerm = searchTerm.trim();

            if (useTextSearch && cleanedSearchTerm.length >= 3) {
                // Use text search for better performance on full words
                query.$text = { $search: cleanedSearchTerm };
                sortOptions = { score: { $meta: "textScore" } };
            } else {
                // Use regex for partial matching
                const escapedSearchTerm = cleanedSearchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escapedSearchTerm, 'i');

                query.$or = [
                    { reference: regex },
                    { description: regex },
                    { city: regex },
                    { country: regex },
                ];
            }
        }

        return this.paginate(query, {
            page,
            limit,
            sort: sortOptions
        });
    }
}

export default TransactionService;