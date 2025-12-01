import axios, { AxiosInstance, AxiosResponse } from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

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
 * Template message structure
 */
interface TemplateMessage {
    name: string;
    components: Array<{
        type: string;
        parameters: Array<{
            type: string;
            text?: string;
            image?: {
                link: string;
            };
        }>;
    }>;
}

/**
 * A comprehensive WhatsApp service that provides messaging functionality
 * with template support and media sending capabilities
 */
class WhatsAppService {
    /** Axios instance for API calls */
    private readonly client: AxiosInstance;

    /** WhatsApp configuration from environment variables */
    private readonly config: {
        apiUrl: string;
        phoneNumberId: string;
        accessToken: string;
        businessAccountId: string;
        apiVersion: string;
    };

    /** Available message templates */
    private readonly templates: Map<string, (data: WhatsAppMessageData) => string>;

    /**
     * Creates an instance of WhatsAppService
     */
    constructor() {
        this.config = {
            apiUrl: process.env.WHATSAPP_API_URL || 'https://graph.facebook.com',
            phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
            accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
            businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
            apiVersion: process.env.WHATSAPP_API_VERSION || 'v18.0',
        };

        this.client = this.createClient();
        this.templates = new Map();
        this.registerTemplates();
    }

    /**
     * Creates and configures the Axios client
     * @returns {AxiosInstance} Configured Axios instance
     */
    private createClient(): AxiosInstance {
        return axios.create({
            baseURL: `${this.config.apiUrl}/${this.config.apiVersion}`,
            headers: {
                'Authorization': `Bearer ${this.config.accessToken}`,
                'Content-Type': 'application/json',
            },
            timeout: 30000,
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
     * @param {WhatsAppMessageData} data Template data
     * @returns {string} Generated message
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
     * @param {WhatsAppMessageData} data Template data
     * @returns {string} Generated message
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
     * @param {WhatsAppMessageData} data Template data
     * @returns {string} Generated message
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
     * @param {WhatsAppMessageData} data Template data
     * @returns {string} Generated message
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
     * @param {WhatsAppMessageData} data Template data
     * @returns {string} Generated message
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
     * Formats phone number to WhatsApp format (removes special characters and adds country code)
     * @param {string} phoneNumber Phone number to format
     * @returns {string} Formatted phone number
     */
    private formatPhoneNumber(phoneNumber: string): string {
        // Remove all non-digit characters
        let cleaned = phoneNumber.replace(/\D/g, '');
        
        // If doesn't start with country code, you might want to add default country code
        // Example: if (cleaned.length === 10) cleaned = '1' + cleaned; // US default
        
        return cleaned;
    }

    /**
     * Replaces placeholders in a string with provided data
     * @param {string} template Template string with placeholders
     * @param {WhatsAppMessageData} data Data to replace placeholders
     * @returns {string} String with replaced values
     */
    private replacePlaceholders(template: string, data: WhatsAppMessageData): string {
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            return data[key]?.toString() || match;
        });
    }

    /**
     * Uploads media to WhatsApp servers
     * @param {string} filePath Path to the media file
     * @returns {Promise<string>} Media ID
     */
    private async uploadMedia(filePath: string): Promise<string> {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath));
        formData.append('type', this.getMediaType(filePath));
        formData.append('messaging_product', 'whatsapp');

