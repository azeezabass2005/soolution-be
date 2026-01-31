import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import EmailService from './email.utils';
import config from '../config/env.config';

/**
 * Represents the structure of WhatsApp message data
 */
interface WhatsAppMessageData {
    [key: string]: string | number | boolean | undefined;
}

/**
 * Configuration for sending WhatsApp messages
 */
interface WhatsAppMessageConfig {
    to: string;
    message?: string;
    template?: string;
    data?: WhatsAppMessageData;
    image?: {
        url?: string;
        path?: string;
        caption?: string;
    };
    buttons?: Array<{
        id: string;
        title: string;
    }>;
}

/**
 * WhatsApp API Response
 */
interface WhatsAppResponse {
    success: boolean;
    messageId?: string;
    error?: string;
    details?: any;
}

/**
 * A comprehensive WhatsApp service using whatsapp-web.js
 * providing messaging functionality with template support and media sending
 * Uses singleton pattern to ensure only one client instance exists
 */
class WhatsAppService {
    private static instance: WhatsAppService;
    
    /** WhatsApp Web client instance */
    private client: Client | null = null;

    /** Flag to track if client is ready */
    private isReady: boolean = false;

    /** Available message templates */
    private readonly templates: Map<string, (data: WhatsAppMessageData) => string>;

    /** Email service instance */
    private emailService: EmailService;

    /** Last QR code that was sent via email */
    private lastSentQRCode: string | null = null;

    /** Flag to track if we're in a connection session */
    private isConnectionSessionActive: boolean = false;

    /**
     * Private constructor - use getInstance() instead
     */
    private constructor() {
        this.templates = new Map();
        this.emailService = new EmailService();
        this.registerTemplates();
    }

    /**
     * Get singleton instance of WhatsAppService
     */
    public static getInstance(): WhatsAppService {
        if (!WhatsAppService.instance) {
            WhatsAppService.instance = new WhatsAppService();
        }
        return WhatsAppService.instance;
    }

