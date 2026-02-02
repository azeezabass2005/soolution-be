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
                <div style="padding: 10px 0; border-bottom: 1px solid #E5E5E5;">
                    <div style="display: inline-block; width: 24px; height: 24px; background-color: ${this.theme.primaryColor}; opacity: 0.1; vertical-align: middle; margin-right: 10px;"></div>
                    <div style="display: inline-block; vertical-align: middle;">
                        <p style="margin: 0; font-weight: 600; color: ${this.theme.textDark}; font-size: 13px; line-height: 1.4;">${att.filename}</p>
                        <p style="margin: 2px 0 0 0; color: #666; font-size: 12px; line-height: 1.3;">${att.contentType || 'Attachment'}</p>
                    </div>
                </div>
            `).join('');

        return `
            <div style="margin: 24px 0 0 0; padding-top: 20px; border-top: 1px solid #E5E5E5;">
                <p style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: ${this.theme.textDark};">
                    Attachments (${attachments.filter(att => !att.cid).length})
                </p>
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
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #F5F5F5; padding: 16px 0;">
        <tr>
            <td align="center">
                <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; background-color: ${this.theme.lightBackground};">
                    <!-- Header -->
                    <tr>
                        <td style="background-color: ${this.theme.primaryColor}; padding: 16px 24px;">
                            <h1 style="margin: 0; color: ${this.theme.lightBackground}; font-size: 20px; font-weight: 600; letter-spacing: -0.3px;">SolutionPay</h1>
                        </td>
                    </tr>
                    
                    <!-- Content -->
                    <tr>
                        <td style="padding: 24px;">
                            ${content}
                            ${attachmentsSection}
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #FAFAFA; padding: 20px 24px; border-top: 1px solid #E5E5E5;">
                            <p style="margin: 0 0 8px 0; font-size: 12px; color: #666; line-height: 1.5; text-align: center;">
                                © ${new Date().getFullYear()} SolutionPay. All rights reserved.
                            </p>
                            <p style="margin: 0; font-size: 11px; color: #999; line-height: 1.4; text-align: center;">
                                Empowering businesses to expand globally
                            </p>
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
            <h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: ${this.theme.textDark}; letter-spacing: -0.3px;">
                Welcome to SolutionPay
            </h2>
            <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #333;">
                Hi <strong>${data.name || 'there'}</strong>,
            </p>
            <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.6; color: #333;">
                We're thrilled to have you on board! Your account has been successfully created and you're all set to get started.
            </p>
            <div style="background-color: #F8F9FA; border-left: 3px solid ${this.theme.primaryColor}; padding: 14px 16px; margin: 20px 0;">
                <p style="margin: 0 0 6px 0; font-weight: 600; font-size: 14px; color: ${this.theme.textDark};">What's next?</p>
                <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #555;">
                    Explore our features, customize your profile, and make the most of your experience with us.
                </p>
            </div>
            ${data.actionUrl ? `
            <div style="text-align: center; margin: 24px 0 20px 0;">
                <a href="${data.actionUrl}" style="display: inline-block; background-color: ${this.theme.primaryColor}; color: white; padding: 12px 28px; text-decoration: none; font-weight: 600; font-size: 14px; border-radius: 0;">
                    Get Started
                </a>
            </div>
            ` : ''}
            <p style="margin: 20px 0 0 0; font-size: 14px; line-height: 1.6; color: #333;">
                If you have any questions or need assistance, our support team is always here to help.
            </p>
            <p style="margin: 16px 0 0 0; font-size: 14px; line-height: 1.6; color: #333;">
                Best regards,<br>
                <strong>The SolutionPay Team</strong>
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
        const warningIcon = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align: middle; margin-right: 6px;"><path d="M8 0L0 14h16L8 0zm0 4v6h1.5V4H8zm0 8a1 1 0 100-2 1 1 0 000 2z" fill="#DC2626"/></svg>`;
        
        const content = `
            <h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: ${this.theme.textDark}; letter-spacing: -0.3px;">
                Reset Your Password
            </h2>
            <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #333;">
                Hi <strong>${data.name || 'there'}</strong>,
            </p>
            <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.6; color: #333;">
                We received a request to reset your password. Click the button below to create a new password:
            </p>
            ${data.resetUrl ? `
            <div style="text-align: center; margin: 24px 0;">
                <a href="${data.resetUrl}" style="display: inline-block; background-color: ${this.theme.primaryColor}; color: white; padding: 12px 28px; text-decoration: none; font-weight: 600; font-size: 14px; border-radius: 0;">
                    Reset Password
                </a>
            </div>
            ` : ''}
            ${data.code ? `
            <p style="margin: ${data.resetUrl ? '16px' : '24px'} 0 12px 0; font-size: 14px; color: #333;">Or use this verification code:</p>
            <div style="background-color: #F8F9FA; border: 2px solid ${this.theme.primaryColor}; padding: 16px; text-align: center; margin: 0 0 20px 0;">
                <span style="font-family: 'Courier New', monospace; font-size: 24px; font-weight: 700; letter-spacing: 4px; color: ${this.theme.primaryColor};">
                    ${data.code}
                </span>
            </div>
            ` : ''}
            <div style="background-color: #FEF2F2; border-left: 3px solid #DC2626; padding: 14px 16px; margin: 20px 0;">
                <p style="margin: 0 0 6px 0; font-weight: 600; font-size: 14px; color: ${this.theme.textDark};">
                    ${warningIcon}Important
                </p>
                <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #555;">
                    This link will expire in <strong>${data.expiryTime || '1 hour'}</strong>. If you didn't request a password reset, please ignore this email.
                </p>
            </div>
            <p style="margin: 16px 0 12px 0; font-size: 14px; line-height: 1.6; color: #666;">
                For security reasons, never share this link or code with anyone.
            </p>
            <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #333;">
                Best regards,<br>
                <strong>The SolutionPay Team</strong>
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
            <h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: ${this.theme.textDark}; letter-spacing: -0.3px;">
                Verify Your Email
            </h2>
            <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #333;">
                Hi <strong>${data.name || 'there'}</strong>,
            </p>
            <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.6; color: #333;">
                Thank you for signing up! To complete your registration, please verify your email address.
            </p>
            ${data.verificationUrl ? `
            <div style="text-align: center; margin: 24px 0;">
                <a href="${data.verificationUrl}" style="display: inline-block; background-color: ${this.theme.primaryColor}; color: white; padding: 12px 28px; text-decoration: none; font-weight: 600; font-size: 14px; border-radius: 0;">
                    Verify Email
                </a>
            </div>
            ` : ''}
            ${data.code ? `
            <p style="margin: ${data.verificationUrl ? '16px' : '24px'} 0 12px 0; font-size: 14px; color: #333;">Or enter this verification code in the app:</p>
            <div style="background-color: #F8F9FA; border: 2px solid ${this.theme.primaryColor}; padding: 16px; text-align: center; margin: 0 0 20px 0;">
                <span style="font-family: 'Courier New', monospace; font-size: 24px; font-weight: 700; letter-spacing: 4px; color: ${this.theme.primaryColor};">
                    ${data.code}
                </span>
            </div>
            ` : ''}
            <p style="margin: 20px 0 12px 0; font-size: 14px; line-height: 1.6; color: #666;">
                This verification link will expire in <strong>${data.expiryTime || '24 hours'}</strong>. If you didn't create an account, you can safely ignore this email.
            </p>
            <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #333;">
                Best regards,<br>
                <strong>The SolutionPay Team</strong>
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
            <h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: ${this.theme.textDark}; letter-spacing: -0.3px;">
                ${data.title || 'Notification'}
            </h2>
            <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #333;">
                Hi <strong>${data.name || 'there'}</strong>,
            </p>
            <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.6; color: #333;">
                ${data.message || 'You have a new notification.'}
            </p>
            ${data.actionUrl ? `
            <div style="text-align: center; margin: 24px 0 20px 0;">
                <a href="${data.actionUrl}" style="display: inline-block; background-color: ${this.theme.primaryColor}; color: white; padding: 12px 28px; text-decoration: none; font-weight: 600; font-size: 14px; border-radius: 0;">
                    ${data.buttonText || 'View Details'}
                </a>
            </div>
            ` : ''}
            ${data.additionalInfo ? `
            <div style="background-color: #F8F9FA; border-left: 3px solid ${this.theme.primaryColor}; padding: 14px 16px; margin: 20px 0;">
                <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #555;">
                    ${data.additionalInfo}
                </p>
            </div>
            ` : ''}
            <p style="margin: 20px 0 0 0; font-size: 14px; line-height: 1.6; color: #333;">
                Best regards,<br>
                <strong>The SolutionPay Team</strong>
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
            subject: `Welcome to ${data.appName || 'SolutionPay'}!`,
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