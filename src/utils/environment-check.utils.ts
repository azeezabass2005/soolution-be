/**
 * Catches staging and production pointing at each other. The backend builds
 * the links in emails and WhatsApp alerts from FRONTEND_URL, so a production
 * API with a staging FRONTEND_URL sends admins to the staging dashboard.
 * The API's own host comes from COOKIE_DOMAIN (e.g. api.solutionpay.co).
 */
export function environmentMismatch(apiHost: string, frontendUrl: string): string | null {
    const api = (apiHost || "").toLowerCase();
    let frontend = "";
    try {
        frontend = new URL(frontendUrl).hostname.toLowerCase();
    } catch {
        return frontendUrl ? `FRONTEND_URL isn't a valid address: "${frontendUrl}"` : null;
    }
    if (!api || !api.includes("solutionpay")) return null; // local or test
    const apiIsStaging = api.includes("staging");
    const frontendIsStaging = frontend.includes("staging");
    if (apiIsStaging === frontendIsStaging) return null;
    return apiIsStaging
        ? `Staging API (${api}) has a production FRONTEND_URL (${frontend}): links in emails and alerts go to production`
        : `Production API (${api}) has a staging FRONTEND_URL (${frontend}): links in emails and alerts go to staging`;
}
