import DBService from "../utils/db.utils";
import {DetailType, ITransaction, ITransactionDetail, IUser} from "../models/interface";
import Transaction from "../models/transaction.model";
import TransactionDetailsService from "./transaction-details.service";
import {FileUploadFactory} from "./file-upload.factory";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import {DETAIL_TYPE, TRANSACTION_STATUS} from "../common/constant";
import {ObjectId, ClientSession} from "mongoose";
import mongoose from "mongoose";
import RateUtils from "../utils/rate.utils";
import BankAccountDetailsService from "./bank-account-details.service";
import NotificationService from "../utils/notification.utils";
import config from "../config/env.config";
import { StorageService } from "./storage.service";
import logger from "../utils/logger.utils";
import crypto from "crypto";
import transactionStateMachine from "../utils/transaction-state-machine.utils";
import IdempotencyService from "./idempotency.service";
import AuditLogService from "./audit-log.service";
import { validateTransactionAmount, getTransactionLimits } from "../config/transaction-limits.config";

class TransactionService extends DBService<ITransaction> {

    transactionDetailsService: TransactionDetailsService;
    bankAccountDetailsService: BankAccountDetailsService;
    notificationService: NotificationService;
    storageService: StorageService;
    idempotencyService: IdempotencyService;
    auditLogService: AuditLogService;


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
        this.idempotencyService = new IdempotencyService();
        this.auditLogService = new AuditLogService();
    }

    private receiptUploadService = FileUploadFactory.getGeneralUploadService();


    private generateTransactionReference = () => {
        const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 22).toUpperCase();
        return `ALIPAY_TX_${randomPart}`;
    };

    private generateBankTransferTransactionReference = (currency: string) => {
        const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 22).toUpperCase();
        return `${currency}_TX_${randomPart}`;
    };

    public createBankTransferTransaction = async (
        transactionData: Partial<ITransaction & ITransactionDetail & { paymentMethod: DetailType; toCurrency: string; institutionType: string; idempotencyKey?: string }>,
        user: string,
        ipAddress?: string,
        userAgent?: string
    ) => {
        const { amount, fromCurrency, toCurrency, paymentMethod, institutionType, bankName, accountNumber, accountName, momoNetwork, momoNumber, momoName, idempotencyKey, fromAmount } = transactionData;
        
        if (!toCurrency) {
            throw errorResponseMessage.payloadIncorrect("Target currency (toCurrency) is required");
        }

        if (!fromCurrency) {
            throw errorResponseMessage.payloadIncorrect("Source currency (fromCurrency) is required");
        }

        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }

        // Validate exchange rate exists and is active before creating transaction
        const rateUtils = new RateUtils(fromCurrency, toCurrency);
        await rateUtils.validateExchangeRate();

        // Calculate fromAmount if not provided (convert amount from target currency to source currency)
        // For bank transfers: amount is in toCurrency, fromAmount is in fromCurrency (NGN)
        let calculatedFromAmount = fromAmount;
        if (!calculatedFromAmount) {
            // Convert target currency amount to source currency (NGN)
            // We need reverse conversion: if rate is NGN->KES, we need KES->NGN
            // So we use RateUtils with reversed currencies
            const reverseRateUtils = new RateUtils(toCurrency, fromCurrency);
            calculatedFromAmount = await reverseRateUtils.convertAmount(amount);
        }
        calculatedFromAmount = Math.round(calculatedFromAmount * 100) / 100; // Round to 2 decimal places

        // Validate amount against transaction limits (using NGN equivalent for minimum)
        const amountValidation = validateTransactionAmount(amount, fromCurrency as any, toCurrency as any, calculatedFromAmount);
        if (!amountValidation.isValid) {
            throw errorResponseMessage.createError(
                400,
                amountValidation.error || "Transaction amount is outside allowed limits",
                ErrorSeverity.HIGH
            );
        }

        // Handle idempotency key if provided
        if (idempotencyKey) {
            const idempotencyResult = await this.idempotencyService.validateKey(idempotencyKey, user);
            if (idempotencyResult.isDuplicate && idempotencyResult.transactionId) {
                // Return existing transaction
                const existingTransaction = await this.findById(idempotencyResult.transactionId);
                if (existingTransaction) {
                    const existingDetails = await this.transactionDetailsService.findOne({ transactionId: existingTransaction._id });
                    return { 
                        ...existingTransaction.toObject(), 
                        details: existingDetails ? existingDetails.toObject() : {} 
                    };
                }
            }
        }

        const bankAccountDetails = await this.bankAccountDetailsService.findOne({ isDefault: true, currency: fromCurrency });
        if(!bankAccountDetails) {
            throw errorResponseMessage.resourceNotFound(`Bank details for ${fromCurrency}`)
        }

        const transaction = await this.create({
            user,
            reference: this.generateBankTransferTransactionReference(toCurrency),
            amount: Math.round(amount * 100) / 100, // Round to 2 decimal places
            fromCurrency,
            currency: toCurrency,
            detailType: paymentMethod || DETAIL_TYPE.BANK_TRANSFER,
            status: TRANSACTION_STATUS.PENDING_INPUT,
            initiatedAt: Date.now(),
        })

        // Update idempotency key with transaction ID if provided
        if (idempotencyKey) {
            await this.idempotencyService.updateKeyWithTransaction(idempotencyKey, transaction._id.toString());
        }

        const transactionDetails = await this.transactionDetailsService.create({
            transactionId: transaction._id,
            type: paymentMethod || DETAIL_TYPE.BANK_TRANSFER,
            institutionType,
            bankAccountDetails: bankAccountDetails.toObject(),
            fromAmount: calculatedFromAmount, // Amount in source currency (what user sends)
            ...(institutionType === 'bank' ? {
                bankName,
                accountNumber,
                accountName,
            } : {
                momoNetwork,
                momoNumber,
                momoName,
            }),
        })

        // Send transaction initiated email to user
        try {
            const populatedTransaction = await this.findById(transaction._id.toString());
            const userObj = populatedTransaction?.user as IUser;
            if (userObj) {
                await this.notificationService.sendTransactionNotification(
                    userObj,
                    'payment_initiated',
                    {
                        amount: `${transaction.amount} ${transaction.currency}`,
                        reference: transaction.reference,
                        recipient: institutionType === 'bank' ? accountName : momoName || 'Recipient',
                        actionUrl: `${config.FRONTEND_URL}/dashboard/user/payments`,
                    }
                );
                logger.info('Transaction initiated email sent successfully', {
                    transactionId: transaction._id,
                    userId: userObj._id,
                    email: userObj.email,
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

    public createAlipayTransaction = async (transactionData: Partial<ITransaction & ITransactionDetail & { paymentMethod: DetailType; idempotencyKey?: string }>, alipayQrCode: Express.Multer.File, user: string, ipAddress?: string, userAgent?: string) =>  {
        const { amount, platform, alipayNo, alipayName, fromCurrency, paymentMethod, idempotencyKey } = transactionData;
        
        if (!fromCurrency) {
            throw errorResponseMessage.payloadIncorrect("Source currency (fromCurrency) is required");
        }

        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }

        // Validate exchange rate exists and is active before creating transaction
        const rateUtils = new RateUtils(fromCurrency, "RMB");
        await rateUtils.validateExchangeRate();

        // Calculate NGN equivalent for minimum amount validation
        // For RMB transactions, amount is in RMB, we need to convert to NGN
        const ngnEquivalent = await rateUtils.convertAmount(amount);

        // Validate amount against transaction limits (using NGN equivalent for minimum)
        const amountValidation = validateTransactionAmount(amount, fromCurrency as any, "RMB", ngnEquivalent);
        if (!amountValidation.isValid) {
            throw errorResponseMessage.createError(
                400,
                amountValidation.error || "Transaction amount is outside allowed limits",
                ErrorSeverity.HIGH
            );
        }

        // Handle idempotency key if provided
        if (idempotencyKey) {
            const idempotencyResult = await this.idempotencyService.validateKey(idempotencyKey, user);
            if (idempotencyResult.isDuplicate && idempotencyResult.transactionId) {
                // Return existing transaction
                const existingTransaction = await this.findById(idempotencyResult.transactionId);
                if (existingTransaction) {
                    const existingDetails = await this.transactionDetailsService.findOne({ transactionId: existingTransaction._id });
                    return { 
                        ...existingTransaction.toObject(), 
                        details: existingDetails ? existingDetails.toObject() : {} 
                    };
                }
            }
        }

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
            amount: Math.round(amount * 100) / 100, // Round to 2 decimal places
            fromCurrency,
            currency: "RMB",
            detailType: paymentMethod || DETAIL_TYPE.ALIPAY,
            status: TRANSACTION_STATUS.PENDING_INPUT,
            initiatedAt: Date.now(),
        })

        // Update idempotency key with transaction ID if provided
        if (idempotencyKey) {
            await this.idempotencyService.updateKeyWithTransaction(idempotencyKey, transaction._id.toString());
        }

        const transactionDetails = await this.transactionDetailsService.create({
            transactionId: transaction._id,
            type: paymentMethod || DETAIL_TYPE.ALIPAY,
            alipayNo,
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

    public uploadUserPaymentReceipt = async (transactionId: string, receipt: Express.Multer.File, isKycDone: boolean, userId?: string, ipAddress?: string, userAgent?: string) => {
        // Use MongoDB transaction for atomic operations
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const uploadResult = await this.receiptUploadService.uploadFile(receipt as Express.Multer.File, {
                folder: 'pay_in/',
                customFilename: `pay_in_receipt${Date.now()}`,
                makePublic: true,
            });
            if(!uploadResult.success) {
                logger.error('Payment receipt upload failed', { 
                    error: uploadResult.error,
                    transactionId,
                    fileName: receipt.originalname,
                    fileSize: receipt.size
                });
                throw errorResponseMessage.unableToComplete("Payment receipt upload failed");
            }
            
            if (!uploadResult.file?.url) {
                logger.error('Upload succeeded but no URL returned', {
                    transactionId,
                    fileKey: uploadResult.file?.key
                });
                throw errorResponseMessage.unableToComplete("Payment receipt upload failed - no URL returned");
            }

            logger.info('Payment receipt uploaded successfully', {
                transactionId,
                fileKey: uploadResult.file.key,
                fileUrl: uploadResult.file.url,
                fileSize: uploadResult.file.size
            });

            // Fetch transaction with optimistic locking - use findOneAndUpdate to prevent race conditions
            const transaction = await this.Model.findOneAndUpdate(
                { 
                    _id: transactionId,
                    status: TRANSACTION_STATUS.PENDING_INPUT // Only update if still in PENDING_INPUT
                },
                { $set: {} }, // No update, just for locking
                { 
                    session,
                    new: true 
                }
            ).populate('user');

            if (!transaction) {
                await session.abortTransaction();
                await session.endSession();
                throw errorResponseMessage.resourceNotFound("Transaction or transaction is not in a valid state for receipt upload");
            }

            // Validate exchange rate exists and is active before conversion
            if (!transaction.fromCurrency || !transaction.currency) {
                await session.abortTransaction();
                await session.endSession();
                throw errorResponseMessage.createError(
                    400,
                    "Transaction currency information is missing",
                    ErrorSeverity.HIGH
                );
            }

            if (!transaction.amount || transaction.amount <= 0) {
                await session.abortTransaction();
                await session.endSession();
                throw errorResponseMessage.createError(
                    400,
                    "Transaction amount is invalid",
                    ErrorSeverity.HIGH
                );
            }

            // Use the transaction's currency (which could be RMB, GHS, XAF, KES, or NGN) instead of hardcoding RMB
            const rateUtils = new RateUtils(transaction.fromCurrency, transaction.currency);
            let fromAmount = await rateUtils.convertAmount(transaction.amount);
            // Round fromAmount to 2 decimal places
            fromAmount = Math.round(fromAmount * 100) / 100;
            
            // Update transaction details with receipt URL (within transaction)
            await this.transactionDetailsService.updateOneWithSession(
                { transactionId }, 
                { $set: { payInReceiptUrl: uploadResult.file.url, fromAmount: fromAmount } },
                session
            );

            // Validate status transition before updating
            const oldStatus = transaction.status;
            const newStatus = isKycDone ? TRANSACTION_STATUS.AWAITING_CONFIRMATION : TRANSACTION_STATUS.AWAITING_KYC_VERIFICATION;
            transactionStateMachine.validateTransition(oldStatus, newStatus);

            // Update status within transaction
            await this.updateById(transactionId, { status: newStatus }, session);

            // Commit transaction
            await session.commitTransaction();
            await session.endSession();

            // Log status change and receipt upload (outside transaction to avoid blocking)
            if (userId) {
                try {
                    await Promise.all([
                        this.auditLogService.logStatusChange(
                            transactionId,
                            userId,
                            oldStatus,
                            newStatus,
                            ipAddress,
                            userAgent
                        ),
                        this.auditLogService.logReceiptUpload(
                            transactionId,
                            userId,
                            'pay_in',
                            uploadResult.file.url,
                            ipAddress,
                            userAgent
                        )
                    ]);
                } catch (error) {
                    logger.warn('Failed to log audit events', { error, transactionId });
                    // Don't fail if audit logging fails
                }
            }

            // Notify admins via both email and WhatsApp (outside transaction - don't fail if this fails)
            const isAlipayTransaction = transaction.currency === 'RMB';
            const transactionType = isAlipayTransaction ? 'RMB Payment' : `${transaction.currency} Payment`;
            const recipientInfo = isAlipayTransaction 
                ? `${transaction.details?.alipayNo ? `Alipay No: ${transaction.details.alipayNo}\n` : ''}${transaction.details?.alipayName ? `Alipay Name: ${transaction.details.alipayName}` : ''}`
                : transaction.details?.institutionType === 'bank'
                    ? `Bank: ${transaction.details.bankName}\nAccount Number: ${transaction.details.accountNumber}\nAccount Name: ${transaction.details.accountName}`
                    : `Network: ${transaction.details?.momoNetwork}\nNumber: ${transaction.details?.momoNumber}\nName: ${transaction.details?.momoName}`;

            const attachments = [];
            const whatsappAttachments = [];

            if (isAlipayTransaction && transaction.details?.qrCodeUrl) {
                try {
                    attachments.push({
                        filename: 'alipay_qrcode.png',
                        content: await this.storageService.downloadFile(transaction.details.qrCodeUrl),
                        contentType: 'image/png'
                    });
                    whatsappAttachments.push({
                        caption: 'Alipay QRCode',
                        url: transaction.details.qrCodeUrl,
                    });
                } catch (error) {
                    logger.warn('Failed to download Alipay QR code for notification', { error, transactionId });
                    // Continue without QR code attachment
                }
            }

            try {
                attachments.push({
                    filename: 'user_payment_receipt.png',
                    content: await this.storageService.downloadFile(uploadResult.file.url),
                    contentType: 'image/png'
                });
                whatsappAttachments.push({
                    caption: 'User Payment Receipt',
                    url: uploadResult.file.url,
                });
            } catch (error) {
                logger.warn('Failed to download receipt for notification, but receipt is uploaded', { error, transactionId, receiptUrl: uploadResult.file.url });
                // Continue without receipt attachment in notification, but receipt is already saved
            }

            // Send notifications (don't fail if this fails, receipt is already uploaded)
            try {
                await this.notificationService.notifyAdmins(
                    config.ADMIN_EMAILS,
                    {
                        title: `📱 New ${transactionType}`,
                        message: `A customer has initiated a new ${transaction.currency} payment and has paid. Check the payment receipt attached.\n${recipientInfo}`,
                        actionUrl: `${config.FRONTEND_URL}/dashboard/admin/transactions`,
                        buttonText: "Go to Transaction History",
                    },
                    config.ADMIN_PHONE_NUMBERS,
                    attachments,
                    whatsappAttachments,
                );
            } catch (error) {
                logger.error('Failed to send admin notifications, but receipt is uploaded', { error, transactionId });
                // Don't fail the whole operation if notifications fail
            }
        } catch (error) {
            // Abort transaction on error
            await session.abortTransaction();
            await session.endSession();
            throw error;
        }

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

    public uploadAdminPaymentReceipt = async (transactionId: string, receipt: Express.Multer.File, userId?: string, ipAddress?: string, userAgent?: string) => {
        const uploadResult = await this.receiptUploadService.uploadFile(receipt as Express.Multer.File, {
            folder: 'pay_out/',
            customFilename: `pay_out_receipt${Date.now()}`,
            makePublic: true,
        });
        if(!uploadResult.success) {
            console.log(uploadResult, "This is the result from admin payment receipt upload")
            throw errorResponseMessage.unableToComplete("Payment receipt upload failed");
        }

        // Fetch transaction and validate it exists
        const transaction = await this.findById(transactionId);
        if (!transaction) {
            throw errorResponseMessage.resourceNotFound("Transaction");
        }

        // Validate transaction status - must be AWAITING_CONFIRMATION to complete
        if (transaction.status !== TRANSACTION_STATUS.AWAITING_CONFIRMATION) {
            throw errorResponseMessage.createError(
                400,
                `Cannot complete transaction. Transaction must be in ${TRANSACTION_STATUS.AWAITING_CONFIRMATION} status. Current status: ${transaction.status}`,
                ErrorSeverity.HIGH
            );
        }

        // Validate status transition before updating
        transactionStateMachine.validateTransition(transaction.status, TRANSACTION_STATUS.COMPLETED);

        const oldStatus = transaction.status;

        await this.transactionDetailsService.update({ transactionId }, { payOutReceiptUrl: uploadResult.file?.url });
        await this.updateById(transactionId, { status: TRANSACTION_STATUS.COMPLETED });

        // Log status change and receipt upload
        if (userId) {
            try {
                await Promise.all([
                    this.auditLogService.logStatusChange(
                        transactionId,
                        userId,
                        oldStatus,
                        TRANSACTION_STATUS.COMPLETED,
                        ipAddress,
                        userAgent
                    ),
                    this.auditLogService.logReceiptUpload(
                        transactionId,
                        userId,
                        'pay_out',
                        uploadResult.file?.url || '',
                        ipAddress,
                        userAgent
                    )
                ]);
            } catch (error) {
                logger.warn('Failed to log audit events', { error, transactionId });
                // Don't fail if audit logging fails
            }
        }

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