        const response = await axios.post(
            `${this.config.apiUrl}/${this.config.apiVersion}/${this.config.phoneNumberId}/media`,
            formData,
            {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`,
                    ...formData.getHeaders(),
                },
            }
        );

        return response.data.id;
    }

    /**
     * Determines media type based on file extension
     * @param {string} filePath Path to the file
     * @returns {string} Media type
     */
    private getMediaType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: { [key: string]: string } = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.pdf': 'application/pdf',
            '.mp4': 'video/mp4',
            '.mp3': 'audio/mpeg',
        };
        return mimeTypes[ext] || 'application/octet-stream';
    }

    /**
     * Centralized error handling for WhatsApp operations
     * @template R Return type
     * @param {() => Promise<R>} operation The operation to execute
     * @param {string} errorMessage Custom error message
     * @returns {Promise<R>} Result of the operation
     */
    private async executeWithErrorHandling<R>(
        operation: () => Promise<R>,
        errorMessage: string = 'WhatsApp operation failed'
    ): Promise<R> {
        try {
            return await operation();
        } catch (error) {
            console.error(errorMessage, error);
            if (axios.isAxiosError(error)) {
                const apiError = error.response?.data?.error?.message || error.message;
                throw new Error(`${errorMessage}: ${apiError}`);
            }
            throw new Error(`${errorMessage}: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * Sends a text message via WhatsApp
     * @param {string} to Recipient phone number
     * @param {string} message Message content
     * @returns {Promise<WhatsAppResponse>} Response from WhatsApp API
     */
    public async sendTextMessage(to: string, message: string): Promise<WhatsAppResponse> {
        return this.executeWithErrorHandling(async () => {
            const formattedNumber = this.formatPhoneNumber(to);

            const payload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: formattedNumber,
                type: 'text',
                text: {
                    preview_url: true,
                    body: message,
                },
            };

            const response: AxiosResponse = await this.client.post(
                `/${this.config.phoneNumberId}/messages`,
                payload
            );

            return {
                success: true,
                messageId: response.data.messages[0].id,
                details: response.data,
            };
        }, 'Failed to send text message');
    }

    /**
     * Sends an image message via WhatsApp
     * @param {string} to Recipient phone number
     * @param {object} image Image configuration
     * @param {string} [image.url] URL of the image
     * @param {string} [image.path] Local path to the image
     * @param {string} [image.caption] Optional caption for the image
     * @returns {Promise<WhatsAppResponse>} Response from WhatsApp API
     */
    public async sendImageMessage(
        to: string,
        image: { url?: string; path?: string; caption?: string }
    ): Promise<WhatsAppResponse> {
        return this.executeWithErrorHandling(async () => {
            const formattedNumber = this.formatPhoneNumber(to);
            let mediaId: string | undefined;

            // If local path is provided, upload the image first
            if (image.path) {
                mediaId = await this.uploadMedia(image.path);
            }

            const payload: any = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: formattedNumber,
                type: 'image',
                image: {},
            };

            // Use media ID if uploaded, otherwise use URL
            if (mediaId) {
                payload.image.id = mediaId;
            } else if (image.url) {
                payload.image.link = image.url;
            } else {
                throw new Error('Either image URL or path must be provided');
            }

            // Add caption if provided
            if (image.caption) {
                payload.image.caption = image.caption;
            }

            const response: AxiosResponse = await this.client.post(
                `/${this.config.phoneNumberId}/messages`,
                payload
            );

            return {
                success: true,
                messageId: response.data.messages[0].id,
                details: response.data,
            };
        }, 'Failed to send image message');
    }

