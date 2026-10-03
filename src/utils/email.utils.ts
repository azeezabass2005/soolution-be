import nodemailer, { Transporter, SendMailOptions } from 'nodemailer';
import config from '../config/env.config';
import {
    attachmentsBlock, button, callout, codeBlock, emailLayout, escapeHtml, eyebrow, greeting, heading,
    htmlToText, paragraph, renderMessage, signoff, SIGNOFF_MARKER, splitTitle, startsWithGreeting, toneFromTitle,
} from './email-layout';

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
        this.templates.set('reset-pin', this.resetPinTemplate.bind(this));
        this.templates.set('verification', this.verificationTemplate.bind(this));
        this.templates.set('notification', this.notificationTemplate.bind(this));
    }

    /**
     * Wraps template content in the shared editorial layout
     * @param {string} content The main content to inject into the template
     * @param {EmailAttachment[]} attachments Array of attachments (listed under the content)
     * @param {string} title Document title (the subject)
     * @param {string} preheader Inbox preview text
     * @returns {string} Complete HTML email structure
     */
    private generateBaseTemplate(content: string, attachments: EmailAttachment[] = [], title: string = 'Solution Pay', preheader?: string): string {
        const listed = attachments.filter((att) => !att.cid).map((att) => ({ filename: att.filename, contentType: att.contentType }));
        const files = attachmentsBlock(listed);
        // Attachments sit just above the sign-off when the template has one
        const body = content.includes(SIGNOFF_MARKER) ? content.replace(SIGNOFF_MARKER, files) : `${content}${files}`;
        return emailLayout({ title, preheader, content: body });
    }

    /**
     * Welcome email template
     * @param {EmailTemplateData} data Template data
     * @returns {string} Generated HTML
     */
    private welcomeTemplate(data: EmailTemplateData): string {
        return `
            ${eyebrow('Welcome')}
            ${heading('Welcome to', 'Solution Pay.')}
            ${greeting(data.name)}
            ${paragraph("Your account is ready. You can now send money across borders, receive payments and pay suppliers, all from one wallet.")}
            ${callout('accent', "What's next", 'Set your transaction PIN, fund your wallet and complete verification to unlock higher limits.')}
            ${data.actionUrl ? button(String(data.actionUrl), String(data.buttonText || 'Get started'), { fallback: false }) : ''}
            ${paragraph('Questions along the way? Our support team is always happy to help.', { muted: true, small: true, margin: '24px 0 0 0' })}
            ${signoff()}
        `;
    }

    /**
     * Password reset email template
     * @param {EmailTemplateData} data Template data
     * @returns {string} Generated HTML
     */
    private resetPasswordTemplate(data: EmailTemplateData): string {
        return `
            ${eyebrow('Security')}
            ${heading('Reset your', 'password.')}
            ${greeting(data.name)}
            ${paragraph('We received a request to reset the password for your Solution Pay account. Use the button below to choose a new one.')}
            ${data.resetUrl ? button(String(data.resetUrl), 'Reset password') : ''}
            ${data.code ? codeBlock(String(data.code), data.resetUrl ? 'Or use this code' : 'Your reset code') : ''}
            ${callout('warning', 'Important', `This link expires in <strong>${escapeHtml(data.expiryTime || '1 hour')}</strong>. If you didn't ask for a reset, you can ignore this email and your password stays the same.`)}
            ${paragraph('For your security, never share this link or code with anyone.', { muted: true, small: true, margin: '20px 0 0 0' })}
            ${signoff()}
        `;
    }

    /**
     * Transaction PIN reset email template
     */
    private resetPinTemplate(data: EmailTemplateData): string {
        return `
            ${eyebrow('Security')}
            ${heading('Reset your transaction', 'PIN.')}
            ${greeting(data.name)}
            ${paragraph('We received a request to reset the 4-digit PIN you use to authorize sends and withdrawals on your Solution Pay account.')}
            ${data.resetUrl ? button(String(data.resetUrl), 'Reset transaction PIN') : ''}
            ${callout('warning', 'Important', `This link expires in <strong>${escapeHtml(data.expiryTime || '30 minutes')}</strong>. If you didn't ask for a PIN reset, ignore this email and your PIN stays unchanged.`)}
            ${paragraph('Never share this link with anyone, including Solution Pay support.', { muted: true, small: true, margin: '20px 0 0 0' })}
            ${signoff()}
        `;
    }

    /**
     * Email verification template
     * @param {EmailTemplateData} data Template data
     * @returns {string} Generated HTML
     */
    private verificationTemplate(data: EmailTemplateData): string {
        return `
            ${eyebrow('Verify')}
            ${heading('Confirm your', 'email.')}
            ${greeting(data.name)}
            ${paragraph('Thanks for signing up! Please confirm this is your email address to finish creating your account.')}
            ${data.verificationUrl ? button(String(data.verificationUrl), 'Verify email') : ''}
            ${data.code ? codeBlock(String(data.code), data.verificationUrl ? 'Or enter this code in the app' : 'Your verification code') : ''}
            ${paragraph(`This link expires in <strong>${escapeHtml(data.expiryTime || '24 hours')}</strong>. If you didn't create an account, you can safely ignore this email.`, { muted: true, small: true, margin: '24px 0 0 0' })}
            ${signoff()}
        `;
    }

    /**
     * General notification email template.
     * `message` may contain line breaks and "Label: value" lines (rendered as a details table)
     * and trusted inline markup from callers; `additionalInfo` renders as a note.
     * @param {EmailTemplateData} data Template data
     * @returns {string} Generated HTML
     */
    private notificationTemplate(data: EmailTemplateData): string {
        const [title, accent] = splitTitle(String(data.title || 'Notification'));
        const message = String(data.message || 'You have a new notification.');
        return `
            ${eyebrow(String(data.eyebrow || 'Notification'), toneFromTitle(String(data.title || '')))}
            ${heading(title, accent)}
            ${startsWithGreeting(message) ? '' : greeting(data.name)}
            ${renderMessage(message)}
            ${data.additionalInfo ? callout('accent', undefined, String(data.additionalInfo)) : ''}
            ${data.actionUrl ? button(String(data.actionUrl), String(data.buttonText || 'View details'), { fallback: false }) : ''}
            ${signoff()}
        `;
    }

    /** Inbox preview line for each template */
    private getPreheader(template: string | undefined, data: EmailTemplateData = {}): string | undefined {
        if (data.preheader) return String(data.preheader);
        switch (template) {
            case 'welcome': return 'Your Solution Pay account is ready.';
            case 'reset-password': return 'Use this link to choose a new password.';
            case 'reset-pin': return 'Use this link to set a new transaction PIN.';
            case 'verification': return 'Confirm your email to finish signing up.';
            case 'notification': return htmlToText(String(data.message || '')).replace(/\s+/g, ' ').slice(0, 140) || undefined;
            default: return undefined;
        }
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
                emailHtml = this.generateBaseTemplate(templateContent, attachments, subject, this.getPreheader(template, data));
                // Plain-text part for text-only clients (and better deliverability)
                emailText = emailText || htmlToText(templateContent);
            } else if (template) {
                throw new Error(`Template "${template}" not found`);
            } else if (html) {
                // Wrap custom HTML in base template
                emailHtml = this.generateBaseTemplate(html, attachments, subject);
                emailText = emailText || htmlToText(html);
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

            // In development, log the email instead of sending it
            if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev') {
                console.log('\n========== EMAIL (DEV MODE - NOT SENT) ==========');
                console.log('To:', mailOptions.to);
                console.log('From:', mailOptions.from);
                console.log('Subject:', mailOptions.subject);
                if (mailOptions.cc) console.log('CC:', mailOptions.cc);
                if (mailOptions.bcc) console.log('BCC:', mailOptions.bcc);
                if (mailOptions.text) console.log('Text:', mailOptions.text);
                if (attachments && attachments.length > 0) {
                    console.log('Attachments:', attachments.map(att => att.filename).join(', '));
                }
                if (emailHtml && typeof emailHtml === 'string') {
                    const preview = emailHtml.length > 500 ? emailHtml.substring(0, 500) + '...' : emailHtml;
                    console.log('HTML Preview (first 500 chars):', preview);
                }
                console.log('===============================================\n');
                
                // Return a mock success response
                return {
                    messageId: `dev-${Date.now()}@solutionpay.local`,
                    accepted: Array.isArray(to) ? to : [to],
                    rejected: [],
                    response: '250 Email logged in development mode (not sent)',
                };
            }

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
     * Sends a transaction PIN reset email
     */
    public async sendPinResetEmail(
        to: string,
        data: EmailTemplateData,
        attachments?: EmailAttachment[]
    ): Promise<any> {
        return this.send({
            to,
            subject: 'Reset Your Transaction PIN',
            template: 'reset-pin',
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