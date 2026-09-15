/**
 * Notification Branding Helper
 *
 * Resolves SITE_NAME / SUPPORT_EMAIL / SUPPORT_PHONE / SITE_URL / SITE_LOGO
 * from the EXISTING Site Settings architecture (settings.service cache).
 *
 * Safety contract:
 * - Default SITE_NAME is "Zantara"; all other brand fields default to blank
 *   and are omitted when unconfigured. No unverified contact/domain is ever
 *   seeded here.
 * - Never throws: a settings lookup failure yields the safe defaults so no
 *   notification (and no financial flow) can break because of branding.
 * - Changing SITE_NAME requires zero code changes.
 */

const settingsService = require('../services/settings.service');

const DEFAULT_SITE_NAME = 'Zantara';

/**
 * Resolves the configured notification brand.
 * Returns an object shaped like:
 *   { siteName: 'Zantara', supportEmail?: '...', supportPhone?: '...',
 *     siteUrl?: '...', siteLogo?: '...' }
 * Blank support/brand fields are omitted. Never rejects.
 */
async function getNotificationBrand() {
    try {
        const [siteName, supportEmail, supportPhone, siteUrl, siteLogo] = await Promise.all([
            settingsService.getSetting('SITE_NAME', DEFAULT_SITE_NAME),
            settingsService.getSetting('SUPPORT_EMAIL', ''),
            settingsService.getSetting('SUPPORT_PHONE', ''),
            settingsService.getSetting('SITE_URL', ''),
            settingsService.getSetting('SITE_LOGO', ''),
        ]);

        const brand = {
            siteName: String(siteName && siteName.trim() ? siteName : DEFAULT_SITE_NAME).trim(),
        };

        if (supportEmail && String(supportEmail).trim()) brand.supportEmail = String(supportEmail).trim();
        if (supportPhone && String(supportPhone).trim()) brand.supportPhone = String(supportPhone).trim();
        if (siteUrl && String(siteUrl).trim()) brand.siteUrl = String(siteUrl).trim();
        if (siteLogo && String(siteLogo).trim()) brand.siteLogo = String(siteLogo).trim();

        return brand;
    } catch (err) {
        console.error('[NotificationBrand] Settings lookup failed, using safe defaults:', err && err.message);
        return { siteName: DEFAULT_SITE_NAME };
    }
}

module.exports = { getNotificationBrand, DEFAULT_SITE_NAME };