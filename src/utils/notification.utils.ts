import WhatsAppService from '../utils/whatsapp.utils';
import EmailService from '../utils/email.utils';
import { IUser } from '../models/interface';

interface NotificationConfig {
    title: string;
    message: string;
    actionUrl?: string;
    buttonText?: string;
    [key: string]: string | number | boolean | undefined;
}

/**
 * Unified notification service that sends both email and WhatsApp messages
 * Centralizes notification logic for easier management
 */
class NotificationService {
    public emailService: EmailService;
    private whatsappService: WhatsAppService;

    constructor() {
        this.emailService = new EmailService();
        // Use singleton instance of WhatsAppService
        this.whatsappService = WhatsAppService.getInstance();
    }

    /**
     * Initialize WhatsApp service (must be called once at app startup)
     */
    public async initializeWhatsApp(): Promise<void> {
        try {
            await this.whatsappService.initialize();
            console.log('WhatsApp service initialized');
        } catch (error) {
            console.error('Failed to initialize WhatsApp service:', error);
        }
    }

    /**
     * Send both email and WhatsApp notification to a user
     * @param user - User object with email and phone number
     * @param config - Notification configuration
     * @param attachments - Optional email attachments
     * @param mediaUrls - Optional media URLs to send via WhatsApp
     */
    public async sendNotification(
        user: IUser,
        config: NotificationConfig,
        attachments?: Array<{
            filename: string;
            content: Buffer;
            contentType: string;
        }>,
        mediaUrls?: Array<{
            url: string;
            caption?: string;
        }>
    ): Promise<{ email: boolean; whatsapp: boolean }> {
        const results = {
            email: false,
            whatsapp: false,
        };

        // Send email
        try {
            await this.emailService.sendNotificationEmail(user.email, config, attachments);
            results.email = true;
            console.log(`Email sent to ${user.email}`);
        } catch (error) {
            console.error(`Failed to send email to ${user.email}:`, error);
        }

        // Send WhatsApp message
        try {
            if (user.phoneNumber) {
                const whatsappMessage = this.formatWhatsAppMessage(config);
                
                // Send text message first
                await this.whatsappService.sendTextMessage(user.phoneNumber, whatsappMessage);
                results.whatsapp = true;
                console.log(`WhatsApp message sent to ${user.phoneNumber}`);

                // Send media attachments if provided
                if (mediaUrls && mediaUrls.length > 0) {
                    for (const media of mediaUrls) {
                        try {
                            await this.whatsappService.sendImageMessage(user.phoneNumber, {
                                url: media.url,
                                caption: media.caption || '',
                            });
                            console.log(`WhatsApp media sent to ${user.phoneNumber}`);
                        } catch (mediaError) {
                            console.error(`Failed to send WhatsApp media to ${user.phoneNumber}:`, mediaError);
                        }
                    }
                }
            } else {
                console.warn(`User ${user._id} has no phone number for WhatsApp notification`);
            }
        } catch (error) {
            console.error(`Failed to send WhatsApp to ${user.phoneNumber}:`, error);
        }

        return results;
    }

    /**
     * Send WhatsApp message to admin users
     * @param adminEmails - Comma-separated admin email addresses
     * @param config - Notification configuration
     * @param adminPhoneNumbers - Comma-separated admin phone numbers (must match order of emails)
     * @param attachments - Optional email attachments
     * @param mediaUrls - Optional media URLs to send via WhatsApp
     */
    public async notifyAdmins(
        adminEmails: string,
        config: NotificationConfig,
        adminPhoneNumbers?: string,
        attachments?: Array<{
            filename: string;
            content: Buffer;
            contentType: string;
        }>,
        mediaUrls?: Array<{
            url: string;
            caption?: string;
        }>
    ): Promise<void> {
        const emails = adminEmails.split(',').map(e => e.trim());
        const phones = adminPhoneNumbers?.split(',').map(p => p.trim()) || [];

        // Send emails with attachments
        for (const email of emails) {
            try {
                await this.emailService.sendNotificationEmail(email, config, attachments);
                console.log(`Admin email sent to ${email}`);
            } catch (error) {
                console.error(`Failed to send admin email to ${email}:`, error);
            }
        }

        // Send WhatsApp messages with media
        for (let i = 0; i < phones.length; i++) {
            try {
                const phone = phones[i];
                if (phone) {
                    const whatsappMessage = this.formatWhatsAppMessage(config);
                    
                    // Send text message first
                    await this.whatsappService.sendTextMessage(phone, whatsappMessage);
                    console.log(`Admin WhatsApp text sent to ${phone}`);

                    // Send media attachments if provided
                    if (mediaUrls && mediaUrls.length > 0) {
                        for (const media of mediaUrls) {
                            try {
                                await this.whatsappService.sendImageMessage(phone, {
                                    url: media.url,
                                    caption: media.caption || '',
                                });
                                console.log(`Admin WhatsApp media sent to ${phone}`);
                            } catch (mediaError) {
                                console.error(`Failed to send admin WhatsApp media to ${phone}:`, mediaError);
                            }
                        }
                    }
                }
            } catch (error) {
                console.error(`Failed to send admin WhatsApp to ${phones[i]}:`, error);
            }
        }
    }

