/**
 * What makes a password acceptable, for sign-up, password resets and
 * password changes. The frontend's strength meter applies the same rules
 * (soolution-fe src/shared/utils/passwordStrength.ts), so a password it
 * calls acceptable is never refused here.
 */

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
/** From this length, two kinds of character are enough (a passphrase) */
export const PASSPHRASE_MIN = 15;

/** Passwords and fragments that are among the first an attacker tries */
const COMMON_FRAGMENTS = [
    "password", "passw0rd", "p@ssword", "p@ssw0rd", "qwerty", "azerty", "123456", "654321", "abc123", "abcdef",
    "111111", "000000", "iloveyou", "letmein", "welcome", "admin", "monkey", "dragon", "football", "baseball",
    "sunshine", "princess", "trustno1", "solutionpay", "solution", "qwertyuiop", "asdfgh", "zxcvbn", "1q2w3e", "changeme",
];

export interface PasswordContext {
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
}

/** Character kinds used: lowercase, uppercase, digits, symbols */
export const characterKinds = (password: string) =>
    [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;

/** Why a password isn't acceptable, or null when it is */
export function passwordProblem(password: unknown, context: PasswordContext = {}): string | null {
    if (typeof password !== "string" || password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
    if (password.length > PASSWORD_MAX) return "That password is too long.";
    // A long passphrase is strong with fewer kinds of character
    const kindsNeeded = password.length >= PASSPHRASE_MIN ? 2 : 3;
    if (characterKinds(password) < kindsNeeded) {
        return kindsNeeded === 3
            ? "Mix at least three of: lowercase letters, capital letters, numbers and symbols."
            : "Add a number, symbol or capital letter.";
    }
    const lower = password.toLowerCase();
    if (/^(.)\1+$/.test(password) || COMMON_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
        return "That password is too easy to guess. Choose something less common.";
    }
    const personal = [
        String(context.email || "").split("@")[0],
        String(context.firstName || ""),
        String(context.lastName || ""),
    ].map((part) => part.trim().toLowerCase()).filter((part) => part.length >= 4);
    if (personal.some((part) => lower.includes(part))) return "Don't use your name or email in your password.";
    return null;
}
