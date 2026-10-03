/**
 * Email building blocks in the frontend's editorial design system
 * (cream canvas, rounded white card, mono eyebrows, serif-italic accents, pill buttons).
 *
 * Everything is inline-styled and table-based so it renders in Gmail, Outlook and
 * Apple Mail. Only the card is padded; inner blocks use light padding so content
 * keeps its width on phones instead of being squeezed by nested containers.
 */

export const EMAIL_COLORS = {
    canvas: "#f5f1ea",
    card: "#ffffff",
    fg: "#15110c",
    body: "#3a352f",
    muted: "#6d6862",
    dim: "#a19c95",
    line: "#e6e0d6",
    lineSoft: "#efeae2",
    surface: "#faf8f4",
    accent: "#9D4DFE",
    accentSoft: "#f4ecff",
    accentLine: "#e2d0ff",
    positive: "#157a44",
    positiveSoft: "#eaf5ee",
    positiveLine: "#c9e5d4",
    negative: "#b33a3a",
    negativeSoft: "#fbeeee",
    negativeLine: "#efcfcf",
    warning: "#9a6a17",
    warningSoft: "#fbf4e6",
    warningLine: "#efdfbf",
} as const;

const C = EMAIL_COLORS;

export const EMAIL_FONTS = {
    sans: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "'Instrument Serif', Georgia, 'Times New Roman', serif",
    mono: "'JetBrains Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
} as const;

const F = EMAIL_FONTS;

export type EmailTone = "accent" | "positive" | "negative" | "warning";

const TONES: Record<EmailTone, { fg: string; bg: string; line: string }> = {
    accent: { fg: C.accent, bg: C.accentSoft, line: C.accentLine },
    positive: { fg: C.positive, bg: C.positiveSoft, line: C.positiveLine },
    negative: { fg: C.negative, bg: C.negativeSoft, line: C.negativeLine },
    warning: { fg: C.warning, bg: C.warningSoft, line: C.warningLine },
};

export const escapeHtml = (value: unknown): string =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

/** Plain text from an HTML fragment (preheaders, text/plain part) */
export const htmlToText = (html: string): string =>
    html
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<\/td>\s*<td[^>]*>/gi, ": ")
        .replace(/<(br|\/p|\/tr|\/h1|\/h2|\/div)\s*\/?>/gi, "\n")
        .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => `${label.replace(/<[^>]+>/g, "").trim()} (${href})`)
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&rarr;/g, "→")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .split("\n").map((l) => l.trim()).join("\n")
        .trim();

/** Leading emoji (kept in subjects, dropped from in-email headings) */
export const stripLeadingEmoji = (text: string): string =>
    text.replace(/^(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}][\u{FE0F}\u{200D}]?\s*)+/u, "").trim();

/* ── Typography ───────────────────────────────────────────────── */

export const eyebrow = (text: string, tone?: EmailTone): string =>
    `<p style="margin:0 0 14px 0;font-family:${F.mono};font-size:11px;line-height:1.4;letter-spacing:0.16em;text-transform:uppercase;color:${tone ? TONES[tone].fg : C.muted};">[ ${escapeHtml(text)} ]</p>`;

/** "Plain words *serif accent.*" — mirrors the app's headings */
export const heading = (text: string, accent?: string): string =>
    `<h1 class="sp-h1" style="margin:0 0 18px 0;font-family:${F.sans};font-size:30px;line-height:1.12;font-weight:400;letter-spacing:-0.02em;color:${C.fg};">${escapeHtml(text)}${
        accent ? ` <span style="font-family:${F.serif};font-style:italic;color:${C.muted};">${escapeHtml(accent)}</span>` : ""
    }</h1>`;

/** Splits a title so its last word becomes the serif accent: "Payment Completed" → "Payment" + "Completed." */
export const splitTitle = (title: string): [string, string | undefined] => {
    const clean = stripLeadingEmoji(title).trim();
    const words = clean.split(/\s+/);
    if (words.length < 2) return [clean, undefined];
    const last = words.pop()!;
    return [words.join(" "), /[.!?]$/.test(last) ? last : `${last}.`];
};

/** Paragraph; `html` is trusted markup from our own templates/callers */
export const paragraph = (html: string, opts: { muted?: boolean; small?: boolean; margin?: string } = {}): string =>
    `<p style="margin:${opts.margin ?? "0 0 16px 0"};font-family:${F.sans};font-size:${opts.small ? 14 : 15}px;line-height:1.65;color:${opts.muted ? C.muted : C.body};">${html}</p>`;

