import nodemailer, { Transporter, SendMailOptions } from 'nodemailer';
import config from '../config/env.config';

/**
 * Represents the structure of email template data
 */
interface EmailTemplateData {
    [key: string]: string | number | boolean | undefined;
}

/**
 * Represents an email attachment
 */
interface EmailAttachment {
    filename: string;
    content?: Buffer | string;
    path?: string;
    contentType?: string;
    cid?: string; // Content-ID for embedded images
}

/**
 * Configuration for email sending
 */
interface EmailConfig {
    to: string | string[];
    subject: string;
    template?: string;
    data?: EmailTemplateData;
    html?: string;
    text?: string;
    cc?: string | string[];
    bcc?: string | string[];
    attachments?: EmailAttachment[];
}

/**
 * Theme configuration for email templates
 */
interface EmailTheme {
    primaryColor: string;
    darkBackground: string;
    lightBackground: string;
    textDark: string;
    textLight: string;
}

/**
 * A comprehensive email service that provides email sending functionality
 * with custom templating and theme support
 */
class EmailService {
    /** Nodemailer transporter instance */
    private readonly transporter: Transporter;

    /** Email configuration from environment variables */
    private readonly config: {
        host: string;
        port: number;
        secure: boolean;
        username: string;
        password: string;
        from: string;
    };

    /** Theme configuration for email templates */
    private readonly theme: EmailTheme;

    /** Available email templates */
    private readonly templates: Map<string, (data: EmailTemplateData) => string>;

    /**
     * Creates an instance of EmailService
     */
    constructor() {
        this.config = {
            host: config.MAIL_HOST || '',
            port: parseInt(config.MAIL_PORT || '587'),
            secure: config.MAIL_SECURE === 'true',
            username: config.MAIL_USERNAME || '',
            password: config.MAIL_PASSWORD || '',
            from: config.MAIL_FROM || '',
        };

        this.theme = {
            primaryColor: '#9D4DFE',
            darkBackground: '#0A0A0A',
            lightBackground: '#FFFFFF',
            textDark: '#0A0A0A',
            textLight: '#FFFFFF',
        };

        this.transporter = this.createTransporter();
        this.templates = new Map();
        this.registerTemplates();
    }

    /**
     * Creates and configures the nodemailer transporter
     * @returns {Transporter} Configured nodemailer transporter
     */
    private createTransporter(): Transporter {
        return nodemailer.createTransport({
            host: this.config.host,
            port: this.config.port,
            secure: this.config.secure,
            auth: {
                user: this.config.username,
                pass: this.config.password,
            },
        });
    }

    /**
     * Registers all available email templates
     */
    private registerTemplates(): void {
        this.templates.set('welcome', this.welcomeTemplate.bind(this));
        this.templates.set('reset-password', this.resetPasswordTemplate.bind(this));
        this.templates.set('verification', this.verificationTemplate.bind(this));
        this.templates.set('notification', this.notificationTemplate.bind(this));
    }

    /**
     * Generates attachment section HTML
     * @param {EmailAttachment[]} attachments Array of attachments
     * @returns {string} HTML for attachments section
     */
    private generateAttachmentsSection(attachments: EmailAttachment[] = []): string {
        if (!attachments || attachments.length === 0) return '';

        const attachmentItems = attachments
            .filter(att => !att.cid) // Exclude inline images
            .map(att => `
                <div style="display: flex; align-items: center; padding: 16px; background-color: rgba(0, 0, 0, 0.03); margin-bottom: 8px;">
                    <div style="width: 30px; height: 30px; background-color: ${this.theme.primaryColor}; display: flex; align-items: center; justify-content: center; margin-right: 12px;"></div>
                    <div style="flex: 1;">
                        <p style="margin: 0; font-weight: 600; color: ${this.theme.textDark}; font-size: 14px;">${att.filename}</p>
                        <p style="margin: 0; color: #666; font-size: 12px;">${att.contentType || 'Attachment'}</p>
                    </div>
                </div>
            `).join('');

        return `
            <div style="margin: 32px 0; padding: 24px; background-color: rgba(0, 0, 0, 0.02);">
                <div style="display: flex; align-items: center; margin-bottom: 16px;">
                    <div style="width: 4px; height: 24px; background-color: ${this.theme.primaryColor}; margin-right: 12px;"></div>
                    <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: ${this.theme.textDark};">
                        Attachments (${attachments.filter(att => !att.cid).length})
                    </h3>
                </div>
                ${attachmentItems}
            </div>
        `;
    }

