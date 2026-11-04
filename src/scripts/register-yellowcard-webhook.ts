import yellowCardService from "../services/yellowcard.service";
import config from "../config/env.config";

/**
 * Registers our webhook URL with YellowCard for every event, using the API
 * keys and base URL of whichever environment's .env this runs with.
 * Does nothing if the URL is already registered.
 *
 *   npx tsc && node dist/scripts/register-yellowcard-webhook.js https://api-staging.solutionpay.co
 */
const registerYellowCardWebhook = async () => {
    const host = (process.argv[2] || "").replace(/\/+$/, "");
    if (!/^https:\/\//.test(host)) {
        console.error("Usage: node dist/scripts/register-yellowcard-webhook.js https://<api host>");
        process.exit(1);
    }
    const url = `${host}/api/v1/public/webhook/yellowcard-callback`;

    try {
        const { webhooks = [] } = (await yellowCardService.listWebhooks()) || {};
        const existing = webhooks.find((w: any) => w.url === url);
        if (existing) {
            console.log(`Already registered on ${config.YELLOWCARD_BASE_URL}:`, existing);
            process.exit(0);
        }
        const created = await yellowCardService.registerWebhook(url);
        console.log(`Registered on ${config.YELLOWCARD_BASE_URL}:`, created);
        process.exit(0);
    } catch (error: any) {
        console.error("Registering the YellowCard webhook failed", error?.response?.data || error?.message || error);
        process.exit(1);
    }
};

registerYellowCardWebhook();