export const greeting = (name?: unknown): string =>
    paragraph(`Hi <strong style="color:${C.fg};font-weight:600;">${escapeHtml(name || "there")}</strong>,`);

/** Marks where attachments go (just above the sign-off) */
export const SIGNOFF_MARKER = "<!--sp-signoff-->";

export const signoff = (): string =>
    `${SIGNOFF_MARKER}<p style="margin:28px 0 0 0;font-family:${F.sans};font-size:14px;line-height:1.6;color:${C.muted};">— The Solution Pay team</p>`;

/* ── Blocks ───────────────────────────────────────────────────── */

/** Bulletproof pill button with a plain-link fallback underneath */
export const button = (url: string, label: string, opts: { fallback?: boolean } = {}): string => {
    const safeUrl = escapeHtml(url);
    return `
<table role="presentation" class="sp-btn" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 6px 0;">
    <tr>
        <td align="center" bgcolor="${C.accent}" style="border-radius:999px;background:${C.accent};">
            <a href="${safeUrl}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${F.sans};font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(label)}&nbsp;&rarr;</a>
        </td>
    </tr>
</table>${opts.fallback === false ? "" : `
<p style="margin:12px 0 0 0;font-family:${F.sans};font-size:12px;line-height:1.55;color:${C.dim};">Button not working? Paste this link into your browser:<br><a href="${safeUrl}" target="_blank" style="color:${C.accent};word-break:break-all;text-decoration:underline;">${safeUrl}</a></p>`}`;
};

/** Soft, rounded note — one level only, never nested */
export const callout = (tone: EmailTone, title: string | undefined, html: string): string => {
    const t = TONES[tone];
    return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0 0;">
    <tr>
        <td style="background:${t.bg};border:1px solid ${t.line};border-radius:14px;padding:14px 16px;">
            ${title ? `<p style="margin:0 0 4px 0;font-family:${F.mono};font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${t.fg};">${escapeHtml(title)}</p>` : ""}
            <p style="margin:0;font-family:${F.sans};font-size:14px;line-height:1.6;color:${C.body};">${html}</p>
        </td>
    </tr>
</table>`;
};

/** One-time code, large and easy to copy */
export const codeBlock = (code: string, label = "Your code"): string => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0 0;">
    <tr>
        <td align="center" style="background:${C.accentSoft};border:1px solid ${C.accentLine};border-radius:14px;padding:16px 12px;">
            <p style="margin:0 0 6px 0;font-family:${F.mono};font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:${C.muted};">${escapeHtml(label)}</p>
            <p style="margin:0;font-family:${F.mono};font-size:28px;font-weight:500;letter-spacing:0.3em;color:${C.accent};">${escapeHtml(code)}</p>
        </td>
    </tr>
</table>`;

/** Label/value rows in a single rounded box (no inner cards) */
export const detailsTable = (rows: Array<[string, string]>): string => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px 0;background:${C.surface};border:1px solid ${C.line};border-radius:14px;">
    ${rows.map(([label, value], i) => `
    <tr>
        <td valign="top" style="padding:11px 0 11px 16px;${i ? `border-top:1px solid ${C.lineSoft};` : ""}font-family:${F.mono};font-size:11px;line-height:1.5;letter-spacing:0.1em;text-transform:uppercase;color:${C.muted};white-space:nowrap;">${escapeHtml(label)}</td>
        <td valign="top" align="right" style="padding:11px 16px 11px 12px;${i ? `border-top:1px solid ${C.lineSoft};` : ""}font-family:${F.sans};font-size:14px;line-height:1.5;color:${C.fg};word-break:break-word;">${value}</td>
    </tr>`).join("")}
</table>`;

/** Line looks like "Account Number: 0123456789" */
const LABEL_LINE = /^([A-Z][A-Za-z0-9 ()/'&-]{0,30}):\s+(.+)$/;

/**
 * Renders a caller's free-text message: blank-line/line-break separated text
 * becomes paragraphs, and runs of "Label: value" lines become a details table.
 * Inline markup from callers (e.g. <strong>) is kept.
 */
export const renderMessage = (message: string): string => {
    const lines = message.split(/\r?\n/).map((l) => l.trim());
    const out: string[] = [];
    let rows: Array<[string, string]> = [];
    let text: string[] = [];

    const flushText = () => {
        if (text.length) out.push(paragraph(text.join("<br>")));
        text = [];
    };
    const flushRows = () => {
        if (rows.length) out.push(detailsTable(rows));
        rows = [];
    };

    for (const line of lines) {
        if (!line) {
            flushText();
            flushRows();
            continue;
        }
        const match = LABEL_LINE.exec(line);
        if (match && !/<[a-z]/i.test(match[1])) {
            flushText();
            rows.push([match[1], match[2]]);
        } else {
            flushRows();
            text.push(line);
        }
    }
    flushText();
    flushRows();
    return out.join("");
};

/** Tone implied by a notification title, e.g. "❌ KYC Verification Failed" → negative */
export const toneFromTitle = (title: string): EmailTone | undefined => {
    if (/^\s*(❌|⚠️)|\b(fail(ed|ure)?|reject(ed)?|declined|unsuccessful|action needed)\b/i.test(title)) return /⚠️|action needed/i.test(title) ? "warning" : "negative";
    if (/^\s*(✅|🎉)|\b(success(ful)?|completed?|approved|verified)\b/i.test(title)) return "positive";
    return undefined;
};

/** Message already opens with its own greeting ("Hello Ada, …") */
export const startsWithGreeting = (message: string): boolean =>
    /^(hi|hello|hey|dear|good (morning|afternoon|evening)|congratulations|welcome)\b/i.test(message.replace(/<[^>]+>/g, "").trim());

export interface EmailAttachmentSummary {
    filename: string;
    contentType?: string;
}

export const attachmentsBlock = (attachments: EmailAttachmentSummary[]): string => {
    if (!attachments.length) return "";
    return `
<p style="margin:28px 0 8px 0;font-family:${F.mono};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:${C.muted};">[ Attached · ${attachments.length} ]</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.surface};border:1px solid ${C.line};border-radius:14px;">
    ${attachments.map((att, i) => `
    <tr>
        <td style="padding:11px 16px;${i ? `border-top:1px solid ${C.lineSoft};` : ""}">
            <p style="margin:0;font-family:${F.sans};font-size:14px;line-height:1.4;color:${C.fg};word-break:break-all;">${escapeHtml(att.filename)}</p>
            <p style="margin:2px 0 0 0;font-family:${F.mono};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:${C.dim};">${escapeHtml(att.contentType || "Attachment")}</p>
        </td>
    </tr>`).join("")}
