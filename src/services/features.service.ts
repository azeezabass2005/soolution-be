import { YELLOWCARD_FLOW_CURRENCIES } from "../common/payment-link.constants";
import { and, asc, eq } from "drizzle-orm";
import { users } from "../db/schema";
import { exec, isUuid } from "../repositories/utils";
import platformSettingsService from "./platform-settings.service";
import { FEATURES, type FeatureMode } from "../common/features";
import { ROLE_MAP } from "../common/constant";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import logger from "../utils/logger.utils";

type Who = { id?: string; role?: number; betaTester?: boolean | null };

/**
 * Which features a user gets: "on" for everyone, "beta" for beta users only,
 * "off" for no one. Admins always get everything (to support users).
 */
class FeaturesService {
    async modes(): Promise<Record<string, FeatureMode>> {
        const { features } = await platformSettingsService.getOperations();
        return Object.fromEntries(FEATURES.map((f) => [f.key, features[f.key] ?? f.defaultMode ?? "on"]));
    }

    allows(mode: FeatureMode, user: Who) {
        if (user.role === ROLE_MAP.ADMIN) return true;
        return mode === "on" || (mode === "beta" && !!user.betaTester);
    }

    async forUser(user: Who) {
        const modes = await this.modes();
        return {
            beta: !!user.betaTester,
            features: Object.fromEntries(Object.entries(modes).map(([key, mode]) => [key, this.allows(mode, user)])),
            /** Features this user has only because they're a beta user */
            betaFeatures: Object.entries(modes).filter(([, m]) => m === "beta").map(([k]) => k),
        };
    }

    /** Throws when `key` isn't available to the user */
    async assert(key: string, user: Who) {
        const mode = (await this.modes())[key] ?? "on";
        if (this.allows(mode, user)) return;
        const label = FEATURES.find((f) => f.key === key)?.label ?? "This feature";
        throw errorResponseMessage.createError(403, mode === "beta" ? `${label} is in beta and not open to your account yet.` : `${label} isn't available right now.`, ErrorSeverity.LOW, { code: "FEATURE_UNAVAILABLE", feature: key });
    }

    /** Whether the user gets `key` (no throw) */
    async has(key: string, user: Who) {
        return this.allows((await this.modes())[key] ?? "on", user);
    }

    /** The feature a currency needs to be received (other African currencies), if any */
    receiveFeatureFor(currency: string) {
        return (YELLOWCARD_FLOW_CURRENCIES as readonly string[]).includes(String(currency).toUpperCase()) ? "african_receives" : null;
    }

    /** The feature a currency needs to be sent to, if any */
    sendFeatureFor(currency: string) {
        return (YELLOWCARD_FLOW_CURRENCIES as readonly string[]).includes(String(currency).toUpperCase()) ? "african_sends" : null;
    }

    /** Throws when receiving `currency` (directly or on a payment link) isn't open to the user */
    async assertReceive(user: Who, currency: string) {
        const key = this.receiveFeatureFor(currency);
        if (key) await this.assert(key, user);
    }

    /** For the admin page: the registry with modes, and the beta users */
    async overview() {
        const modes = await this.modes();
        const testers = await exec()
            .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName })
            .from(users).where(eq(users.betaTester, true)).orderBy(asc(users.email));
        return {
            features: FEATURES.map((f) => ({ key: f.key, label: f.label, description: f.description, mode: modes[f.key] })),
            betaUsers: testers.map((u) => ({ id: u.id, email: u.email, name: [u.firstName, u.lastName].filter(Boolean).join(" ") })),
        };
    }

    async setBeta(userId: string, beta: boolean, by: string) {
        if (!isUuid(userId)) throw errorResponseMessage.resourceNotFound("User");
        const [row] = await exec().update(users).set({ betaTester: beta }).where(and(eq(users.id, userId))).returning({ id: users.id, email: users.email });
        if (!row) throw errorResponseMessage.resourceNotFound("User");
        logger.info("Beta user changed", { userId, beta, by });
        return { id: row.id, beta };
    }
}

export default new FeaturesService();