    /**
     * Sends a message with buttons (interactive message)
     * @param {string} to Recipient phone number
     * @param {string} message Message content
     * @param {Array} buttons Array of button objects
     * @returns {Promise<WhatsAppResponse>} Response from WhatsApp API
     */
    public async sendButtonMessage(
        to: string,
        message: string,
        buttons: Array<{ id: string; title: string }>
    ): Promise<WhatsAppResponse> {
        return this.executeWithErrorHandling(async () => {
            const formattedNumber = this.formatPhoneNumber(to);

            // WhatsApp only supports up to 3 buttons
            const limitedButtons = buttons.slice(0, 3).map(btn => ({
                type: 'reply',
                reply: {
                    id: btn.id,
                    title: btn.title.substring(0, 20), // Max 20 characters
                },
            }));

            const payload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: formattedNumber,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: {
                        text: message,
                    },
                    action: {
                        buttons: limitedButtons,
                    },
                },
            };

            const response: AxiosResponse = await this.client.post(
                `/${this.config.phoneNumberId}/messages`,
                payload
            );

            return {
                success: true,
                messageId: response.data.messages[0].id,
                details: response.data,
            };
        }, 'Failed to send button message');
    }

    /**
     * Sends a message using the flexible configuration
     * @param {WhatsAppMessageConfig} config Message configuration
     * @returns {Promise<WhatsAppResponse>} Response from WhatsApp API
     */
    public async send(config: WhatsAppMessageConfig): Promise<WhatsAppResponse> {
        return this.executeWithErrorHandling(async () => {
            const { to, message, template, data, image, buttons } = config;
            
            let messageText = message;

            // If template is specified, generate message from template
            if (template && this.templates.has(template)) {
                const templateFn = this.templates.get(template)!;
                messageText = templateFn(data || {});
            } else if (template) {
                throw new Error(`Template "${template}" not found`);
            }

            // Replace placeholders if data is provided
            if (messageText && data) {
                messageText = this.replacePlaceholders(messageText, data);
            }

            // Send image if provided
            if (image) {
                return await this.sendImageMessage(to, {
                    ...image,
                    caption: image.caption || messageText,
                });
            }

            // Send button message if buttons are provided
            if (buttons && buttons.length > 0) {
                if (!messageText) {
                    throw new Error('Message text is required for button messages');
                }
                return await this.sendButtonMessage(to, messageText, buttons);
            }

            // Default to text message
            if (!messageText) {
                throw new Error('Message text is required');
            }
            return await this.sendTextMessage(to, messageText);
        }, 'Failed to send WhatsApp message');
    }

    /**
     * Sends a welcome message
     * @param {string} to Recipient phone number
     * @param {WhatsAppMessageData} data Template data
     * @returns {Promise<WhatsAppResponse>} Response from WhatsApp API
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
     * @param {string} to Recipient phone number
     * @param {WhatsAppMessageData} data Template data
     * @returns {Promise<WhatsAppResponse>} Response from WhatsApp API
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
     * @param {string} to Recipient phone number
     * @param {WhatsAppMessageData} data Template data
     * @returns {Promise<WhatsAppResponse>} Response from WhatsApp API
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
     * @param {string} to Recipient phone number
     * @param {WhatsAppMessageData} data Template data
     * @returns {Promise<WhatsAppResponse>} Response from WhatsApp API
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
     * @param {string} to Recipient phone number
     * @param {WhatsAppMessageData} data Template data
     * @returns {Promise<WhatsAppResponse>} Response from WhatsApp API
     */
    public async sendNotificationMessage(to: string, data: WhatsAppMessageData): Promise<WhatsAppResponse> {
        return this.send({
            to,
            template: 'notification',
            data,
        });
    }

    /**
     * Marks a message as read
     * @param {string} messageId ID of the message to mark as read
     * @returns {Promise<WhatsAppResponse>} Response from WhatsApp API
     */
    public async markAsRead(messageId: string): Promise<WhatsAppResponse> {
        return this.executeWithErrorHandling(async () => {
            const payload = {
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId,
            };

            const response: AxiosResponse = await this.client.post(
                `/${this.config.phoneNumberId}/messages`,
                payload
            );

            return {
                success: true,
                details: response.data,
            };
        }, 'Failed to mark message as read');
    }

    /**
     * Registers a custom template
     * @param {string} name Template name
     * @param {(data: WhatsAppMessageData) => string} templateFn Template function
     */
    public registerCustomTemplate(
        name: string,
        templateFn: (data: WhatsAppMessageData) => string
    ): void {
        this.templates.set(name, templateFn);
    }

    /**
     * Verifies the WhatsApp Business API configuration
     * @returns {Promise<boolean>} True if verification succeeds
     */
    public async verifyConnection(): Promise<boolean> {
        return this.executeWithErrorHandling(async () => {
            const response = await this.client.get(`/${this.config.phoneNumberId}`);
            console.log('WhatsApp service is ready:', response.data);
            return true;
        }, 'WhatsApp service verification failed');
    }

    /**
     * Gets webhook verification token (for initial webhook setup)
     * @param {string} mode Verification mode
     * @param {string} token Verification token
     * @param {string} challenge Challenge string from WhatsApp
     * @returns {string | null} Challenge if valid, null otherwise
     */
    public verifyWebhook(mode: string, token: string, challenge: string): string | null {
        const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || '';
        
        if (mode === 'subscribe' && token === verifyToken) {
            console.log('Webhook verified successfully');
            return challenge;
        }
        
        console.log('Webhook verification failed');
        return null;
    }
}

export default WhatsAppService;