    /**
     * Send WhatsApp message to specific phone number
     * @param phoneNumber - Recipient phone number
     * @param config - Notification configuration
     */
    public async sendWhatsAppOnly(
        phoneNumber: string,
        config: NotificationConfig
    ): Promise<void> {
        try {
            const whatsappMessage = this.formatWhatsAppMessage(config);
            await this.whatsappService.sendTextMessage(phoneNumber, whatsappMessage);
            console.log(`WhatsApp message sent to ${phoneNumber}`);
        } catch (error) {
            console.error(`Failed to send WhatsApp to ${phoneNumber}:`, error);
        }
    }

    /**
     * Send WhatsApp verification code
     * @param phoneNumber - Recipient phone number
     * @param code - Verification code
     * @param appName - Application name
     */
    public async sendVerificationCode(
        phoneNumber: string,
        code: string,
        appName: string = 'Our Service'
    ): Promise<void> {
        try {
            await this.whatsappService.sendVerificationMessage(phoneNumber, {
                name: 'there',
                code,
                appName,
                expiryTime: '10 minutes',
            });
            console.log(`Verification code WhatsApp sent to ${phoneNumber}`);
        } catch (error) {
            console.error(`Failed to send verification code to ${phoneNumber}:`, error);
        }
    }

    /**
     * Send payment/transaction notification
     * @param user - User object
     * @param transactionType - Type of transaction (payment_completed, payment_initiated, etc.)
     * @param transactionDetails - Details about the transaction
     * @param attachments - Optional attachments for email
     * @param mediaUrls - Optional media URLs to send via WhatsApp
     */
    public async sendTransactionNotification(
        user: IUser,
        transactionType: 'payment_completed' | 'payment_initiated' | 'payment_failed',
        transactionDetails: {
            amount?: string;
            reference?: string;
            recipient?: string;
            actionUrl?: string;
        },
        attachments?: Array<{
            filename: string;
            content: Buffer;
            contentType: string;
        }>,
        mediaUrls?: Array<{
            url: string;
            caption?: string;
        }>
    ): Promise<{ email: boolean; whatsapp: boolean }> {
        const messageConfig = this.getTransactionMessage(transactionType, transactionDetails);
        return this.sendNotification(user, messageConfig, attachments, mediaUrls);
    }

    /**
     * Format notification config into WhatsApp message string
     */
    private formatWhatsAppMessage(config: NotificationConfig): string {
        let message = `*${config.title}*\n\n${config.message}`;

        if (config.actionUrl) {
            message += `\n\n🔗 ${config.actionUrl}`;
        }

        if (config.buttonText) {
            message += `\n\n👉 ${config.buttonText}`;
        }

        return message;
    }

    /**
     * Generate transaction-specific messages
     */
    private getTransactionMessage(
        type: string,
        details: any
    ): NotificationConfig {
        const messages: Record<string, NotificationConfig> = {
            payment_completed: {
                title: '✅ Payment Completed',
                message: `Your payment of ${details.amount} to ${details.recipient} has been successfully completed (Ref: ${details.reference})`,
                actionUrl: details.actionUrl,
                buttonText: 'View Details',
            },
            payment_initiated: {
                title: '⏳ Payment Initiated',
                message: `Your payment of ${details.amount} has been initiated (Ref: ${details.reference}). We're processing your request.`,
                actionUrl: details.actionUrl,
                buttonText: 'Track Payment',
            },
            payment_failed: {
                title: '❌ Payment Failed',
                message: `Your payment of ${details.amount} could not be processed. Please try again or contact support.`,
                actionUrl: details.actionUrl,
                buttonText: 'Retry Payment',
            },
        };

        return messages[type] || messages.payment_initiated;
    }

    /**
     * Disconnect WhatsApp service (call on app shutdown)
     */
    public async disconnectWhatsApp(): Promise<void> {
        try {
            await this.whatsappService.disconnect();
            console.log('WhatsApp service disconnected');
        } catch (error) {
            console.error('Error disconnecting WhatsApp:', error);
        }
    }
}

export default NotificationService;