</table>`;
};

/* ── Page shell ──────────────────────────────────────────────── */

export const emailLayout = ({ title, preheader, content }: { title: string; preheader?: string; content: string }): string => {
    const year = new Date().getFullYear();
    return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${escapeHtml(title)}</title>
    <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Instrument+Serif:ital@1&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        body { margin: 0; padding: 0; background: ${C.canvas}; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
        table { border-collapse: separate; mso-table-lspace: 0; mso-table-rspace: 0; }
        img { border: 0; line-height: 100%; outline: none; text-decoration: none; }
        a { color: ${C.accent}; }
        @media only screen and (max-width: 600px) {
            .sp-outer { padding: 20px 10px !important; }
            .sp-card { padding: 26px 20px !important; border-radius: 16px !important; }
            .sp-h1 { font-size: 26px !important; }
        }
    </style>
</head>
<body style="margin:0;padding:0;background:${C.canvas};">
    ${preheader ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.canvas};">${escapeHtml(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>` : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.canvas}" style="background:${C.canvas};">
        <tr>
            <td class="sp-outer" align="center" style="padding:40px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
                    <tr>
                        <td style="padding:0 4px 18px 4px;">
                            <span style="font-family:${F.sans};font-size:18px;font-weight:600;letter-spacing:-0.02em;color:${C.fg};">Solution<span style="color:${C.accent};">Pay</span></span>
                        </td>
                    </tr>
                    <tr>
                        <td class="sp-card" style="background:${C.card};border:1px solid ${C.line};border-radius:20px;padding:36px;">
                            ${content}
                        </td>
                    </tr>
                    <tr>
                        <td align="center" style="padding:24px 12px 0 12px;">
                            <p style="margin:0 0 6px 0;font-family:${F.mono};font-size:11px;line-height:1.6;letter-spacing:0.04em;color:${C.dim};">© ${year} Solution Pay · Empowering businesses to expand globally</p>
                            <p style="margin:0;font-family:${F.sans};font-size:12px;line-height:1.6;color:${C.dim};">You're receiving this email because of activity on your Solution Pay account.</p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
};
