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
import yellowCardService from "./yellowcard.service";
import ogatewayService from "./ogateway.service";
import platformSettingsService from "./platform-settings.service";
import {
    YELLOWCARD_STATUS,
    OGATEWAY_STATUS,
    OGATEWAY_CHANNELS,
    WALLET_STATUS,
    WALLET_TRANSACTION_TYPE,
    WALLET_TRANSACTION_STATUS,
    JOURNAL_DIRECTION,
    JOURNAL_SOURCE,
    SYSTEM_ACCOUNT_CODES,
    WEBHOOK_PROVIDER,
    userWalletAccountCode,
    ogCashAccountCode,
    ogPaymentInflightCode,
    ogCollectionInflightCode,
} from "../common/constant";
import WalletService from "./wallet.service";
import WalletTransactionService from "./wallet-transaction.service";
import PinService from "./pin.service";
import ledgerService from "./ledger.service";

class TransactionService extends DBService<ITransaction> {

    transactionDetailsService: TransactionDetailsService;
    bankAccountDetailsService: BankAccountDetailsService;
    notificationService: NotificationService;
    storageService: StorageService;
    idempotencyService: IdempotencyService;
    auditLogService: AuditLogService;
    walletService: WalletService;
    walletTransactionService: WalletTransactionService;
    pinService: PinService;


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
        this.walletService = new WalletService();
        this.walletTransactionService = new WalletTransactionService();
        this.pinService = new PinService();
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
        transactionData: Partial<ITransaction & ITransactionDetail & { paymentMethod: DetailType; toCurrency: string; institutionType: string; idempotencyKey?: string; transactionType?: 'send' | 'receive'; pin?: string }>,
        user: string,
        ipAddress?: string,
        userAgent?: string
    ) => {
        const { amount, fromCurrency, toCurrency, paymentMethod, institutionType, bankName, accountNumber, accountName, momoNetwork, momoNumber, momoName, idempotencyKey, fromAmount, transactionType, pin } = transactionData;

        if (!toCurrency) {
            throw errorResponseMessage.payloadIncorrect("Target currency (toCurrency) is required");
        }

        if (!fromCurrency) {
            throw errorResponseMessage.payloadIncorrect("Source currency (fromCurrency) is required");
        }

        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }

        // PIN authorization is required for SEND transactions only.
        // Receive transactions don't debit the wallet so the PIN gate doesn't apply.
        if (transactionType === 'send') {
            if (!pin) {
                throw errorResponseMessage.payloadIncorrect("Transaction PIN is required");
            }
            await this.pinService.verifyPin(user, pin);
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
            // Use convertAmountReverse to properly handle reverse conversion
            const rateUtils = new RateUtils(fromCurrency, toCurrency);
            calculatedFromAmount = await rateUtils.convertAmountReverse(amount);
        }
        calculatedFromAmount = Math.round(calculatedFromAmount * 100) / 100; // Round to 2 decimal places

        // Determine NGN equivalent for validation
        // For receive transactions: toCurrency is NGN, so amount is already the NGN equivalent
        // For send transactions: fromCurrency is NGN, so calculatedFromAmount/fromAmount is the NGN equivalent
        const isReceiveTransaction = toCurrency === 'NGN' && fromCurrency !== 'NGN';
        const ngnEquivalentForValidation = isReceiveTransaction ? amount : (calculatedFromAmount || fromAmount);

        // Validate amount against transaction limits (using NGN equivalent for minimum)
        const amountValidation = validateTransactionAmount(amount, fromCurrency as any, toCurrency as any, ngnEquivalentForValidation);
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

    public createAlipayTransaction = async (transactionData: Partial<ITransaction & ITransactionDetail & { paymentMethod: DetailType; idempotencyKey?: string; pin?: string }>, alipayQrCode: Express.Multer.File, user: string, ipAddress?: string, userAgent?: string) =>  {
        const { amount, platform, alipayNo, alipayName, fromCurrency, paymentMethod, idempotencyKey, pin } = transactionData;

        if (!fromCurrency) {
            throw errorResponseMessage.payloadIncorrect("Source currency (fromCurrency) is required");
        }

        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }

        // Alipay is always a send (debit) flow — PIN is required.
        if (!pin) {
            throw errorResponseMessage.payloadIncorrect("Transaction PIN is required");
        }
        await this.pinService.verifyPin(user, pin);

        // Validate exchange rate exists and is active before creating transaction
        const rateUtils = new RateUtils(fromCurrency, "RMB");
        await rateUtils.validateExchangeRate();

        // Calculate NGN equivalent for minimum amount validation
        // For RMB transactions, amount is in RMB, we need to convert to NGN (reverse conversion)
        // Use convertAmountReverse because we're converting from RMB (toCurrency) to NGN (fromCurrency)
        const ngnEquivalent = await rateUtils.convertAmountReverse(amount);

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
            logger.error("Alipay QRCode upload to R2 failed", { error: uploadResult.error });
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

            // Preserve fromAmount if already stored at transaction creation time (historically accurate).
            // Only compute it here for transaction types that don't store it during creation (e.g. Alipay).
            const existingDetails = await this.transactionDetailsService.findOne({ transactionId });
            const updateFields: Record<string, any> = { payInReceiptUrl: uploadResult.file.url };

            if (!existingDetails?.fromAmount) {
                // fromAmount not set at creation — compute from current rate as fallback
                const rateUtils = new RateUtils(transaction.fromCurrency, transaction.currency);
                let fromAmount = await rateUtils.convertAmountReverse(transaction.amount);
                fromAmount = Math.round(fromAmount * 100) / 100;
                updateFields.fromAmount = fromAmount;
            }

            // Update transaction details with receipt URL (within transaction)
            await this.transactionDetailsService.updateOneWithSession(
                { transactionId },
                { $set: updateFields },
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
    // ============= YELLOWCARD AUTOMATIC PAYMENT METHODS =============

    private generateYellowCardSequenceId = () => {
        const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 22).toUpperCase();
        return `YC_TX_${randomPart}`;
    };

    /**
     * Create a YellowCard automatic payment transaction.
     * Step 1: Creates the transaction record and submits a collection request to YellowCard.
     * The collection collects local currency from the user. Once YellowCard confirms collection
     * via webhook, the disbursement (payment) is triggered automatically.
     */
    public createYellowCardTransaction = async (
        params: {
            amount: number;
            fromAmount?: number;
            fromCurrency: string;
            toCurrency: string;
            sender: {
                name: string;
                country: string;
                phone: string;
                address: string;
                dob: string;
                email: string;
                idNumber?: string;
                idType?: string;
            };
            destination: {
                accountName: string;
                accountNumber: string;
                accountType: string;
                country: string;
            };
            idempotencyKey?: string;
            pin?: string;
        },
        userId: string,
        ipAddress?: string,
        userAgent?: string
    ) => {
        const { amount, fromCurrency, toCurrency, sender, destination, idempotencyKey, pin } = params;

        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }

        // YellowCard send is always an outbound debit — PIN is required.
        if (!pin) {
            throw errorResponseMessage.payloadIncorrect("Transaction PIN is required");
        }
        await this.pinService.verifyPin(userId, pin);

        // ========== SERVER-SIDE RATE + FEE ==========
        // Compute the NGN debit from YellowCard's live rates and apply the
        // platform's universal markup so display and journal agree. Client-
        // supplied fromAmount is ignored.
        let providerRate: number;
        let userRate: number;
        try {
            providerRate = await yellowCardService.getImpliedRate(fromCurrency, toCurrency, 'send');
            userRate = await platformSettingsService.applyRateMarkup(providerRate, 'send');
        } catch (err: any) {
            logger.error("YellowCard rate lookup failed during send", { fromCurrency, toCurrency, error: err?.message });
            throw errorResponseMessage.createError(400, `Could not retrieve the ${fromCurrency}→${toCurrency} rate from YellowCard. Please try again.`, ErrorSeverity.HIGH);
        }
        const ngnAmount = Math.round(amount * userRate * 100) / 100;
        if (!ngnAmount || ngnAmount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Source amount (fromAmount) must be a positive number");
        }

        const { feeAmount, feePercent, providerFeePercent } = await platformSettingsService.computeFee('yellowcard', ngnAmount);
        const totalDebit = Math.round((ngnAmount + feeAmount) * 100) / 100;
        const markupPercent = (await platformSettingsService.getSettings()).rateMarkupPercent;

        // Check wallet exists and has sufficient balance
        const wallet = await this.walletService.findOne({ user: userId });
        if (!wallet) {
            throw errorResponseMessage.createError(400, "You don't have a wallet yet. Please set up your wallet first.", ErrorSeverity.MEDIUM);
        }
        if (wallet.status !== WALLET_STATUS.ACTIVE) {
            throw errorResponseMessage.createError(400, "Your wallet is not active. Please contact support.", ErrorSeverity.HIGH);
        }
        if (wallet.balance < totalDebit) {
            throw errorResponseMessage.createError(
                400,
                `Insufficient wallet balance. You need ₦${totalDebit.toLocaleString()} but your balance is ₦${wallet.balance.toLocaleString()}. Please fund your wallet first.`,
                ErrorSeverity.MEDIUM
            );
        }

        // Handle idempotency
        if (idempotencyKey) {
            const idempotencyResult = await this.idempotencyService.validateKey(idempotencyKey, userId);
            if (idempotencyResult.isDuplicate && idempotencyResult.transactionId) {
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

        // Resolve active channels and networks from YellowCard for the destination country
        const destCountry = destination.country;
        const targetType = destination.accountType; // 'bank' or 'momo'

        let channelsData: any;
        let networksData: any;
        try {
            [channelsData, networksData] = await Promise.all([
                yellowCardService.getChannels(destCountry),
                yellowCardService.getNetworks(destCountry),
            ]);
        } catch (error: any) {
            logger.error("Failed to fetch YellowCard channels/networks", { destCountry, error: error?.message });
            throw errorResponseMessage.createError(400, "Unable to fetch payment channels. Please try again.", ErrorSeverity.HIGH);
        }

        const allChannels = channelsData?.channels || channelsData || [];
        const allNetworks = networksData?.networks || networksData || [];

        // Payments require off-ramp/withdraw channels
        const isPaymentChannel = (c: any) => {
            const rt = (c.rampType || '').toLowerCase();
            return rt === 'withdraw' || rt === 'off' || rt === 'offramp' || rt === 'off-ramp';
        };
        const activeChannels = allChannels.filter((c: any) => c.status === 'active' && isPaymentChannel(c));
        const sortedChannels = [
            ...activeChannels.filter((c: any) => c.channelType === targetType),
            ...activeChannels.filter((c: any) => c.channelType !== targetType),
        ];

        const activeNetworks = allNetworks.filter((n: any) => n.status === 'active');
        const network = activeNetworks.find((n: any) => n.type === targetType) || activeNetworks[0];

        if (sortedChannels.length === 0 || !network) {
            throw errorResponseMessage.createError(
                400,
                "Automatic payment is not available for this destination at the moment. Please try manual payment.",
                ErrorSeverity.MEDIUM
            );
        }

        logger.info("YellowCard channels resolved", {
            destCountry,
            targetType,
            activeChannels: sortedChannels.map((c: any) => ({ id: c.id, type: c.channelType })),
            network: network?.id,
        });

        const sequenceId = this.generateYellowCardSequenceId();

        // ========== ATOMIC WALLET DEBIT ==========
        // Debit wallet balance before creating the transaction
        const walletSession = await mongoose.startSession();
        walletSession.startTransaction();

        let walletTransaction: any;
        const walletTxRef = this.walletTransactionService.generateReference('TRF');
        const balanceBefore = wallet.balance;
        const balanceAfter = balanceBefore - totalDebit;

        try {
            // Atomic balance debit with balance guard
            await this.walletService.debitBalance(wallet._id as string, totalDebit, walletSession);

            // Post journal: user's NGN wallet drops by totalDebit (converted +
            // fee). The converted portion sits at YC awaiting payout; the fee
            // lands in FEES_NGN as platform revenue, recognised on initiation.
            const userAccountCode = userWalletAccountCode(userId, wallet.currency);
            const legs: Array<{ accountCode: string; direction: any; amount: number }> = [
                { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.DEBIT, amount: totalDebit },
                { accountCode: SYSTEM_ACCOUNT_CODES.YC_FLOAT_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: ngnAmount },
            ];
            if (feeAmount > 0) {
                legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: feeAmount });
            }
            await ledgerService.post({
                legs,
                source: JOURNAL_SOURCE.YC_SEND,
                reference: sequenceId,
                description: `YellowCard send — ${amount} ${toCurrency} to ${destination.accountName}`,
                externalRef: { provider: WEBHOOK_PROVIDER.YELLOWCARD, id: sequenceId },
                metadata: {
                    destinationAmount: amount, destinationCurrency: toCurrency, destCountry,
                    feeAmount, feePercent, providerFeePercent, markupPercent, providerRate, userRate,
                },
                session: walletSession,
            });

            // Create wallet transaction record
            walletTransaction = await this.walletTransactionService.create({
                wallet: wallet._id,
                user: userId,
                type: WALLET_TRANSACTION_TYPE.TRANSFER,
                status: WALLET_TRANSACTION_STATUS.PENDING,
                amount: totalDebit,
                reference: walletTxRef,
                balanceBefore,
                balanceAfter,
                description: `Transfer to ${destination.accountName} (${amount} ${toCurrency})`,
            }, walletSession);

            await walletSession.commitTransaction();
        } catch (error: any) {
            if (walletSession.inTransaction()) {
                await walletSession.abortTransaction();
            }
            walletSession.endSession();
            throw error;
        } finally {
            walletSession.endSession();
        }

        // Capture the locked FX rate so reports can replay the exact rate used.
        // lockedRate = userRate (markup already applied above).
        const lockedRate = userRate;

        // Create our internal transaction record
        let transaction: any;
        let transactionDetails: any;
        try {
            transaction = await this.create({
                user: userId,
                reference: sequenceId,
                amount: Math.round(amount * 100) / 100,
                fromCurrency,
                currency: toCurrency,
                detailType: DETAIL_TYPE.YELLOWCARD,
                status: TRANSACTION_STATUS.PENDING,
                initiatedAt: Date.now(),
                lockedRate,
                lockedRateFromCurrency: 'NGN',
                lockedRateToCurrency: toCurrency,
                lockedRateAt: new Date(),
            });
        } catch (dbError: any) {
            logger.error("Failed to create YellowCard transaction record, refunding wallet", {
                error: dbError?.message || dbError,
                sequenceId,
            });
            // Refund wallet since we couldn't create the transaction
            await this.refundWallet(wallet._id, userId, totalDebit, walletTransaction._id, walletTxRef, "Transaction record creation failed", feeAmount);
            throw errorResponseMessage.createError(
                500,
                `Failed to create transaction: ${dbError?.message || 'Unknown error'}`,
                ErrorSeverity.CRITICAL
            );
        }

        // Link wallet transaction to the YellowCard transaction
        await this.walletTransactionService.updateById(walletTransaction._id as string, {
            paystackReference: sequenceId, // reuse field to link to YC transaction
        });

        if (idempotencyKey) {
            await this.idempotencyService.updateKeyWithTransaction(idempotencyKey, transaction._id.toString());
        }

        // Create transaction detail with YC-specific fields (channelId updated after successful submission)
        try {
            transactionDetails = await this.transactionDetailsService.create({
                transactionId: transaction._id,
                type: DETAIL_TYPE.YELLOWCARD,
                ycSequenceId: sequenceId,
                ycChannelId: sortedChannels[0].id,
                ycNetworkId: network.id,
                ycStatus: YELLOWCARD_STATUS.PENDING,
                fromAmount: totalDebit,
                feeAmount,
                feePercent,
                providerFeePercent,
                markupPercent,
                accountName: destination.accountName,
                accountNumber: destination.accountNumber,
                institutionType: destination.accountType,
                country: destination.country,
            });
        } catch (dbError: any) {
            logger.error("Failed to create YellowCard transaction detail", {
                error: dbError?.message || dbError,
                transactionId: transaction._id,
                sequenceId,
            });
            throw errorResponseMessage.createError(
                500,
                `Failed to create transaction detail: ${dbError?.message || 'Unknown error'}`,
                ErrorSeverity.CRITICAL
            );
        }

        // Try each active channel until one succeeds
        let lastError: any = null;
        for (const channel of sortedChannels) {
            try {
                logger.info("YellowCard: attempting payment with channel", {
                    channelId: channel.id,
                    channelType: channel.channelType,
                    sequenceId,
                });

                const paymentResponse = await yellowCardService.submitPaymentRequest({
                    channelId: channel.id,
                    sequenceId,
                    localAmount: amount,
                    sender,
                    destination: {
                        accountName: destination.accountName,
                        accountNumber: destination.accountNumber,
                        accountType: destination.accountType,
                        networkId: network.id,
                        country: destination.country,
                    },
                    forceAccept: true,
                });

                // Success — update detail with the channel that worked
                await this.transactionDetailsService.update(
                    { transactionId: transaction._id },
                    {
                        ycChannelId: channel.id,
                        ycPaymentId: paymentResponse?.id,
                        ycStatus: paymentResponse?.status || YELLOWCARD_STATUS.PROCESSING,
                        ycRawPayload: paymentResponse,
                    }
                );

                await this.updateById(transaction._id.toString(), {
                    status: TRANSACTION_STATUS.PROCESSING,
                });

                // Mark wallet transaction as processing (payment submitted to YellowCard)
                await this.walletTransactionService.updateById(walletTransaction._id as string, {
                    status: WALLET_TRANSACTION_STATUS.PROCESSING,
                });

                logger.info("YellowCard transaction created and payment submitted", {
                    transactionId: transaction._id,
                    sequenceId,
                    channelId: channel.id,
                    ycPaymentId: paymentResponse?.id,
                    walletDebit: ngnAmount,
                });

                return {
                    ...transaction.toObject(),
                    status: TRANSACTION_STATUS.PROCESSING,
                    details: {
                        ...transactionDetails.toObject(),
                        ycChannelId: channel.id,
                        ycPaymentId: paymentResponse?.id,
                        ycStatus: paymentResponse?.status || YELLOWCARD_STATUS.PROCESSING,
                    },
                };
            } catch (error: any) {
                const ycError = error?.ycError || error?.response?.data || error?.data;
                const ycMessage = ycError?.message || error?.message || '';

                logger.warn("YellowCard channel failed, trying next", {
                    channelId: channel.id,
                    error: ycMessage,
                    remainingChannels: sortedChannels.indexOf(channel) < sortedChannels.length - 1,
                });

                lastError = error;

                // If the error is NOT channel-related (e.g. invalid account), don't retry
                const isChannelError = ycMessage.toLowerCase().includes('channel') && ycMessage.toLowerCase().includes('disabled');
                if (!isChannelError) {
                    break; // No point trying other channels for non-channel errors
                }
            }
        }

        // All channels failed — mark transaction as failed and REFUND wallet
        await this.updateById(transaction._id.toString(), {
            status: TRANSACTION_STATUS.FAILED,
            failedAt: new Date(),
        });
        await this.transactionDetailsService.update(
            { transactionId: transaction._id },
            { ycStatus: YELLOWCARD_STATUS.FAILED }
        );

        // Refund wallet balance
        await this.refundWallet(wallet._id, userId, totalDebit, walletTransaction._id, walletTxRef, "YellowCard payment failed on all channels", feeAmount);

        const ycError = lastError?.ycError || lastError?.response?.data || lastError?.data;
        logger.error("YellowCard payment submission failed on all channels — wallet refunded", {
            transactionId: transaction._id,
            sequenceId,
            ycError,
            errorMessage: lastError?.message,
            refundedAmount: totalDebit,
        });

        const ycMessage = ycError?.message || ycError?.code || lastError?.message || "YellowCard payment failed";
        throw errorResponseMessage.createError(
            400,
            `YellowCard: ${ycMessage}`,
            ErrorSeverity.HIGH
        );
    };

    /**
     * Refund wallet balance when a YellowCard transaction fails. Credits back
     * the debited amount, posts a balanced reversal journal entry, and creates
     * a reversal wallet-transaction record.
     */
    private refundWallet = async (
        walletId: any,
        userId: string,
        amount: number,
        walletTransactionId: any,
        originalRef: string,
        reason: string,
        feeAmount: number = 0,
    ) => {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            // Credit back the balance (in the same session as the journal post).
            const updated = await this.walletService.creditBalance(walletId as string, amount, session) as any;
            const balanceAfter = updated?.balance || 0;

            // Reverse the original YC_SEND posting: pull funds back from
            // YC_FLOAT_NGN (converted portion) and FEES_NGN (fee portion)
            // into the user's wallet liability.
            const convertedPortion = amount - feeAmount;
            const userAccountCode = userWalletAccountCode(userId, 'NGN');
            const legs: Array<{ accountCode: string; direction: any; amount: number }> = [
                { accountCode: SYSTEM_ACCOUNT_CODES.YC_FLOAT_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: convertedPortion },
                { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.CREDIT, amount },
            ];
            if (feeAmount > 0) {
                legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: feeAmount });
            }
            await ledgerService.post({
                legs,
                source: JOURNAL_SOURCE.REVERSAL,
                reference: originalRef,
                description: `Reversal — YC send refund (${reason})`,
                externalRef: { provider: WEBHOOK_PROVIDER.YELLOWCARD, id: originalRef },
                metadata: { reverses: originalRef, reason, feeAmount },
                session,
            });

            // Mark original wallet transaction as failed
            await this.walletTransactionService.updateById(walletTransactionId as string, {
                status: WALLET_TRANSACTION_STATUS.FAILED,
                failureReason: reason,
            });

            // Create reversal record
            const reversalRef = this.walletTransactionService.generateReference('REV');
            await this.walletTransactionService.create({
                wallet: walletId,
                user: userId,
                type: WALLET_TRANSACTION_TYPE.REVERSAL,
                status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                amount,
                reference: reversalRef,
                balanceBefore: balanceAfter - amount,
                balanceAfter,
                description: `Reversal: ${reason} (${originalRef})`,
            }, session);

            await session.commitTransaction();
            logger.info("Wallet refunded for failed YellowCard transaction", {
                walletId, amount, reason, originalRef,
            });
        } catch (refundError: any) {
            if (session.inTransaction()) await session.abortTransaction();
            // Critical: refund failed — log for manual intervention
            logger.error("CRITICAL: Wallet refund failed", {
                walletId, userId, amount, originalRef,
                error: refundError?.message,
            });
        } finally {
            session.endSession();
        }
    };

    /**
     * Poll YellowCard for the current payment status and sync to local transaction.
     * Used when webhooks aren't available (e.g. localhost development).
     */
    public pollYellowCardStatus = async (transactionId: string) => {
        const transaction = await this.findById(transactionId);
        if (!transaction) {
            throw errorResponseMessage.createError(404, "Transaction not found", ErrorSeverity.MEDIUM);
        }
        if (transaction.detailType !== DETAIL_TYPE.YELLOWCARD) {
            throw errorResponseMessage.createError(400, "Not a YellowCard transaction", ErrorSeverity.MEDIUM);
        }

        const detail = await this.transactionDetailsService.findOne({ transactionId: transaction._id });
        if (!detail?.ycSequenceId) {
            throw errorResponseMessage.createError(400, "No YellowCard sequence ID found", ErrorSeverity.MEDIUM);
        }

        // Lookup payment status from YellowCard
        let ycPayment: any;
        try {
            ycPayment = await yellowCardService.lookupPaymentBySequenceId(detail.ycSequenceId);
        } catch (error: any) {
            logger.error("Failed to poll YellowCard payment status", {
                transactionId,
                sequenceId: detail.ycSequenceId,
                error: error?.ycError || error?.message,
            });
            return {
                transaction: transaction.toObject(),
                ycStatus: detail.ycStatus || "unknown",
                message: "Could not fetch status from YellowCard",
            };
        }

        // YellowCard may return { status: "..." } directly or nested like { payment: { status: "..." } }
        const rawPayment = ycPayment?.payment || ycPayment?.data || ycPayment;
        const ycStatus = (rawPayment?.status || '')?.toLowerCase();

        logger.info("YellowCard poll: raw response", {
            transactionId,
            sequenceId: detail.ycSequenceId,
            ycPaymentTopLevelKeys: ycPayment ? Object.keys(ycPayment) : [],
            rawPaymentStatus: rawPayment?.status,
            ycStatusResolved: ycStatus,
            localStatus: transaction.status,
            ycPaymentRaw: JSON.stringify(ycPayment).substring(0, 800),
        });

        // Update local detail with latest YC data
        await this.transactionDetailsService.update(
            { _id: detail._id },
            { ycRawPayload: ycPayment, ycStatus, ycPaymentId: ycPayment?.id || detail.ycPaymentId }
        );

        // Sync transaction status based on YC status
        // YellowCard uses "complete" (not "completed")
        logger.info("YellowCard poll: status sync check", {
            transactionId,
            ycStatus,
            localStatus: transaction.status,
            ycStatusIsComplete: ycStatus === "complete" || ycStatus === "completed",
            localIsNotCompleted: transaction.status !== TRANSACTION_STATUS.COMPLETED,
            TRANSACTION_STATUS_COMPLETED: TRANSACTION_STATUS.COMPLETED,
        });

        if ((ycStatus === "complete" || ycStatus === "completed") && transaction.status !== TRANSACTION_STATUS.COMPLETED) {
            const canTransition = transactionStateMachine.canTransition(transaction.status, TRANSACTION_STATUS.COMPLETED);
            logger.info("YellowCard poll: attempting completed transition", {
                transactionId,
                fromStatus: transaction.status,
                toStatus: TRANSACTION_STATUS.COMPLETED,
                canTransition,
            });
            if (canTransition) {
                try {
                    const updateResult = await this.updateById(transactionId, {
                        status: TRANSACTION_STATUS.COMPLETED,
                        completedAt: new Date(),
                    });
                    logger.info("YellowCard poll: updateById result", {
                        transactionId,
                        updateResultStatus: updateResult?.status,
                        updateResultId: updateResult?._id?.toString(),
                    });
                } catch (updateError: any) {
                    logger.error("YellowCard poll: updateById FAILED, trying direct update", {
                        transactionId,
                        error: updateError?.message,
                    });
                    // Fallback: direct Mongoose update
                    await this.Model.updateOne(
                        { _id: transactionId },
                        { $set: { status: TRANSACTION_STATUS.COMPLETED, completedAt: new Date() } }
                    );
                    logger.info("YellowCard poll: direct update completed", { transactionId });
                }

                logger.info("YellowCard poll: transaction completed", { transactionId });

                // Mark linked wallet transaction as successful
                const walletTx = await this.walletTransactionService.findOne({
                    paystackReference: transaction.reference,
                    type: WALLET_TRANSACTION_TYPE.TRANSFER,
                });
                if (walletTx && walletTx.status !== WALLET_TRANSACTION_STATUS.SUCCESSFUL) {
                    await this.walletTransactionService.updateById(walletTx._id as string, {
                        status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                    });
                    await this.walletService.adjustLedgerBalance(walletTx.wallet as string, -walletTx.amount);
                    logger.info("Wallet transfer marked successful via poll", { walletTxId: walletTx._id, amount: walletTx.amount });
                }

                // Notify user
                const user = transaction.user as IUser;
                if (user?.email) {
                    try {
                        await this.notificationService.sendTransactionNotification(
                            user,
                            "payment_completed",
                            {
                                amount: `${transaction.amount} ${transaction.currency}`,
                                reference: transaction.reference,
                                recipient: detail.accountName || "Recipient",
                                actionUrl: `${config.FRONTEND_URL}/dashboard/user/payments`,
                            }
                        );
                    } catch (e) {
                        logger.warn("Failed to send YC poll completion notification", { error: e });
                    }
                }
            } else {
                logger.warn("YellowCard poll: canTransition returned false!", {
                    transactionId,
                    fromStatus: transaction.status,
                    toStatus: TRANSACTION_STATUS.COMPLETED,
                });
            }
        } else if ((ycStatus === "failed" || ycStatus === "expired" || ycStatus === "refunded") && transaction.status !== TRANSACTION_STATUS.FAILED) {
            const newStatus = ycStatus === "cancelled" ? TRANSACTION_STATUS.CANCELLED : TRANSACTION_STATUS.FAILED;
            if (transactionStateMachine.canTransition(transaction.status, newStatus)) {
                await this.updateById(transactionId, {
                    status: newStatus,
                    ...(newStatus === TRANSACTION_STATUS.FAILED ? { failedAt: new Date() } : {}),
                });

                // Refund wallet on failure
                const walletTx = await this.walletTransactionService.findOne({
                    paystackReference: transaction.reference,
                    type: WALLET_TRANSACTION_TYPE.TRANSFER,
                });
                if (walletTx && walletTx.status !== WALLET_TRANSACTION_STATUS.FAILED && walletTx.status !== WALLET_TRANSACTION_STATUS.REVERSED) {
                    const ycDetail = await this.transactionDetailsService.findOne({ transactionId: transaction._id });
                    const fee = (ycDetail as any)?.feeAmount || 0;
                    await this.refundWallet(
                        walletTx.wallet,
                        walletTx.user as string,
                        walletTx.amount,
                        walletTx._id,
                        walletTx.reference,
                        `YellowCard payment ${ycStatus}`,
                        fee,
                    );
                    logger.info("Wallet refunded via poll", { walletTxId: walletTx._id, amount: walletTx.amount });
                }

                logger.info("YellowCard poll: transaction failed/cancelled", { transactionId, ycStatus });
            }
        } else {
            logger.info("YellowCard poll: no status change needed", {
                transactionId,
                ycStatus,
                localStatus: transaction.status,
            });
        }

        const updatedTransaction = await this.findById(transactionId);
        logger.info("YellowCard poll: final transaction status", {
            transactionId,
            finalStatus: updatedTransaction?.status,
        });
        return {
            transaction: updatedTransaction?.toObject(),
            ycStatus,
            ycPayment,
        };
    };

    // ===================== YELLOWCARD COLLECTION (RECEIVE) =====================

    /**
     * Create a YellowCard collection transaction (receive money).
     * Sender pays in foreign currency → YellowCard collects → NGN credited to user's wallet.
     */
    public createYellowCardCollectionTransaction = async (
        params: {
            amount: number;          // Amount in foreign currency (what sender pays)
            fromAmount?: number;     // NGN equivalent (what user receives)
            fromCurrency: string;    // Foreign currency (KES, GHS, XAF)
            toCurrency: string;      // NGN (user's wallet currency)
            sender: {
                name: string;
                country: string;
                phone: string;
                address: string;
                dob: string;
                email: string;
                idNumber?: string;
                idType?: string;
            };
            destination?: {
                accountName?: string;
                accountNumber?: string;
                accountType?: string;
                country?: string;
            };
            idempotencyKey?: string;
        },
        userId: string,
    ) => {
        const { amount, fromCurrency, toCurrency, sender, destination, idempotencyKey } = params;

        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }

        // Server-side rate + fee for the collection. The user receives
        // `gross − fee` NGN at the markup-adjusted (receive) rate.
        let providerRate: number;
        let userRate: number;
        try {
            providerRate = await yellowCardService.getImpliedRate(fromCurrency, toCurrency, 'receive');
            userRate = await platformSettingsService.applyRateMarkup(providerRate, 'receive');
        } catch (err: any) {
            logger.error("YellowCard rate lookup failed during collection", { fromCurrency, toCurrency, error: err?.message });
            throw errorResponseMessage.createError(400, `Could not retrieve the ${fromCurrency}→${toCurrency} rate from YellowCard. Please try again.`, ErrorSeverity.HIGH);
        }
        const grossNgn = Math.round(amount * userRate * 100) / 100;
        const { feeAmount, feePercent, providerFeePercent } = await platformSettingsService.computeFee('yellowcard', grossNgn);
        const ngnAmount = Math.round((grossNgn - feeAmount) * 100) / 100;
        if (ngnAmount <= 0) {
            throw errorResponseMessage.createError(400, "Fee exceeds the converted amount. Please increase the amount.", ErrorSeverity.MEDIUM);
        }
        const markupPercent = (await platformSettingsService.getSettings()).rateMarkupPercent;

        // Handle idempotency
        if (idempotencyKey) {
            const idempotencyResult = await this.idempotencyService.validateKey(idempotencyKey, userId);
            if (idempotencyResult.isDuplicate && idempotencyResult.transactionId) {
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

        // Resolve channels/networks for the SENDER's country (where collection happens)
        const senderCountry = sender.country;
        const targetType = destination?.accountType || 'momo';

        let channelsData: any;
        let networksData: any;
        try {
            [channelsData, networksData] = await Promise.all([
                yellowCardService.getChannels(senderCountry),
                yellowCardService.getNetworks(senderCountry),
            ]);
        } catch (error: any) {
            logger.error("Failed to fetch YellowCard channels/networks for collection", { senderCountry, error: error?.message });
            throw errorResponseMessage.createError(400, "Unable to fetch payment channels. Please try again.", ErrorSeverity.HIGH);
        }

        const allChannels = channelsData?.channels || channelsData || [];
        const allNetworks = networksData?.networks || networksData || [];

        // Collections require on-ramp/deposit channels
        const isCollectionChannel = (c: any) => {
            const rt = (c.rampType || '').toLowerCase();
            return rt === 'deposit' || rt === 'on' || rt === 'onramp' || rt === 'on-ramp';
        };
        const activeChannels = allChannels.filter((c: any) => c.status === 'active' && isCollectionChannel(c));
        const sortedChannels = [
            ...activeChannels.filter((c: any) => c.channelType === targetType),
            ...activeChannels.filter((c: any) => c.channelType !== targetType),
        ];

        const activeNetworks = allNetworks.filter((n: any) => n.status === 'active');
        const network = activeNetworks.find((n: any) => n.type === targetType) || activeNetworks[0];

        if (sortedChannels.length === 0) {
            logger.error("No active on-ramp channels found for collection", {
                senderCountry,
                targetType,
                totalChannels: allChannels.length,
                activeOnRampCount: activeChannels.length,
                allChannelDetails: allChannels.map((c: any) => ({ id: c.id, rampType: c.rampType, status: c.status, channelType: c.channelType, apiStatus: c.apiStatus })),
            });
            throw errorResponseMessage.createError(
                400,
                "Collection is not available for this currency at the moment.",
                ErrorSeverity.MEDIUM
            );
        }

        const sequenceId = this.generateYellowCardSequenceId();

        // Create internal transaction record
        let transaction: any;
        let transactionDetails: any;
        try {
            transaction = await this.create({
                user: userId,
                reference: sequenceId,
                amount: Math.round(amount * 100) / 100,
                fromCurrency,
                currency: toCurrency,
                detailType: DETAIL_TYPE.YELLOWCARD,
                status: TRANSACTION_STATUS.PENDING,
                initiatedAt: Date.now(),
                lockedRate: userRate,
                lockedRateFromCurrency: fromCurrency,
                lockedRateToCurrency: toCurrency,
                lockedRateAt: new Date(),
            });
        } catch (dbError: any) {
            logger.error("Failed to create collection transaction record", { error: dbError?.message, sequenceId });
            throw errorResponseMessage.createError(500, `Failed to create transaction: ${dbError?.message || 'Unknown error'}`, ErrorSeverity.CRITICAL);
        }

        if (idempotencyKey) {
            await this.idempotencyService.updateKeyWithTransaction(idempotencyKey, transaction._id.toString());
        }

        try {
            transactionDetails = await this.transactionDetailsService.create({
                transactionId: transaction._id,
                type: DETAIL_TYPE.YELLOWCARD,
                ycSequenceId: sequenceId,
                ycChannelId: sortedChannels[0]?.id,
                ycNetworkId: network?.id,
                ycStatus: YELLOWCARD_STATUS.PENDING,
                fromAmount: ngnAmount,
                feeAmount,
                feePercent,
                providerFeePercent,
                markupPercent,
                accountName: destination?.accountName,
                accountNumber: destination?.accountNumber,
                institutionType: destination?.accountType,
                country: senderCountry,
            });
        } catch (dbError: any) {
            logger.error("Failed to create collection transaction detail", { error: dbError?.message, sequenceId });
            throw errorResponseMessage.createError(500, `Failed to create transaction detail: ${dbError?.message || 'Unknown error'}`, ErrorSeverity.CRITICAL);
        }

        // Try each channel for the collection
        let lastError: any = null;
        for (const channel of sortedChannels) {
            try {
                logger.info("YellowCard: attempting collection with channel", {
                    channelId: channel.id,
                    channelType: channel.channelType,
                    sequenceId,
                });

                const collectionResponse = await yellowCardService.submitCollectionRequest({
                    channelId: channel.id,
                    sequenceId,
                    localAmount: amount,
                    sender,
                    destination: destination ? {
                        accountName: destination.accountName,
                        accountNumber: destination.accountNumber,
                        accountType: destination.accountType,
                        networkId: network?.id,
                    } : undefined,
                    forceAccept: true,
                });

                // Success — update detail
                await this.transactionDetailsService.update(
                    { transactionId: transaction._id },
                    {
                        ycChannelId: channel.id,
                        ycCollectionId: collectionResponse?.id,
                        ycStatus: collectionResponse?.status || YELLOWCARD_STATUS.PROCESSING,
                        ycRawPayload: collectionResponse,
                    }
                );

                await this.updateById(transaction._id.toString(), {
                    status: TRANSACTION_STATUS.PROCESSING,
                });

                logger.info("YellowCard collection created", {
                    transactionId: transaction._id,
                    sequenceId,
                    channelId: channel.id,
                    ycCollectionId: collectionResponse?.id,
                });

                return {
                    ...transaction.toObject(),
                    status: TRANSACTION_STATUS.PROCESSING,
                    details: {
                        ...transactionDetails.toObject(),
                        ycChannelId: channel.id,
                        ycCollectionId: collectionResponse?.id,
                        ycStatus: collectionResponse?.status || YELLOWCARD_STATUS.PROCESSING,
                    },
                };
            } catch (error: any) {
                const ycError = error?.ycError || error?.response?.data || error?.data;
                const ycMessage = ycError?.message || error?.message || '';
                logger.warn("YellowCard collection channel failed", {
                    channelId: channel.id,
                    error: ycMessage,
                });
                lastError = error;

                const isChannelError = ycMessage.toLowerCase().includes('channel') && ycMessage.toLowerCase().includes('disabled');
                if (!isChannelError) break;
            }
        }

        // All channels failed
        await this.updateById(transaction._id.toString(), { status: TRANSACTION_STATUS.FAILED, failedAt: new Date() });
        await this.transactionDetailsService.update({ transactionId: transaction._id }, { ycStatus: YELLOWCARD_STATUS.FAILED });

        const ycError = lastError?.ycError || lastError?.response?.data || lastError?.data;
        const ycMessage = ycError?.message || ycError?.code || lastError?.message || "Collection request failed";
        throw errorResponseMessage.createError(400, `YellowCard: ${ycMessage}`, ErrorSeverity.HIGH);
    };

    /**
     * Poll YellowCard for collection status and sync to local transaction.
     * When collection completes, credits the user's wallet with the NGN equivalent.
     */
    public pollYellowCardCollectionStatus = async (transactionId: string) => {
        const transaction = await this.findById(transactionId);
        if (!transaction) {
            throw errorResponseMessage.createError(404, "Transaction not found", ErrorSeverity.MEDIUM);
        }

        const detail = await this.transactionDetailsService.findOne({ transactionId: transaction._id });
        if (!detail?.ycSequenceId) {
            throw errorResponseMessage.createError(400, "No YellowCard sequence ID found", ErrorSeverity.MEDIUM);
        }

        // Try lookup by collection ID first, then by sequence ID
        let ycCollection: any;
        try {
            if (detail.ycCollectionId) {
                ycCollection = await yellowCardService.lookupCollection(detail.ycCollectionId);
            } else {
                ycCollection = await yellowCardService.lookupCollectionBySequenceId(detail.ycSequenceId);
            }
        } catch (error: any) {
            logger.error("Failed to poll YellowCard collection status", {
                transactionId,
                sequenceId: detail.ycSequenceId,
                error: error?.ycError || error?.message,
            });
            return {
                transaction: transaction.toObject(),
                ycStatus: detail.ycStatus || "unknown",
                message: "Could not fetch status from YellowCard",
            };
        }

        const rawCollection = ycCollection?.collection || ycCollection?.data || ycCollection;
        const ycStatus = (rawCollection?.status || '')?.toLowerCase();

        logger.info("YellowCard collection poll", {
            transactionId,
            sequenceId: detail.ycSequenceId,
            ycStatus,
            localStatus: transaction.status,
        });

        // Update local detail
        await this.transactionDetailsService.update(
            { _id: detail._id },
            { ycRawPayload: ycCollection, ycStatus, ycCollectionId: rawCollection?.id || detail.ycCollectionId }
        );

        // Handle completed collection → credit wallet
        if ((ycStatus === "complete" || ycStatus === "completed") && transaction.status !== TRANSACTION_STATUS.COMPLETED) {
            const canTransition = transactionStateMachine.canTransition(transaction.status, TRANSACTION_STATUS.COMPLETED);
            if (canTransition) {
                await this.updateById(transactionId, {
                    status: TRANSACTION_STATUS.COMPLETED,
                    completedAt: new Date(),
                });

                // Credit user's wallet with the NGN equivalent
                await this.creditWalletFromCollection(transaction, detail);

                logger.info("YellowCard collection completed, wallet credited", { transactionId });

                // Notify user
                const user = transaction.user as IUser;
                if (user?.email) {
                    try {
                        await this.notificationService.sendTransactionNotification(
                            user,
                            "payment_completed",
                            {
                                amount: `${detail.fromAmount || transaction.amount} NGN`,
                                reference: transaction.reference,
                                recipient: "Your Wallet",
                                actionUrl: `${config.FRONTEND_URL}/dashboard/user/wallet`,
                            }
                        );
                    } catch (e) {
                        logger.warn("Failed to send collection completion notification", { error: e });
                    }
                }
            }
        } else if ((ycStatus === "failed" || ycStatus === "expired" || ycStatus === "cancelled") && transaction.status !== TRANSACTION_STATUS.FAILED) {
            const newStatus = ycStatus === "cancelled" ? TRANSACTION_STATUS.CANCELLED : TRANSACTION_STATUS.FAILED;
            if (transactionStateMachine.canTransition(transaction.status, newStatus)) {
                await this.updateById(transactionId, {
                    status: newStatus,
                    ...(newStatus === TRANSACTION_STATUS.FAILED ? { failedAt: new Date() } : {}),
                });
            }
        }

        const updatedTransaction = await this.findById(transactionId);
        return {
            transaction: updatedTransaction?.toObject(),
            ycStatus,
            ycCollection,
        };
    };

    /**
     * Credit user's wallet when a YellowCard collection completes.
     * The NGN amount is stored in detail.fromAmount (for receive: fromAmount is the NGN equivalent).
     */
    private creditWalletFromCollection = async (transaction: any, detail: any) => {
        const userId = typeof transaction.user === 'object' ? transaction.user._id?.toString() : transaction.user?.toString();
        // detail.fromAmount is the NET NGN amount credited to the user (fee
        // already deducted). The platform receives the GROSS = net + fee from
        // the rail and books the fee into FEES_NGN.
        const ngnAmount = detail.fromAmount || transaction.amount;
        const feeAmount = detail.feeAmount || 0;
        const grossNgn = Math.round((ngnAmount + feeAmount) * 100) / 100;

        try {
            const wallet = await this.walletService.findOne({ user: userId });
            if (!wallet) {
                logger.error("Wallet not found for collection credit", { userId });
                return;
            }

            // Make sure the user's ledger account exists.
            await this.walletService.getOrCreateWallet(userId);

            const session = await mongoose.startSession();
            session.startTransaction();
            try {
                // Credit wallet in the same session as the journal posting.
                await this.walletService.creditBalance(wallet._id as string, ngnAmount, session);

                // Post journal: YellowCard float decreases by the gross; the
                // user's wallet receives the net; the fee lands in FEES_NGN.
                const userAccountCode = userWalletAccountCode(userId, wallet.currency);
                const legs: Array<{ accountCode: string; direction: any; amount: number }> = [
                    { accountCode: SYSTEM_ACCOUNT_CODES.YC_FLOAT_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: grossNgn },
                    { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.CREDIT, amount: ngnAmount },
                ];
                if (feeAmount > 0) {
                    legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: feeAmount });
                }
                await ledgerService.post({
                    legs,
                    source: JOURNAL_SOURCE.YC_COLLECT,
                    reference: transaction.reference,
                    description: `Collection settled — ${transaction.amount} ${transaction.fromCurrency} → ₦${ngnAmount.toFixed(2)} (fee ₦${feeAmount.toFixed(2)})`,
                    externalRef: { provider: WEBHOOK_PROVIDER.YELLOWCARD, id: transaction.reference },
                    metadata: { fromAmount: transaction.amount, fromCurrency: transaction.fromCurrency, feeAmount, grossNgn },
                    session,
                });

                // Create wallet funding transaction
                const ref = this.walletTransactionService.generateReference('COL');
                await this.walletTransactionService.create({
                    wallet: wallet._id,
                    user: userId,
                    type: WALLET_TRANSACTION_TYPE.FUNDING,
                    status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                    amount: ngnAmount,
                    reference: ref,
                    balanceBefore: wallet.balance,
                    balanceAfter: wallet.balance + ngnAmount,
                    description: `Received ${transaction.amount} ${transaction.fromCurrency} → ₦${ngnAmount.toLocaleString()}`,
                    paystackReference: transaction.reference, // Link to YC transaction
                }, session);

                // Update ledger balance projection
                await this.walletService.adjustLedgerBalance(wallet._id as string, ngnAmount, session);

                await session.commitTransaction();
            } catch (sessionError) {
                if (session.inTransaction()) await session.abortTransaction();
                throw sessionError;
            } finally {
                session.endSession();
            }

            logger.info("Wallet credited from collection", {
                userId,
                walletId: wallet._id,
                ngnAmount,
                foreignAmount: transaction.amount,
                foreignCurrency: transaction.fromCurrency,
            });
        } catch (error: any) {
            logger.error("CRITICAL: Failed to credit wallet from collection", {
                userId,
                transactionId: transaction._id,
                ngnAmount,
                error: error?.message,
            });
        }
    };

    /**
     * Handle YellowCard webhook callback for payment status updates.
     * Called by the webhook controller after signature verification.
     */
    public handleYellowCardWebhook = async (webhookData: any) => {
        const { event, data } = webhookData;

        if (!data?.sequenceId) {
            logger.warn("YellowCard webhook missing sequenceId", { event });
            return;
        }

        // Look up transaction detail by sequenceId
        const detail = await this.transactionDetailsService.findOne({ ycSequenceId: data.sequenceId });
        if (!detail) {
            logger.warn("YellowCard webhook: no matching transaction detail", { sequenceId: data.sequenceId });
            return;
        }

        const transactionId = detail.transactionId.toString();
        const transaction = await this.findById(transactionId);
        if (!transaction) {
            logger.warn("YellowCard webhook: no matching transaction", { transactionId });
            return;
        }

        const status = data.status?.toLowerCase();

        // Update the raw payload
        await this.transactionDetailsService.update(
            { _id: detail._id },
            { ycRawPayload: data, ycStatus: status }
        );

        // Helper: find the wallet transaction linked to this YellowCard transaction
        const findLinkedWalletTx = async () => {
            return this.walletTransactionService.findOne({
                paystackReference: transaction.reference, // linked via sequenceId
                type: WALLET_TRANSACTION_TYPE.TRANSFER,
            });
        };

        // Handle payment completed
        if (event === "payment.completed" || event === "payment.complete" || status === "complete" || status === "completed") {
            logger.info("YellowCard payment completed", { transactionId });

            await this.updateById(transactionId, {
                status: TRANSACTION_STATUS.COMPLETED,
                completedAt: new Date(),
            });
            await this.transactionDetailsService.update(
                { _id: detail._id },
                { ycStatus: YELLOWCARD_STATUS.COMPLETED }
            );

            // Mark wallet transaction as successful
            const walletTx = await findLinkedWalletTx();
            if (walletTx) {
                await this.walletTransactionService.updateById(walletTx._id as string, {
                    status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                });
                // Update ledger balance
                await this.walletService.adjustLedgerBalance(walletTx.wallet as string, -walletTx.amount);
            }

            // Notify user
            const user = transaction.user as IUser;
            if (user?.email) {
                try {
                    await this.notificationService.sendTransactionNotification(
                        user,
                        "payment_completed",
                        {
                            amount: `${transaction.amount} ${transaction.currency}`,
                            reference: transaction.reference,
                            recipient: detail.accountName || "Recipient",
                            actionUrl: `${config.FRONTEND_URL}/dashboard/user/payments`,
                        }
                    );
                } catch (e) {
                    logger.warn("Failed to send YC completion notification", { error: e });
                }
            }
            return;
        }

        // Handle failures
        if (status === "failed" || status === "cancelled" || status === "expired" || status === "refunded") {
            const newStatus = status === "cancelled" ? TRANSACTION_STATUS.CANCELLED : TRANSACTION_STATUS.FAILED;

            if (transactionStateMachine.canTransition(transaction.status, newStatus)) {
                await this.updateById(transactionId, {
                    status: newStatus,
                    ...(newStatus === TRANSACTION_STATUS.FAILED ? { failedAt: new Date() } : {}),
                });
            }
            await this.transactionDetailsService.update(
                { _id: detail._id },
                { ycStatus: status }
            );

            // Refund wallet on YellowCard failure
            const walletTx = await findLinkedWalletTx();
            if (walletTx && walletTx.status !== WALLET_TRANSACTION_STATUS.FAILED && walletTx.status !== WALLET_TRANSACTION_STATUS.REVERSED) {
                const fee = (detail as any)?.feeAmount || 0;
                await this.refundWallet(
                    walletTx.wallet,
                    walletTx.user as string,
                    walletTx.amount,
                    walletTx._id,
                    walletTx.reference,
                    `YellowCard payment ${status}`,
                    fee,
                );
            }

            logger.info("YellowCard transaction failed/cancelled — wallet refunded", {
                transactionId,
                ycStatus: status,
            });
            return;
        }

        // Handle collection events (receive money)
        if (event?.startsWith("collection.")) {
            const isReceive = transaction.currency === 'NGN' && transaction.fromCurrency !== 'NGN';
            if ((event === "collection.completed" || event === "collection.complete" || status === "complete" || status === "completed") && isReceive) {
                if (transactionStateMachine.canTransition(transaction.status, TRANSACTION_STATUS.COMPLETED)) {
                    await this.updateById(transactionId, {
                        status: TRANSACTION_STATUS.COMPLETED,
                        completedAt: new Date(),
                    });
                    await this.transactionDetailsService.update(
                        { _id: detail._id },
                        { ycStatus: YELLOWCARD_STATUS.COMPLETED }
                    );

                    // Credit wallet
                    await this.creditWalletFromCollection(transaction, detail);
                    logger.info("YellowCard collection completed via webhook, wallet credited", { transactionId });
                }
                return;
            }
        }

        // For other statuses (processing, pending, etc.), just update the YC status
        logger.info("YellowCard webhook status update", {
            transactionId,
            event,
            ycStatus: status,
        });
    };

    // ============================================================================
    // OGateway — Ghana instant send + receive
    // ============================================================================

    private generateOGatewaySequenceId = () => {
        const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 22).toUpperCase();
        return `OG_TX_${randomPart}`;
    };

    /**
     * Refund the user's NGN wallet after a failed OGateway payout, reversing the
     * original OG_SEND posting (debit OG_PAYMENT_INFLIGHT_GHS, credit user wallet).
     */
    private refundWalletFromOGateway = async (
        walletId: any,
        userId: string,
        ngnAmount: number,
        ghsAmount: number,
        walletTransactionId: any,
        originalRef: string,
        reason: string,
        feeAmount: number = 0,
    ) => {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            const updated = await this.walletService.creditBalance(walletId as string, ngnAmount, session) as any;
            const balanceAfter = updated?.balance || 0;

            // Mirror the original posting in reverse: refund covers both the
            // converted-amount leg (OG_PAYMENT_INFLIGHT) and the fee leg
            // (FEES_NGN). ngnAmount here is the total wallet debit, so the
            // legs add up: ghsAmount + feeAmount = ngnAmount.
            const convertedPortion = ngnAmount - feeAmount;
            const userAccountCode = userWalletAccountCode(userId, 'NGN');
            const legs: Array<{ accountCode: string; direction: any; amount: number }> = [
                { accountCode: ogPaymentInflightCode('GHS'), direction: JOURNAL_DIRECTION.DEBIT, amount: convertedPortion },
                { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.CREDIT, amount: ngnAmount },
            ];
            if (feeAmount > 0) {
                legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: feeAmount });
            }
            await ledgerService.post({
                legs,
                source: JOURNAL_SOURCE.REVERSAL,
                reference: originalRef,
                description: `Reversal — OGateway send refund (${reason})`,
                externalRef: { provider: WEBHOOK_PROVIDER.OGATEWAY, id: originalRef },
                metadata: { reverses: originalRef, reason, ghsAmount, ngnAmount, feeAmount },
                session,
            });

            await this.walletTransactionService.updateById(walletTransactionId as string, {
                status: WALLET_TRANSACTION_STATUS.FAILED,
                failureReason: reason,
            });

            const reversalRef = this.walletTransactionService.generateReference('REV');
            await this.walletTransactionService.create({
                wallet: walletId,
                user: userId,
                type: WALLET_TRANSACTION_TYPE.REVERSAL,
                status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                amount: ngnAmount,
                reference: reversalRef,
                balanceBefore: balanceAfter - ngnAmount,
                balanceAfter,
                description: `Reversal: ${reason} (${originalRef})`,
            }, session);

            await session.commitTransaction();
            logger.info("Wallet refunded for failed OGateway transaction", { walletId, ngnAmount, ghsAmount, reason, originalRef });
        } catch (refundError: any) {
            if (session.inTransaction()) await session.abortTransaction();
            logger.error("CRITICAL: OGateway wallet refund failed", {
                walletId, userId, ngnAmount, ghsAmount, originalRef, error: refundError?.message,
            });
        } finally {
            session.endSession();
        }
    };

    /**
     * Send NGN → GHS via OGateway (instant payout to GHS MoMo or bank).
     * Debits user's NGN wallet at the locked rate, posts journal entries,
     * dispatches the payout to OGateway. Final state lands via the webhook.
     */
    public createOGatewayPayoutTransaction = async (
        params: {
            amount: number;          // GHS amount the recipient will receive
            fromAmount?: number;     // NGN debit amount (computed from locked rate)
            fromCurrency: 'NGN';
            toCurrency: 'GHS';
            destination: {
                accountType: 'momo' | 'bank';
                accountName: string;
                accountNumber: string;
                network?: string;    // MTN / VOD / ATM / ORANGE for MoMo
                bank?: string;       // Ghana bank code for BANK
            };
            senderName?: string;     // appears on the recipient's account; defaults to platform name
            idempotencyKey?: string;
            pin: string;
        },
        userId: string,
    ) => {
        const { amount, destination, idempotencyKey, pin } = params;

        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }
        if (!pin) {
            throw errorResponseMessage.payloadIncorrect("Transaction PIN is required");
        }
        await this.pinService.verifyPin(userId, pin);

        // Compute NGN debit server-side from the live OGateway rate. We're
        // BUYING GHS for the recipient, so we pull the NGN→GHS quote — that's
        // the side of OGateway's buy/sell spread we'll actually be charged at.
        // getUserFacingRate applies the platform's markup so what we book
        // matches what the user was quoted. Client-supplied fromAmount is ignored.
        let providerRate: number;
        let userRate: number;
        try {
            const quoted = await ogatewayService.getUserFacingRate('NGN', 'GHS', 'send');
            providerRate = quoted.providerRate;
            userRate = quoted.userRate;
        } catch (err: any) {
            logger.error("OGateway rate lookup failed during payout", { error: err?.message });
            throw errorResponseMessage.createError(400, "Could not retrieve the NGN→GHS rate from OGateway. Please try again.", ErrorSeverity.HIGH);
        }
        const ngnAmount = Math.round(amount * userRate * 100) / 100;
        if (!ngnAmount || ngnAmount <= 0) {
            throw errorResponseMessage.createError(400, "Could not compute NGN amount from the live OGateway rate", ErrorSeverity.HIGH);
        }

        // Fee is charged on top of the converted NGN amount so the recipient
        // still receives the full GHS amount they were promised.
        const { feeAmount, feePercent, providerFeePercent } = await platformSettingsService.computeFee('ogateway', ngnAmount);
        const totalDebit = Math.round((ngnAmount + feeAmount) * 100) / 100;
        const markupPercent = (await platformSettingsService.getSettings()).rateMarkupPercent;

        const wallet = await this.walletService.findOne({ user: userId });
        if (!wallet) {
            throw errorResponseMessage.createError(400, "You don't have a wallet yet. Please set up your wallet first.", ErrorSeverity.MEDIUM);
        }
        if (wallet.status !== WALLET_STATUS.ACTIVE) {
            throw errorResponseMessage.createError(400, "Your wallet is not active. Please contact support.", ErrorSeverity.HIGH);
        }
        if (wallet.balance < totalDebit) {
            throw errorResponseMessage.createError(
                400,
                `Insufficient wallet balance. You need ₦${totalDebit.toLocaleString()} but your balance is ₦${wallet.balance.toLocaleString()}. Please fund your wallet first.`,
                ErrorSeverity.MEDIUM,
            );
        }

        if (idempotencyKey) {
            const dup = await this.idempotencyService.validateKey(idempotencyKey, userId);
            if (dup.isDuplicate && dup.transactionId) {
                const existing = await this.findById(dup.transactionId);
                if (existing) {
                    const existingDetails = await this.transactionDetailsService.findOne({ transactionId: existing._id });
                    return { ...existing.toObject(), details: existingDetails ? existingDetails.toObject() : {} };
                }
            }
        }

        const sequenceId = this.generateOGatewaySequenceId();

        // Atomic wallet debit + journal posting.
        const walletSession = await mongoose.startSession();
        walletSession.startTransaction();

        let walletTransaction: any;
        const walletTxRef = this.walletTransactionService.generateReference('TRF');
        const balanceBefore = wallet.balance;
        const balanceAfter = balanceBefore - totalDebit;

        try {
            await this.walletService.debitBalance(wallet._id as string, totalDebit, walletSession);

            // Locked-rate posting: user's NGN wallet drops by totalDebit (the
            // converted amount + the platform fee). The converted amount sits
            // in OG_PAYMENT_INFLIGHT_GHS awaiting OGateway's webhook; the fee
            // lands in FEES_NGN immediately (platform revenue, recognised on
            // initiation since the user has already paid for it).
            const userAccountCode = userWalletAccountCode(userId, wallet.currency);
            const legs: Array<{ accountCode: string; direction: any; amount: number }> = [
                { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.DEBIT, amount: totalDebit },
                { accountCode: ogPaymentInflightCode('GHS'), direction: JOURNAL_DIRECTION.CREDIT, amount: ngnAmount },
            ];
            if (feeAmount > 0) {
                legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: feeAmount });
            }
            await ledgerService.post({
                legs,
                source: JOURNAL_SOURCE.OG_SEND,
                reference: sequenceId,
                description: `OGateway send — ${amount} GHS to ${destination.accountName}`,
                externalRef: { provider: WEBHOOK_PROVIDER.OGATEWAY, id: sequenceId },
                metadata: {
                    destinationAmount: amount,
                    destinationCurrency: 'GHS',
                    destination,
                    feeAmount,
                    feePercent,
                    providerFeePercent,
                    markupPercent,
                    providerRate,
                    userRate,
                },
                session: walletSession,
            });

            walletTransaction = await this.walletTransactionService.create({
                wallet: wallet._id,
                user: userId,
                type: WALLET_TRANSACTION_TYPE.TRANSFER,
                status: WALLET_TRANSACTION_STATUS.PENDING,
                amount: totalDebit,
                reference: walletTxRef,
                balanceBefore,
                balanceAfter,
                description: `Transfer to ${destination.accountName} (${amount} GHS)`,
            }, walletSession);

            await walletSession.commitTransaction();
        } catch (error) {
            if (walletSession.inTransaction()) await walletSession.abortTransaction();
            walletSession.endSession();
            throw error;
        } finally {
            walletSession.endSession();
        }

        const lockedRate = userRate;

        // Create the local transaction record.
        let transaction: any;
        let transactionDetails: any;
        try {
            transaction = await this.create({
                user: userId,
                reference: sequenceId,
                amount: Math.round(amount * 100) / 100,
                fromCurrency: 'NGN',
                currency: 'GHS',
                detailType: DETAIL_TYPE.OGATEWAY,
                status: TRANSACTION_STATUS.PENDING,
                initiatedAt: Date.now(),
                lockedRate,
                lockedRateFromCurrency: 'NGN',
                lockedRateToCurrency: 'GHS',
                lockedRateAt: new Date(),
            });
        } catch (dbError: any) {
            logger.error("Failed to create OGateway transaction record, refunding wallet", {
                error: dbError?.message, sequenceId,
            });
            await this.refundWalletFromOGateway(wallet._id, userId, totalDebit, ngnAmount, walletTransaction._id, walletTxRef, "Transaction record creation failed", feeAmount);
            throw errorResponseMessage.createError(500, `Failed to create transaction: ${dbError?.message || 'Unknown error'}`, ErrorSeverity.CRITICAL);
        }

        await this.walletTransactionService.updateById(walletTransaction._id as string, {
            paystackReference: sequenceId,
        });

        if (idempotencyKey) {
            await this.idempotencyService.updateKeyWithTransaction(idempotencyKey, transaction._id.toString());
        }

        const isMomo = destination.accountType === 'momo';
        try {
            transactionDetails = await this.transactionDetailsService.create({
                transactionId: transaction._id,
                type: DETAIL_TYPE.OGATEWAY,
                ogReference: sequenceId,
                ogChannel: isMomo ? OGATEWAY_CHANNELS.MOMO : OGATEWAY_CHANNELS.BANK,
                ogNetwork: isMomo ? destination.network : undefined,
                ogBank: !isMomo ? destination.bank : undefined,
                ogStatus: OGATEWAY_STATUS.PENDING,
                fromAmount: totalDebit,
                feeAmount,
                feePercent,
                providerFeePercent,
                markupPercent,
                accountName: destination.accountName,
                accountNumber: destination.accountNumber,
                institutionType: isMomo ? 'momo' : 'bank',
                country: 'GH',
            });
        } catch (dbError: any) {
            logger.error("Failed to create OGateway transaction detail", { error: dbError?.message });
            await this.refundWalletFromOGateway(wallet._id, userId, totalDebit, ngnAmount, walletTransaction._id, walletTxRef, "Transaction detail creation failed", feeAmount);
            throw errorResponseMessage.createError(500, `Failed to create transaction detail: ${dbError?.message || 'Unknown error'}`, ErrorSeverity.CRITICAL);
        }

        // Dispatch to OGateway.
        try {
            let payoutResponse: any;
            if (isMomo) {
                payoutResponse = await ogatewayService.payoutMobileMoney({
                    reference: sequenceId,
                    recipient: {
                        amount,
                        currency: 'GHS',
                        network: destination.network!,
                        accountName: destination.accountName,
                        accountNumber: destination.accountNumber,
                    },
                });
            } else {
                payoutResponse = await ogatewayService.payoutBank({
                    reference: sequenceId,
                    senderName: params.senderName || 'Solution Pay',
                    recipient: {
                        amount,
                        currency: 'GHS',
                        bank: destination.bank!,
                        accountName: destination.accountName,
                        accountNumber: destination.accountNumber,
                    },
                });
            }

            // OGateway responses for payouts are arrays of one item.
            const ogTx = Array.isArray(payoutResponse) ? payoutResponse[0] : payoutResponse;
            const ogStatus = (ogTx?.status || OGATEWAY_STATUS.INITIATED).toLowerCase();

            await this.transactionDetailsService.update(
                { transactionId: transaction._id },
                {
                    ogId: ogTx?.id,
                    ogStatus,
                    ogRawPayload: payoutResponse,
                },
            );

            // If OGateway returns COMPLETED synchronously, mark complete now;
            // otherwise stay in PROCESSING and wait for webhook.
            const finalStatus = ogStatus === OGATEWAY_STATUS.COMPLETED
                ? TRANSACTION_STATUS.COMPLETED
                : TRANSACTION_STATUS.PROCESSING;
            await this.updateById(transaction._id.toString(), {
                status: finalStatus,
                ...(finalStatus === TRANSACTION_STATUS.COMPLETED ? { completedAt: new Date() } : {}),
            });

            if (finalStatus === TRANSACTION_STATUS.COMPLETED) {
                // Sync: post the final ledger leg + clear wallet-transaction pending.
                await this.postOGatewayPayoutCompletion(sequenceId, ngnAmount);
                await this.walletTransactionService.updateById(walletTransaction._id as string, {
                    status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                });
                await this.walletService.adjustLedgerBalance(wallet._id as string, -totalDebit);
            }

            logger.info("OGateway payout dispatched", {
                transactionId: transaction._id,
                sequenceId,
                ogId: ogTx?.id,
                ogStatus,
                finalStatus,
            });

            return {
                ...transaction.toObject(),
                status: finalStatus,
                details: {
                    ...transactionDetails.toObject(),
                    ogId: ogTx?.id,
                    ogStatus,
                },
            };
        } catch (error: any) {
            await this.updateById(transaction._id.toString(), { status: TRANSACTION_STATUS.FAILED, failedAt: new Date() });
            await this.transactionDetailsService.update(
                { transactionId: transaction._id },
                { ogStatus: OGATEWAY_STATUS.FAILED },
            );
            await this.refundWalletFromOGateway(wallet._id, userId, totalDebit, ngnAmount, walletTransaction._id, walletTxRef, `OGateway payout dispatch failed: ${error?.message || 'unknown'}`, feeAmount);
            const ogError = error?.ogError || error?.response?.data || error?.data;
            const ogMessage = ogError?.message || ogError?.error || error?.message || "OGateway payout failed";
            throw errorResponseMessage.createError(400, `OGateway: ${ogMessage}`, ErrorSeverity.HIGH);
        }
    };

    /**
     * Receive GHS → NGN via OGateway (instant collection from a GHS MoMo sender).
     * Creates the local transaction in PENDING; the sender approves on their phone
     * and OGateway fires a webhook on settlement, at which point we credit the
     * user's NGN wallet (in handleOGatewayWebhook → creditWalletFromOGatewayCollection).
     */
    public createOGatewayCollectionTransaction = async (
        params: {
            amount: number;          // GHS amount the sender pays
            fromAmount?: number;     // NGN equivalent the user receives (locked rate)
            fromCurrency: 'GHS';
            toCurrency: 'NGN';
            sender: {
                accountName: string;
                accountNumber: string;
                network: string;
                email?: string;
            };
            idempotencyKey?: string;
        },
        userId: string,
    ) => {
        const { amount, sender, idempotencyKey } = params;

        if (!amount || amount <= 0) {
            throw errorResponseMessage.payloadIncorrect("Amount must be a positive number");
        }

        // Compute the NGN credit server-side from the live OGateway rate. We're
        // SELLING the GHS the sender pays us, so we pull the GHS→NGN quote —
        // that's what OGateway will actually pay out to us in NGN. getUserFacingRate
        // applies the platform markup (downward for receives so the user gets
        // less NGN, platform keeps the spread). Client-supplied fromAmount is ignored.
        let providerRate: number;
        let userRate: number;
        try {
            const quoted = await ogatewayService.getUserFacingRate('GHS', 'NGN', 'receive');
            providerRate = quoted.providerRate;
            userRate = quoted.userRate;
        } catch (err: any) {
            logger.error("OGateway rate lookup failed during collection", { error: err?.message });
            throw errorResponseMessage.createError(400, "Could not retrieve the GHS→NGN rate from OGateway. Please try again.", ErrorSeverity.HIGH);
        }
        const grossNgn = Math.round(amount * userRate * 100) / 100;
        if (!grossNgn || grossNgn <= 0) {
            throw errorResponseMessage.createError(400, "Could not compute NGN amount from the live OGateway rate", ErrorSeverity.HIGH);
        }

        // Fee is netted out of the credit so the user receives `gross − fee`.
        const { feeAmount, feePercent, providerFeePercent } = await platformSettingsService.computeFee('ogateway', grossNgn);
        const ngnAmount = Math.round((grossNgn - feeAmount) * 100) / 100;
        if (ngnAmount <= 0) {
            throw errorResponseMessage.createError(400, "Fee exceeds the converted amount. Please increase the amount.", ErrorSeverity.MEDIUM);
        }
        const markupPercent = (await platformSettingsService.getSettings()).rateMarkupPercent;

        if (idempotencyKey) {
            const dup = await this.idempotencyService.validateKey(idempotencyKey, userId);
            if (dup.isDuplicate && dup.transactionId) {
                const existing = await this.findById(dup.transactionId);
                if (existing) {
                    const existingDetails = await this.transactionDetailsService.findOne({ transactionId: existing._id });
                    return { ...existing.toObject(), details: existingDetails ? existingDetails.toObject() : {} };
                }
            }
        }

        const sequenceId = this.generateOGatewaySequenceId();
        const lockedRate = userRate;

        const transaction = await this.create({
            user: userId,
            reference: sequenceId,
            amount: Math.round(amount * 100) / 100,
            fromCurrency: 'GHS',
            currency: 'NGN',
            detailType: DETAIL_TYPE.OGATEWAY,
            status: TRANSACTION_STATUS.PENDING,
            initiatedAt: Date.now(),
            lockedRate,
            lockedRateFromCurrency: 'GHS',
            lockedRateToCurrency: 'NGN',
            lockedRateAt: new Date(),
        });

        if (idempotencyKey) {
            await this.idempotencyService.updateKeyWithTransaction(idempotencyKey, transaction._id.toString());
        }

        const transactionDetails = await this.transactionDetailsService.create({
            transactionId: transaction._id,
            type: DETAIL_TYPE.OGATEWAY,
            ogReference: sequenceId,
            ogChannel: OGATEWAY_CHANNELS.MOMO,
            ogNetwork: sender.network,
            ogStatus: OGATEWAY_STATUS.PENDING,
            fromAmount: ngnAmount,
            feeAmount,
            feePercent,
            providerFeePercent,
            markupPercent,
            momoName: sender.accountName,
            momoNumber: sender.accountNumber,
            momoNetwork: sender.network,
            institutionType: 'momo',
            country: 'GH',
        });

        try {
            const response = await ogatewayService.collectMobileMoney({
                amount,
                currency: 'GHS',
                network: sender.network,
                accountName: sender.accountName,
                accountNumber: sender.accountNumber,
                reason: `Collection for user ${userId}`,
                reference: sequenceId,
                email: sender.email,
            });

            const ogStatus = (response?.status || OGATEWAY_STATUS.INITIATED).toLowerCase();
            await this.transactionDetailsService.update(
                { transactionId: transaction._id },
                { ogId: response?.id, ogStatus, ogRawPayload: response },
            );
            await this.updateById(transaction._id.toString(), { status: TRANSACTION_STATUS.PROCESSING });

            logger.info("OGateway collection created", {
                transactionId: transaction._id, sequenceId, ogId: response?.id, ogStatus,
            });

            return {
                ...transaction.toObject(),
                status: TRANSACTION_STATUS.PROCESSING,
                details: {
                    ...transactionDetails.toObject(),
                    ogId: response?.id,
                    ogStatus,
                },
            };
        } catch (error: any) {
            await this.updateById(transaction._id.toString(), { status: TRANSACTION_STATUS.FAILED, failedAt: new Date() });
            await this.transactionDetailsService.update(
                { transactionId: transaction._id },
                { ogStatus: OGATEWAY_STATUS.FAILED },
            );
            const ogError = error?.ogError || error?.response?.data || error?.data;
            const ogMessage = ogError?.message || ogError?.error || error?.message || "OGateway collection failed";
            throw errorResponseMessage.createError(400, `OGateway: ${ogMessage}`, ErrorSeverity.HIGH);
        }
    };

    /**
     * On payout completion, settle the in-flight float to CASH_OGATEWAY_GHS.
     * Posted in NGN-equivalent amounts (locked rate already captured on tx record).
     */
    private postOGatewayPayoutCompletion = async (reference: string, ngnAmount: number) => {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            await ledgerService.post({
                legs: [
                    { accountCode: ogPaymentInflightCode('GHS'), direction: JOURNAL_DIRECTION.DEBIT, amount: ngnAmount },
                    { accountCode: ogCashAccountCode('GHS'), direction: JOURNAL_DIRECTION.CREDIT, amount: ngnAmount },
                ],
                source: JOURNAL_SOURCE.OG_SEND,
                reference,
                description: `OGateway payout settled — float drawn down`,
                externalRef: { provider: WEBHOOK_PROVIDER.OGATEWAY, id: reference },
                session,
            });
            await session.commitTransaction();
        } catch (error) {
            if (session.inTransaction()) await session.abortTransaction();
            logger.error("OGateway payout settlement journal post failed", { reference, error: (error as any)?.message });
        } finally {
            session.endSession();
        }
    };

    /**
     * On collection completion, credit the user's NGN wallet at the locked rate
     * and post the settling journal entries.
     */
    private creditWalletFromOGatewayCollection = async (transaction: any, detail: any) => {
        const userId = typeof transaction.user === 'object' ? transaction.user._id?.toString() : transaction.user?.toString();
        // detail.fromAmount is the NET amount credited to the user (already
        // fee-deducted). The platform receives the GROSS = net + fee from the
        // rail, and books the fee into FEES_NGN.
        const ngnAmount = detail.fromAmount || transaction.amount;
        const feeAmount = detail.feeAmount || 0;
        const grossNgn = Math.round((ngnAmount + feeAmount) * 100) / 100;

        try {
            const wallet = await this.walletService.findOne({ user: userId });
            if (!wallet) {
                logger.error("Wallet not found for OGateway collection credit", { userId });
                return;
            }
            await this.walletService.getOrCreateWallet(userId);

            const session = await mongoose.startSession();
            session.startTransaction();
            try {
                await this.walletService.creditBalance(wallet._id as string, ngnAmount, session);

                const userAccountCode = userWalletAccountCode(userId, wallet.currency);
                const legs: Array<{ accountCode: string; direction: any; amount: number }> = [
                    { accountCode: ogCashAccountCode('GHS'), direction: JOURNAL_DIRECTION.DEBIT, amount: grossNgn },
                    { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.CREDIT, amount: ngnAmount },
                ];
                if (feeAmount > 0) {
                    legs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: feeAmount });
                }
                await ledgerService.post({
                    legs,
                    source: JOURNAL_SOURCE.OG_COLLECT,
                    reference: transaction.reference,
                    description: `OGateway collection settled — ${transaction.amount} GHS → ₦${ngnAmount.toFixed(2)} (fee ₦${feeAmount.toFixed(2)})`,
                    externalRef: { provider: WEBHOOK_PROVIDER.OGATEWAY, id: transaction.reference },
                    metadata: { fromAmount: transaction.amount, fromCurrency: 'GHS', feeAmount, grossNgn },
                    session,
                });

                const ref = this.walletTransactionService.generateReference('COL');
                await this.walletTransactionService.create({
                    wallet: wallet._id,
                    user: userId,
                    type: WALLET_TRANSACTION_TYPE.FUNDING,
                    status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                    amount: ngnAmount,
                    reference: ref,
                    balanceBefore: wallet.balance,
                    balanceAfter: wallet.balance + ngnAmount,
                    description: `Received ${transaction.amount} GHS → ₦${ngnAmount.toLocaleString()}`,
                    paystackReference: transaction.reference,
                }, session);

                await this.walletService.adjustLedgerBalance(wallet._id as string, ngnAmount, session);
                await session.commitTransaction();
            } catch (sessionError) {
                if (session.inTransaction()) await session.abortTransaction();
                throw sessionError;
            } finally {
                session.endSession();
            }

            logger.info("Wallet credited from OGateway collection", {
                userId, walletId: wallet._id, ngnAmount, ghsAmount: transaction.amount,
            });
        } catch (error: any) {
            logger.error("CRITICAL: Failed to credit wallet from OGateway collection", {
                userId, transactionId: transaction._id, ngnAmount, error: error?.message,
            });
        }
    };

    /**
     * Handle an OGateway webhook event. Called by webhook.controller after
     * the HMAC-SHA512 signature has been verified.
     *
     * OGateway payload shape (per docs):
     *   {
     *     id, amount, fee, currency, status: 'COMPLETED' | 'FAILED',
     *     channel, network, customer: { accountName, accountNumber },
     *     reference_business, provider_message, message, telco_response,
     *     created_at, updated_at, metadata?, instructions?, virtual_account?
     *   }
     */
    public handleOGatewayWebhook = async (webhookData: any) => {
        const reference = webhookData?.reference_business;
        if (!reference) {
            logger.warn("OGateway webhook missing reference_business", { keys: Object.keys(webhookData || {}) });
            return;
        }

        const detail = await this.transactionDetailsService.findOne({ ogReference: reference });
        if (!detail) {
            logger.warn("OGateway webhook: no matching transaction detail", { reference });
            return;
        }

        const transactionId = detail.transactionId.toString();
        const transaction = await this.findById(transactionId);
        if (!transaction) {
            logger.warn("OGateway webhook: no matching transaction", { transactionId });
            return;
        }

        const status = (webhookData?.status || '').toLowerCase();

        await this.transactionDetailsService.update(
            { _id: detail._id },
            { ogRawPayload: webhookData, ogStatus: status, ogId: webhookData?.id || detail.ogId },
        );

        const isSendFlow = transaction.fromCurrency === 'NGN' && transaction.currency === 'GHS';
        const isReceiveFlow = transaction.fromCurrency === 'GHS' && transaction.currency === 'NGN';

        // ===== Send flow (NGN→GHS payout) =====
        if (isSendFlow) {
            const findWalletTx = async () => this.walletTransactionService.findOne({
                paystackReference: transaction.reference,
                type: WALLET_TRANSACTION_TYPE.TRANSFER,
            });

            if (status === OGATEWAY_STATUS.COMPLETED) {
                if (transactionStateMachine.canTransition(transaction.status, TRANSACTION_STATUS.COMPLETED)) {
                    await this.updateById(transactionId, {
                        status: TRANSACTION_STATUS.COMPLETED,
                        completedAt: new Date(),
                    });
                    // detail.fromAmount is the total wallet debit (converted + fee).
                    // The OG_PAYMENT_INFLIGHT_GHS leg only holds the converted
                    // portion, so we drain it by `fromAmount - feeAmount`.
                    const totalDebit = detail.fromAmount || transaction.amount;
                    const feeAmount = (detail as any).feeAmount || 0;
                    const convertedNgn = Math.round((totalDebit - feeAmount) * 100) / 100;
                    await this.postOGatewayPayoutCompletion(transaction.reference, convertedNgn);

                    const walletTx = await findWalletTx();
                    if (walletTx) {
                        await this.walletTransactionService.updateById(walletTx._id as string, {
                            status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                        });
                        await this.walletService.adjustLedgerBalance(walletTx.wallet as string, -walletTx.amount);
                    }
                }

                const user = transaction.user as IUser;
                if (user?.email) {
                    try {
                        await this.notificationService.sendTransactionNotification(user, "payment_completed", {
                            amount: `${transaction.amount} GHS`,
                            reference: transaction.reference,
                            recipient: detail.accountName || "Recipient",
                            actionUrl: `${config.FRONTEND_URL}/dashboard/user/payments`,
                        });
                    } catch (e) {
                        logger.warn("Failed to send OGateway completion notification", { error: e });
                    }
                }
                return;
            }

            if (status === OGATEWAY_STATUS.FAILED) {
                if (transactionStateMachine.canTransition(transaction.status, TRANSACTION_STATUS.FAILED)) {
                    await this.updateById(transactionId, { status: TRANSACTION_STATUS.FAILED, failedAt: new Date() });
                }
                const walletTx = await findWalletTx();
                if (walletTx && walletTx.status !== WALLET_TRANSACTION_STATUS.FAILED && walletTx.status !== WALLET_TRANSACTION_STATUS.REVERSED) {
                    const totalDebit = walletTx.amount;
                    const feeAmount = (detail as any).feeAmount || 0;
                    const convertedNgn = Math.round((totalDebit - feeAmount) * 100) / 100;
                    await this.refundWalletFromOGateway(
                        walletTx.wallet,
                        walletTx.user as string,
                        totalDebit,
                        convertedNgn,
                        walletTx._id,
                        walletTx.reference,
                        webhookData?.provider_message || webhookData?.message || 'OGateway payout failed',
                        feeAmount,
                    );
                }
                return;
            }
        }

        // ===== Receive flow (GHS→NGN collection) =====
        if (isReceiveFlow) {
            if (status === OGATEWAY_STATUS.COMPLETED) {
                if (transactionStateMachine.canTransition(transaction.status, TRANSACTION_STATUS.COMPLETED)) {
                    await this.updateById(transactionId, {
                        status: TRANSACTION_STATUS.COMPLETED,
                        completedAt: new Date(),
                    });
                    await this.creditWalletFromOGatewayCollection(transaction, detail);
                }
                return;
            }
            if (status === OGATEWAY_STATUS.FAILED) {
                if (transactionStateMachine.canTransition(transaction.status, TRANSACTION_STATUS.FAILED)) {
                    await this.updateById(transactionId, { status: TRANSACTION_STATUS.FAILED, failedAt: new Date() });
                }
                return;
            }
        }

        // Intermediate state — just record it.
        logger.info("OGateway webhook intermediate status", { transactionId, status });
    };

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