    /**
     * Initializes the WhatsApp Web client
     * @returns {Promise<void>}
     */
    public async initialize(): Promise<void> {
        if (this.client && this.isReady) {
            console.log('WhatsApp client already initialized');
            return;
        }

        this.client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            },
        });

        this.setupEventHandlers();
        await this.client.initialize();
    }

    /**
     * Sets up event handlers for the client
     */
    private setupEventHandlers(): void {
        if (!this.client) return;

        this.client.on('qr', async (qr) => {
            console.log('QR Code received. Scan this with your WhatsApp app:');
            qrcode.generate(qr, { small: true });
            
            // Mark that we're in an active connection session
            this.isConnectionSessionActive = true;
            
            // Send QR code to admin emails (with throttling)
            try {
                await this.sendQRCodeToAdmins(qr);
            } catch (error) {
                console.error('Failed to send QR code to admins:', error);
            }
        });

        this.client.on('ready', () => {
            console.log('WhatsApp Web client is ready!');
            this.isReady = true;
            // Reset QR code tracking when connected
            this.lastSentQRCode = null;
            this.isConnectionSessionActive = false;
        });

        this.client.on('authenticated', () => {
            console.log('WhatsApp Web client has been authenticated!');
        });

        this.client.on('auth_failure', (msg) => {
            console.error('Authentication failed:', msg);
            this.isReady = false;
            this.isConnectionSessionActive = false;
        });

        this.client.on('disconnected', (reason) => {
            console.log('WhatsApp Web client disconnected:', reason);
            this.isReady = false;
            this.isConnectionSessionActive = false;
            // Reset tracking when disconnected to allow new session emails
            this.lastSentQRCode = null;
        });

        this.client.on('message', (message) => {
            console.log('Message received:', message.body);
        });
    }

    /**
     * Registers all available message templates
     */
    private registerTemplates(): void {
        this.templates.set('welcome', this.welcomeTemplate.bind(this));
        this.templates.set('verification', this.verificationTemplate.bind(this));
        this.templates.set('order-confirmation', this.orderConfirmationTemplate.bind(this));
        this.templates.set('reminder', this.reminderTemplate.bind(this));
        this.templates.set('notification', this.notificationTemplate.bind(this));
    }

    /**
     * Welcome message template
     */
    private welcomeTemplate(data: WhatsAppMessageData): string {
        return `
🎉 *Welcome to ${data.appName || 'Our Platform'}!*

Hi ${data.name || 'there'}! 👋

We're excited to have you on board. Your account has been successfully created and you're all set to get started.

${data.actionText || 'Start exploring our features and make the most of your experience with us.'}

Need help? Just reply to this message and our support team will assist you.

Best regards,
${data.appName || 'The Team'} 🚀
        `.trim();
    }

    /**
     * Verification code template
     */
    private verificationTemplate(data: WhatsAppMessageData): string {
        return `
🔐 *Verification Code*

Hi ${data.name || 'there'},

Your verification code is:

*${data.code || 'XXXXXX'}*

This code will expire in ${data.expiryTime || '10 minutes'}.

⚠️ Never share this code with anyone. Our team will never ask for your verification code.

${data.appName || 'Team'}
        `.trim();
    }

    /**
     * Order confirmation template
     */
    private orderConfirmationTemplate(data: WhatsAppMessageData): string {
        return `
✅ *Order Confirmed!*

Hi ${data.name || 'Customer'},

Thank you for your order! 🎉

*Order Details:*
Order ID: #${data.orderId || 'N/A'}
Amount: ${data.currency || '$'}${data.amount || '0.00'}
Status: ${data.status || 'Processing'}

${data.deliveryInfo ? `\n📦 Delivery Info:\n${data.deliveryInfo}\n` : ''}
${data.trackingUrl ? `\nTrack your order: ${data.trackingUrl}\n` : ''}

Questions? Reply to this message and we'll help you out!

${data.appName || 'Team'}
        `.trim();
    }

    /**
     * Reminder template
     */
    private reminderTemplate(data: WhatsAppMessageData): string {
        return `
⏰ *Reminder*

Hi ${data.name || 'there'},

${data.message || 'This is a friendly reminder for you.'}

${data.details ? `\n${data.details}\n` : ''}
${data.actionUrl ? `\nTake action: ${data.actionUrl}\n` : ''}

${data.appName || 'Team'}
        `.trim();
    }

    /**
     * General notification template
     */
    private notificationTemplate(data: WhatsAppMessageData): string {
        return `
📢 *${data.title || 'Notification'}*

Hi ${data.name || 'there'},

${data.message || 'You have a new notification.'}

${data.details ? `\n${data.details}\n` : ''}
${data.actionUrl ? `\nView details: ${data.actionUrl}\n` : ''}

${data.appName || 'Team'}
        `.trim();
    }

    /**
     * Formats phone number to WhatsApp format
     */
    private formatPhoneNumber(phoneNumber: string): string {
        let cleaned = phoneNumber.replace(/\D/g, '');
        
        // Add country code if needed (optional based on your region)
        // if (cleaned.length === 10) cleaned = '1' + cleaned;
        
        return cleaned + '@c.us';
    }

    /**
     * Replaces placeholders in a string with provided data
     */
    private replacePlaceholders(template: string, data: WhatsAppMessageData): string {
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            return data[key]?.toString() || match;
        });
    }

    /**
     * Centralized error handling for WhatsApp operations
     */
    private async executeWithErrorHandling<R>(
        operation: () => Promise<R>,
        errorMessage: string = 'WhatsApp operation failed'
    ): Promise<R> {
        try {
            if (!this.isReady || !this.client) {
                throw new Error('WhatsApp client is not ready. Please initialize the service first.');
            }
            return await operation();
        } catch (error) {
            console.error(errorMessage, error);
            throw new Error(`${errorMessage}: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * Sends a text message via WhatsApp
     */
    public async sendTextMessage(to: string, message: string): Promise<WhatsAppResponse> {
        return this.executeWithErrorHandling(async () => {
            const formattedNumber = this.formatPhoneNumber(to);
            const response = await this.client!.sendMessage(formattedNumber, message);

            return {
                success: true,
                messageId: response.id.id,
                details: response,
            };
        }, 'Failed to send text message');
    }

    /**
     * Sends an image message via WhatsApp
     */
    public async sendImageMessage(
        to: string,
        image: { url?: string; path?: string; caption?: string }
    ): Promise<WhatsAppResponse> {
        return this.executeWithErrorHandling(async () => {
            const formattedNumber = this.formatPhoneNumber(to);
            let media: MessageMedia;

            try {
                if (image.path) {
                    // Load from local file
                    if (!fs.existsSync(image.path)) {
                        throw new Error(`Image file not found: ${image.path}`);
                    }
                    const imageData = fs.readFileSync(image.path);
                    const base64 = imageData.toString('base64');
                    const mimeType = this.getMimeType(image.path);
                    media = new MessageMedia(mimeType, base64, path.basename(image.path));
                } else if (image.url) {
                    // Load from URL
                    const response = await fetch(image.url);
                    if (!response.ok) {
                        throw new Error(`Failed to fetch image from URL: ${response.statusText}`);
                    }
                    const buffer = await response.arrayBuffer();
                    const base64 = Buffer.from(buffer).toString('base64');
                    const mimeType = response.headers.get('content-type') || 'image/jpeg';
                    const filename = image.url.split('/').pop() || 'image.jpg';
                    media = new MessageMedia(mimeType, base64, filename);
                } else {
                    throw new Error('Either image URL or path must be provided');
                }

                console.log('Sending media to:', formattedNumber, 'with caption:', image.caption);
                
                // Get or create the chat first
                const chat = await this.client!.getChatById(formattedNumber);
                
                const messageOptions: any = {};
                if (image.caption) {
                    messageOptions.caption = image.caption;
                }

                const response = await this.client!.sendMessage(
                    formattedNumber,
                    media,
                    messageOptions
                );

                console.log('Media sent successfully:', response.id.id);

                return {
                    success: true,
                    messageId: response.id.id,
                    details: response,
                };
            } catch (error) {
                console.error('Error sending image:', error);
                throw error;
            }
        }, 'Failed to send image message');
    }

    /**
     * Determines MIME type based on file extension
     */
    private getMimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: { [key: string]: string } = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.pdf': 'application/pdf',
            '.mp4': 'video/mp4',
            '.mp3': 'audio/mpeg',
            '.webp': 'image/webp',
        };
        return mimeTypes[ext] || 'application/octet-stream';
    }

    /**
     * Sends a message with buttons (interactive message)
     */
    public async sendButtonMessage(
        to: string,
        message: string,
        buttons: Array<{ id: string; title: string }>
    ): Promise<WhatsAppResponse> {
        return this.executeWithErrorHandling(async () => {
            const formattedNumber = this.formatPhoneNumber(to);

            // whatsapp-web.js doesn't have native button support like Business API
            // So we send the message with button descriptions
            const buttonText = buttons
                .slice(0, 3)
                .map((btn, i) => `${i + 1}. ${btn.title}`)
                .join('\n');

            const fullMessage = `${message}\n\n${buttonText}\n\nReply with the number of your choice.`;
            const response = await this.client!.sendMessage(formattedNumber, fullMessage);

            return {
                success: true,
                messageId: response.id.id,
                details: response,
            };
        }, 'Failed to send button message');
    }

    /**
     * Sends a message using flexible configuration
     */
    public async send(config: WhatsAppMessageConfig): Promise<WhatsAppResponse> {
        return this.executeWithErrorHandling(async () => {
            const { to, message, template, data, image, buttons } = config;
            
            let messageText = message;

            if (template && this.templates.has(template)) {
                const templateFn = this.templates.get(template)!;
                messageText = templateFn(data || {});
            } else if (template) {
                throw new Error(`Template "${template}" not found`);
            }

            if (messageText && data) {
                messageText = this.replacePlaceholders(messageText, data);
            }

            if (image) {
                return await this.sendImageMessage(to, {
                    ...image,
                    caption: image.caption || messageText,
                });
            }

            if (buttons && buttons.length > 0) {
                if (!messageText) {
                    throw new Error('Message text is required for button messages');
                }
                return await this.sendButtonMessage(to, messageText, buttons);
            }

            if (!messageText) {
                throw new Error('Message text is required');
            }
            return await this.sendTextMessage(to, messageText);
        }, 'Failed to send WhatsApp message');
    }

    /**
     * Sends a welcome message
     */
    public async sendWelcomeMessage(to: string, data: WhatsAppMessageData): Promise<WhatsAppResponse> {
        return this.send({
            to,
            template: 'welcome',
            data,
        });
    }

    /**
     * Sends a verification code message
     */
    public async sendVerificationMessage(to: string, data: WhatsAppMessageData): Promise<WhatsAppResponse> {
        return this.send({
            to,
            template: 'verification',
            data,
        });
    }

    /**
     * Sends an order confirmation message
     */
    public async sendOrderConfirmation(to: string, data: WhatsAppMessageData): Promise<WhatsAppResponse> {
        return this.send({
            to,
            template: 'order-confirmation',
            data,
        });
    }

    /**
     * Sends a reminder message
     */
    public async sendReminderMessage(to: string, data: WhatsAppMessageData): Promise<WhatsAppResponse> {
        return this.send({
            to,
            template: 'reminder',
            data,
        });
    }

    /**
     * Sends a notification message
     */
    public async sendNotificationMessage(to: string, data: WhatsAppMessageData): Promise<WhatsAppResponse> {
        return this.send({
            to,
            template: 'notification',
            data,
        });
    }

    /**
     * Registers a custom template
     */
    public registerCustomTemplate(
        name: string,
        templateFn: (data: WhatsAppMessageData) => string
    ): void {
        this.templates.set(name, templateFn);
    }

    /**
     * Sends QR code to admin emails when WhatsApp connection is initiated
     * Sends email every time a new QR code is generated (when QR code string changes)
     * This ensures admins always have the latest valid QR code since generating a new one invalidates the previous one
     * @param qr QR code string
     */
    private async sendQRCodeToAdmins(qr: string): Promise<void> {
        try {
            // Check if this is a new QR code (different from the last one sent)
            // If it's the same QR code, skip sending to avoid duplicate emails
            // if (this.lastSentQRCode === qr) {
            //     console.log('Skipping QR code email: Same QR code as previously sent');
            //     return;
            // }
            
            // Determine if this is the first QR code in a new session (before updating)
            const isFirstInSession = this.lastSentQRCode === null;
            
            // This is a new QR code - send it immediately
            // Update tracking BEFORE sending to prevent race conditions
            this.lastSentQRCode = qr;

            // Convert QR code string to PNG buffer
            const qrCodeBuffer = await QRCode.toBuffer(qr, {
                type: 'png',
                width: 512,
                margin: 2,
            });

            // Get admin emails from config
            const adminEmails = config.ADMIN_EMAILS.split(',').map(email => email.trim());

            // Send email to each admin
            const emailSubject = isFirstInSession 
                ? 'WhatsApp Connection Required' 
                : 'New WhatsApp QR Code Generated';
            
            const emailMessage = isFirstInSession
                ? 'WhatsApp connection requires authentication. Please scan the attached QR code with your WhatsApp app to connect. This QR code will expire in a few minutes.'
                : 'A new QR code has been generated. The previous QR code is now invalid. Please scan this new QR code with your WhatsApp app to connect.';

            for (const email of adminEmails) {
                try {
                    await this.emailService.sendNotificationEmail(
                        email,
                        {
                            title: emailSubject,
                            message: emailMessage,
                            actionUrl: config.FRONTEND_URL,
                            buttonText: 'View Dashboard',
                        },
                        [
                            {
                                filename: 'whatsapp-qrcode.png',
                                content: qrCodeBuffer,
                                contentType: 'image/png',
                            },
                        ]
                    );
                    console.log(`QR code email sent to admin: ${email} (${isFirstInSession ? 'first in session' : 'new QR code generated'})`);
                } catch (error) {
                    console.error(`Failed to send QR code email to ${email}:`, error);
                }
            }

            // Tracking already updated before sending
        } catch (error) {
            console.error('Error generating or sending QR code to admins:', error);
            throw error;
        }
    }

    /**
     * Gets the client ready status
     */
    public getStatus(): boolean {
        return this.isReady;
    }

    /**
     * Disconnects the WhatsApp client
     */
    public async disconnect(): Promise<void> {
        if (this.client) {
            await this.client.destroy();
            this.isReady = false;
            console.log('WhatsApp client disconnected');
        }
    }

    /**
     * Gets the authenticated user info
     */
    public async getMe(): Promise<any> {
        return this.executeWithErrorHandling(async () => {
            const info = await this.client!.getWWebVersion();
            return info;
        }, 'Failed to get client info');
    }
}

export default WhatsAppService;