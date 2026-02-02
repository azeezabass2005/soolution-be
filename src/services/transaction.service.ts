import DBService from "../utils/db.utils";
import {DetailType, ITransaction, ITransactionDetail, IUser} from "../models/interface";
import Transaction from "../models/transaction.model";
import TransactionDetailsService from "./transaction-details.service";
import {FileUploadFactory} from "./file-upload.factory";
import errorResponseMessage from "../common/messages/error-response-message";
import {DETAIL_TYPE, TRANSACTION_STATUS} from "../common/constant";
import {ObjectId} from "mongoose";
import RateUtils from "../utils/rate.utils";
import BankAccountDetailsService from "./bank-account-details.service";
import NotificationService from "../utils/notification.utils";
import config from "../config/env.config";
import { StorageService } from "./storage.service";
import logger from "../utils/logger.utils";
import crypto from "crypto"

class TransactionService extends DBService<ITransaction> {

    transactionDetailsService: TransactionDetailsService;
    bankAccountDetailsService: BankAccountDetailsService;
    notificationService: NotificationService;
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
        this.notificationService = new NotificationService();
        this.storageService = new StorageService();
    }

    private receiptUploadService = FileUploadFactory.getGeneralUploadService();


    private generateTransactionReference = () => {
        const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 22).toUpperCase();
        return `ALIPAY_TX_${randomPart}`;
    };

    public createAlipayTransaction = async (transactionData: Partial<ITransaction & ITransactionDetail & { paymentMethod: DetailType }>, alipayQrCode: Express.Multer.File, user: string,) =>  {
        const { amount, platform, alipayId, alipayName, fromCurrency, paymentMethod } = transactionData;
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
            console.log(uploadResult, "This is the result from the alipay QRCode upload")
            throw errorResponseMessage.unableToComplete("Alipay Qrcode upload failed");
        }

        const transaction = await this.create({
            user,
            reference: this.generateTransactionReference(),
            amount,
            fromCurrency,
            currency: "RMB",
            detailType: paymentMethod || DETAIL_TYPE.ALIPAY,
            status: TRANSACTION_STATUS.PENDING_INPUT,
            initiatedAt: Date.now(),
        })

        const transactionDetails = await this.transactionDetailsService.create({
            transactionId: transaction._id,
            type: paymentMethod || DETAIL_TYPE.ALIPAY,
            alipayId,
            alipayName,
            qrCodeUrl: uploadResult.file?.url!,
            bankAccountDetails: bankAccountDetails.toObject(),
            ...(paymentMethod === 'alipay' ? { platform: platform } : {}),
        })

        // Send transaction initiated email to user
        try {
            const populatedTransaction = await this.findById(transaction._id.toString());
            const user = populatedTransaction?.user as IUser;
            if (user) {
                await this.notificationService.sendTransactionNotification(
                    user,
                    'payment_initiated',
                    {
                        amount: `${transaction.amount} ${transaction.currency}`,
                        reference: transaction.reference,
                        recipient: transactionDetails.alipayName || 'Recipient',
                        actionUrl: `${config.FRONTEND_URL}/dashboard/user/payments`,
                    }
                );
                logger.info('Transaction initiated email sent successfully', {
                    transactionId: transaction._id,
                    userId: user._id,
                    email: user.email,
                    reference: transaction.reference,
                    amount: `${transaction.amount} ${transaction.fromCurrency}`,
                    currency: transaction.currency
                });
            }
        } catch (error) {
            logger.error('Failed to send transaction initiated email', {
                transactionId: transaction._id,
                reference: transaction.reference,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            // Don't fail transaction creation if email fails
        }

        return { ...transaction.toObject(), details: { ...transactionDetails.toObject() } } 
    }

    public uploadUserPaymentReceipt = async (transactionId: string, receipt: Express.Multer.File, isKycDone: boolean) => {
        const uploadResult = await this.receiptUploadService.uploadFile(receipt as Express.Multer.File, {
            folder: 'pay_in/',
            customFilename: `pay_in_receipt${Date.now()}`,
            makePublic: true,
        });
        if(!uploadResult.success) {
            console.log(uploadResult, "This is the result from the payment receipt upload")
            throw errorResponseMessage.unableToComplete("Payment receipt upload failed");
        }
        const transaction = await this.findById(transactionId);
        let fromAmount = await new RateUtils(transaction?.fromCurrency!, "RMB").convertAmount(transaction?.amount!);
        await this.transactionDetailsService.update({ transactionId }, {payInReceiptUrl: uploadResult.file?.url, fromAmount: fromAmount});
        await this.updateById(transactionId, { status: isKycDone ? TRANSACTION_STATUS.AWAITING_CONFIRMATION : TRANSACTION_STATUS.AWAITING_KYC_VERIFICATION });

        // Notify admins via both email and WhatsApp
        await this.notificationService.notifyAdmins(
            config.ADMIN_EMAILS,
            {
                title: "📱 New RMB Payment",
                message: `A customer has initiated a new RMB payment and has paid. Check the QR code and payment receipt attached.\n Alipay Id: ${transaction?.details?.alipayId} \n Alipay Name: ${transaction?.details?.alipayName}`,
                actionUrl: `${config.FRONTEND_URL}/dashboard/admin/payments`,
                buttonText: "Go to Dashboard",
            },
            config.ADMIN_PHONE_NUMBERS,
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
            ],
            [
                {
                    caption: 'Alipay QRCode',
                    url: transaction?.details?.qrCodeUrl!,
                },
                {
                    caption: 'User Payment Receipt',
                    url: uploadResult.file?.url!,
                }
            ],
        );

        // Attach files for email notification
        // const adminEmails = config.ADMIN_EMAILS.split(",");
        // for (const email of adminEmails) {
        //     try {
        //         await this.notificationService.emailService.sendNotificationEmail(
        //             email,
        //             {
        //                 title: "New RMB Payment",
        //                 message: "A customer has initiated a new RMB payment and has paid.",
        //                 actionUrl: `${config.FRONTEND_URL}/dashboard/admin/payments`,
        //                 buttonText: "Go to dashboard"
        //             },
        //             [
        //                 {
        //                     filename: 'alipay_qrcode.png',
        //                     content: await this.storageService.downloadFile(transaction?.details?.qrCodeUrl!),
        //                     contentType: 'image/png'
        //                 },
        //                 {
        //                     filename: 'user_payment_receipt.png',
        //                     content: await this.storageService.downloadFile(uploadResult.file?.url!),
        //                     contentType: 'image/png'
        //                 }
        //             ]
        //         );
        //     } catch (error) {
        //         console.error(`Failed to send admin notification to ${email}:`, error);
        //     }
        // }
    }

    public uploadAdminPaymentReceipt = async (transactionId: string, receipt: Express.Multer.File) => {
        const uploadResult = await this.receiptUploadService.uploadFile(receipt as Express.Multer.File, {
            folder: 'pay_out/',
            customFilename: `pay_out_receipt${Date.now()}`,
            makePublic: true,
        });
        if(!uploadResult.success) {
            console.log(uploadResult, "This is the result from admin payment receipt upload")
            throw errorResponseMessage.unableToComplete("Payment receipt upload failed");
        }
        const transaction = await this.findById(transactionId);
        await this.transactionDetailsService.update({ transactionId }, { payOutReceiptUrl: uploadResult.file?.url });
        await this.updateById(transactionId, { status: TRANSACTION_STATUS.COMPLETED });

        // Send transaction completed email and WhatsApp notification to user
        const user = transaction?.user as IUser;
        if (user) {
            try {
                await this.notificationService.sendTransactionNotification(
                    user,
                    'payment_completed',
                    {
                        amount: `${transaction?.amount} ${transaction?.currency}`,
                        reference: transaction?.reference,
                        recipient: transaction?.details?.alipayName || 'Recipient',
                        actionUrl: `${config.FRONTEND_URL}/dashboard/user/payments`,
                    },
                    [
                        {
                            filename: 'payment_receipt.png',
                            content: await this.storageService.downloadFile(uploadResult.file?.url!),
                            contentType: 'image/png'
                        }
                    ]
                );
                logger.info('Transaction completed email sent successfully', {
                    transactionId: transaction?._id,
                    userId: user._id,
                    email: user.email,
                    reference: transaction?.reference,
                    amount: `${transaction?.amount} ${transaction?.fromCurrency}`,
                    currency: transaction?.currency
                });
            } catch (error) {
                logger.error('Failed to send transaction completed email', {
                    transactionId: transaction?._id,
                    userId: user._id,
                    email: user.email,
                    reference: transaction?.reference,
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                });
                // Don't fail transaction completion if email fails
            }
        }
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