    /**
     * Generates the base HTML structure for all email templates
     * @param {string} content The main content to inject into the template
     * @param {EmailAttachment[]} attachments Array of attachments
     * @returns {string} Complete HTML email structure
     */
    private generateBaseTemplate(content: string, attachments: EmailAttachment[] = []): string {
        const attachmentsSection = this.generateAttachmentsSection(attachments);

        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <title>Email</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: ${this.theme.textDark}; background-color: #F5F5F5;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #F5F5F5; padding: 40px 20px;">
        <tr>
            <td align="center">
                <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; background-color: ${this.theme.lightBackground};">
                    <!-- Header -->
                    <tr>
                        <td style="background-color: ${this.theme.primaryColor}; padding: 40px 30px; text-align: center;">
                            <div style="display: inline-flex; align-items: center; justify-content: center; margin-bottom: 12px;">
                                <h1 style="margin: 0; color: ${this.theme.lightBackground}; font-size: 24px; font-weight: 600;">Soolution</h1>
                            </div>
                        </td>
                    </tr>
                    
                    <!-- Content -->
                    <tr>
                        <td style="padding: 40px 30px;">
                            ${content}
                            ${attachmentsSection}
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #FAFAFA; padding: 30px; text-align: center;">
                            <p style="margin: 0 0 12px 0; font-size: 14px; color: #666;">
                                © ${new Date().getFullYear()} Soolution. All rights reserved.
                            </p>
                            <p style="margin: 0; font-size: 12px; color: #999;">
                                Empowering businesses to expand globally
                            </p>
                            <div style="margin-top: 16px;">
                                <a href="#" style="display: inline-block; width: 32px; height: 32px; background-color: rgba(0, 0, 0, 0.05); text-decoration: none; margin: 0 4px; line-height: 32px;">📧</a>
                                <a href="#" style="display: inline-block; width: 32px; height: 32px; background-color: rgba(0, 0, 0, 0.05); text-decoration: none; margin: 0 4px; line-height: 32px;">🐦</a>
                                <a href="#" style="display: inline-block; width: 32px; height: 32px; background-color: rgba(0, 0, 0, 0.05); text-decoration: none; margin: 0 4px; line-height: 32px;">💼</a>
                            </div>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
        `.trim();
    }

    /**
     * Welcome email template
     * @param {EmailTemplateData} data Template data
     * @returns {string} Generated HTML
     */
    private welcomeTemplate(data: EmailTemplateData): string {
        const content = `
            <h2 style="margin: 0 0 24px 0; font-size: 28px; font-weight: 600; color: ${this.theme.textDark};">
                Welcome to Soolution! 🎉
            </h2>
            
            <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.8; color: #333;">
                Hi <strong>${data.name || 'there'}</strong>,
            </p>
            
            <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.8; color: #333;">
                We're thrilled to have you on board! Your account has been successfully created and you're all set to get started.
            </p>
            
            <div style="background-color: rgba(255, 130, 130, 0.05); padding: 24px; margin: 24px 0;">
                <div style="display: flex; align-items: center; margin-bottom: 12px;">
                    <div style="width: 4px; height: 20px; background-color: ${this.theme.primaryColor}; margin-right: 12px;"></div>
                    <p style="margin: 0; font-weight: 600; font-size: 16px; color: ${this.theme.textDark};">What's next?</p>
                </div>
                <p style="margin: 0; font-size: 15px; line-height: 1.7; color: #555;">
                    Explore our features, customize your profile, and make the most of your experience with us.
                </p>
            </div>
            
            ${data.actionUrl ? `
                <div style="text-align: center; margin: 32px 0;">
                    <a href="${data.actionUrl}" style="display: inline-block; background-color: ${this.theme.primaryColor}; color: white; padding: 16px 40px; text-decoration: none; font-weight: 600; font-size: 16px; transition: opacity 0.3s;">
                        Get Started →
                    </a>
                </div>
            ` : ''}
            
            <p style="margin: 24px 0 0 0; font-size: 16px; line-height: 1.8; color: #333;">
                If you have any questions or need assistance, our support team is always here to help.
            </p>
            
            <p style="margin: 24px 0 0 0; font-size: 16px; line-height: 1.8; color: #333;">
                Best regards,<br>
                <strong>The Soolution Team</strong>
            </p>
        `;
        return content;
    }

    /**
     * Password reset email template
     * @param {EmailTemplateData} data Template data
     * @returns {string} Generated HTML
     */
    private resetPasswordTemplate(data: EmailTemplateData): string {
        const content = `
            <h2 style="margin: 0 0 24px 0; font-size: 28px; font-weight: 600; color: ${this.theme.textDark};">
                Reset Your Password 🔐
            </h2>
            
            <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.8; color: #333;">
                Hi <strong>${data.name || 'there'}</strong>,
            </p>
            
            <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.8; color: #333;">
                We received a request to reset your password. Click the button below to create a new password:
            </p>
            
            ${data.resetUrl ? `
                <div style="text-align: center; margin: 32px 0;">
                    <a href="${data.resetUrl}" style="display: inline-block; background-color: ${this.theme.primaryColor}; color: white; padding: 16px 40px; text-decoration: none; font-weight: 600; font-size: 16px;">
                        Reset Password →
                    </a>
                </div>
            ` : ''}
            
            ${data.code ? `
                <p style="margin: 24px 0 12px 0; font-size: 16px; color: #333;">Or use this verification code:</p>
                <div style="background-color: rgba(0, 0, 0, 0.03); padding: 20px; text-align: center; margin: 16px 0;">
                    <span style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: 600; letter-spacing: 8px; color: ${this.theme.primaryColor};">
                        ${data.code}
                    </span>
                </div>
            ` : ''}
            
            <div style="height: 1px; background-color: rgba(0, 0, 0, 0.1); margin: 32px 0;"></div>
            
            <div style="background-color: rgba(255, 130, 130, 0.05); padding: 20px; margin: 24px 0;">
                <p style="margin: 0 0 8px 0; font-weight: 600; font-size: 15px; color: ${this.theme.textDark};">⚠️ Important:</p>
                <p style="margin: 0; font-size: 14px; line-height: 1.7; color: #555;">
                    This link will expire in <strong>${data.expiryTime || '1 hour'}</strong>. If you didn't request a password reset, please ignore this email or contact support if you have concerns.
                </p>
            </div>
            
            <p style="margin: 24px 0 0 0; font-size: 15px; line-height: 1.8; color: #666;">
                For security reasons, never share this link or code with anyone.
            </p>
            
            <p style="margin: 24px 0 0 0; font-size: 16px; line-height: 1.8; color: #333;">
                Best regards,<br>
                <strong>The Soolution Team</strong>
            </p>
        `;
        return content;
    }

    /**
     * Email verification template
     * @param {EmailTemplateData} data Template data
     * @returns {string} Generated HTML
     */
    private verificationTemplate(data: EmailTemplateData): string {
        const content = `
            <h2 style="margin: 0 0 24px 0; font-size: 28px; font-weight: 600; color: ${this.theme.textDark};">
                Verify Your Email ✨
            </h2>
            
            <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.8; color: #333;">
                Hi <strong>${data.name || 'there'}</strong>,
            </p>
            
            <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.8; color: #333;">
                Thank you for signing up! To complete your registration, please verify your email address.
            </p>
            
            ${data.verificationUrl ? `
                <div style="text-align: center; margin: 32px 0;">
                    <a href="${data.verificationUrl}" style="display: inline-block; background-color: ${this.theme.primaryColor}; color: white; padding: 16px 40px; text-decoration: none; font-weight: 600; font-size: 16px;">
                        Verify Email →
                    </a>
                </div>
            ` : ''}
            
            ${data.code ? `
                <p style="margin: 24px 0 12px 0; font-size: 16px; color: #333;">Or enter this verification code in the app:</p>
                <div style="background-color: rgba(0, 0, 0, 0.03); padding: 20px; text-align: center; margin: 16px 0;">
                    <span style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: 600; letter-spacing: 8px; color: ${this.theme.primaryColor};">
                        ${data.code}
                    </span>
                </div>
            ` : ''}
            
            <div style="height: 1px; background-color: rgba(0, 0, 0, 0.1); margin: 32px 0;"></div>
            
            <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.8; color: #666;">
                This verification link will expire in <strong>${data.expiryTime || '24 hours'}</strong>.
            </p>
            
            <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.8; color: #666;">
                If you didn't create an account, you can safely ignore this email.
            </p>
            
            <p style="margin: 24px 0 0 0; font-size: 16px; line-height: 1.8; color: #333;">
                Best regards,<br>
                <strong>The Soolution Team</strong>
            </p>
        `;
        return content;
    }

    /**
     * General notification email template
     * @param {EmailTemplateData} data Template data
     * @returns {string} Generated HTML
     */
    private notificationTemplate(data: EmailTemplateData): string {
        const content = `
            <h2 style="margin: 0 0 24px 0; font-size: 28px; font-weight: 600; color: ${this.theme.textDark};">
                ${data.title || 'Notification'} 📬
            </h2>
            
            <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.8; color: #333;">
                Hi <strong>${data.name || 'there'}</strong>,
            </p>
            
            <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.8; color: #333;">
                ${data.message || 'You have a new notification.'}
            </p>
            
            ${data.actionUrl ? `
                <div style="text-align: center; margin: 32px 0;">
                    <a href="${data.actionUrl}" style="display: inline-block; background-color: ${this.theme.primaryColor}; color: white; padding: 16px 40px; text-decoration: none; font-weight: 600; font-size: 16px;">
                        ${data.buttonText || 'View Details'} →
                    </a>
                </div>
            ` : ''}
            
            ${data.additionalInfo ? `
                <div style="background-color: rgba(255, 130, 130, 0.05); padding: 24px; margin: 24px 0;">
                    <p style="margin: 0; font-size: 15px; line-height: 1.7; color: #555;">
                        ${data.additionalInfo}
                    </p>
                </div>
            ` : ''}
            
            <p style="margin: 24px 0 0 0; font-size: 16px; line-height: 1.8; color: #333;">
                Best regards,<br>
                <strong>The Soolution Team</strong>
            </p>
        `;
        return content;
    }

    /**
     * Replaces placeholders in a string with provided data
     * @param {string} template Template string with placeholders
     * @param {EmailTemplateData} data Data to replace placeholders
     * @returns {string} String with replaced values
     */
    private replacePlaceholders(template: string, data: EmailTemplateData): string {
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            return data[key]?.toString() || match;
        });
    }

    /**
     * Centralized error handling for email operations
     * @template R Return type
     * @param {() => Promise<R>} operation The operation to execute
     * @param {string} errorMessage Custom error message
     * @returns {Promise<R>} Result of the operation
     */
    private async executeWithErrorHandling<R>(
        operation: () => Promise<R>,
        errorMessage: string = 'Email operation failed'
    ): Promise<R> {
        try {
            return await operation();
        } catch (error) {
            console.error(errorMessage, error);
            throw new Error(`${errorMessage}: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * Sends an email with the specified configuration
     * @param {EmailConfig} config Email configuration
     * @returns {Promise<any>} Result of the send operation
     */
    public async send(config: EmailConfig): Promise<any> {
        return this.executeWithErrorHandling(async () => {
            const { to, subject, template, data, html, text, cc, bcc, attachments } = config;

            let emailHtml = html;
            let emailText = text;

            // If template is specified, generate HTML from template
            if (template && this.templates.has(template)) {
                const templateFn = this.templates.get(template)!;
                const templateContent = templateFn(data || {});
                emailHtml = this.generateBaseTemplate(templateContent, attachments);
            } else if (template) {
                throw new Error(`Template "${template}" not found`);
            } else if (html) {
                // Wrap custom HTML in base template
                emailHtml = this.generateBaseTemplate(html, attachments);
            }

            // If HTML is provided as a string with placeholders, replace them
            if (emailHtml && data) {
                emailHtml = this.replacePlaceholders(emailHtml, data);
            }

            const mailOptions: SendMailOptions = {
                from: this.config.from,
                to: Array.isArray(to) ? to.join(', ') : to,
                subject,
                html: emailHtml,
                text: emailText,
                cc: cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
                bcc: bcc ? (Array.isArray(bcc) ? bcc.join(', ') : bcc) : undefined,
                attachments,
            };

            return await this.transporter.sendMail(mailOptions);
        }, 'Failed to send email');
    }

    /**
     * Sends a welcome email
     * @param {string} to Recipient email
     * @param {EmailTemplateData} data Template data
     * @param {EmailAttachment[]} attachments Optional attachments
     * @returns {Promise<any>} Result of the send operation
     */
    public async sendWelcomeEmail(
        to: string, 
        data: EmailTemplateData,
        attachments?: EmailAttachment[]
    ): Promise<any> {
        return this.send({
            to,
            subject: `Welcome to ${data.appName || 'Soolution'}!`,
            template: 'welcome',
            data,
            attachments,
        });
    }

    /**
     * Sends a password reset email
     * @param {string} to Recipient email
     * @param {EmailTemplateData} data Template data
     * @param {EmailAttachment[]} attachments Optional attachments
     * @returns {Promise<any>} Result of the send operation
     */
    public async sendPasswordResetEmail(
        to: string, 
        data: EmailTemplateData,
        attachments?: EmailAttachment[]
    ): Promise<any> {
        return this.send({
            to,
            subject: 'Reset Your Password',
            template: 'reset-password',
            data,
            attachments,
        });
    }

    /**
     * Sends an email verification email
     * @param {string} to Recipient email
     * @param {EmailTemplateData} data Template data
     * @param {EmailAttachment[]} attachments Optional attachments
     * @returns {Promise<any>} Result of the send operation
     */
    public async sendVerificationEmail(
        to: string, 
        data: EmailTemplateData,
        attachments?: EmailAttachment[]
    ): Promise<any> {
        return this.send({
            to,
            subject: 'Verify Your Email Address',
            template: 'verification',
            data,
            attachments,
        });
    }

    /**
     * Sends a notification email
     * @param {string} to Recipient email
     * @param {EmailTemplateData} data Template data
     * @param {EmailAttachment[]} attachments Optional attachments
     * @returns {Promise<any>} Result of the send operation
     */
    public async sendNotificationEmail(
        to: string, 
        data: EmailTemplateData,
        attachments?: EmailAttachment[]
    ): Promise<any> {
        return this.send({
            to,
            subject: data.title?.toString() || 'New Notification',
            template: 'notification',
            data,
            attachments,
        });
    }

    /**
     * Verifies the email configuration and connection
     * @returns {Promise<boolean>} True if verification succeeds
     */
    public async verifyConnection(): Promise<boolean> {
        return this.executeWithErrorHandling(async () => {
            await this.transporter.verify();
            console.log('Email service is ready to send emails');
            return true;
        }, 'Email service verification failed');
    }

    /**
     * Registers a custom template
     * @param {string} name Template name
     * @param {(data: EmailTemplateData) => string} templateFn Template function
     */
    public registerCustomTemplate(
        name: string,
        templateFn: (data: EmailTemplateData) => string
    ): void {
        this.templates.set(name, templateFn);
    }

    /**
     * Gets the base template generator for custom templates
     * @returns {(content: string, attachments?: EmailAttachment[]) => string} Base template function
     */
    public getBaseTemplateGenerator(): (content: string, attachments?: EmailAttachment[]) => string {
        return this.generateBaseTemplate.bind(this);
    }
}

export default EmailService;
export type { EmailAttachment, EmailConfig, EmailTemplateData };