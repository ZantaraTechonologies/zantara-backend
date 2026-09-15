const settingsService = require('../services/settings.service');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTTPS_URL_RE = /^https:\/\/.+$/i;

/**
 * Validate branding/support fields supplied in a settings update.
 * Throws descriptive Error objects with a `field` property on failure.
 */
const validateBrandingFields = (updates) => {
    const { SUPPORT_EMAIL, SUPPORT_PHONE, SITE_URL, SITE_LOGO, SITE_NAME } = updates;

    if (SUPPORT_EMAIL !== undefined && SUPPORT_EMAIL !== '') {
        if (typeof SUPPORT_EMAIL !== 'string' || !EMAIL_RE.test(SUPPORT_EMAIL)) {
            const err = new Error('SUPPORT_EMAIL must be a valid email address');
            err.field = 'SUPPORT_EMAIL';
            throw err;
        }
    }

    if (SUPPORT_PHONE !== undefined && SUPPORT_PHONE !== '') {
        if (typeof SUPPORT_PHONE !== 'string' || !/^[+\d][\d\s\-().]+$/.test(SUPPORT_PHONE)) {
            const err = new Error('SUPPORT_PHONE must be a valid phone number (international formatting allowed)');
            err.field = 'SUPPORT_PHONE';
            throw err;
        }
    }

    if (SITE_URL !== undefined && SITE_URL !== '') {
        if (typeof SITE_URL !== 'string' || !HTTPS_URL_RE.test(SITE_URL.trim())) {
            const err = new Error('SITE_URL must be a valid HTTPS URL');
            err.field = 'SITE_URL';
            throw err;
        }
    }

    if (SITE_LOGO !== undefined && SITE_LOGO !== '') {
        if (typeof SITE_LOGO !== 'string' || !HTTPS_URL_RE.test(SITE_LOGO.trim())) {
            const err = new Error('SITE_LOGO must be a valid HTTPS image URL');
            err.field = 'SITE_LOGO';
            throw err;
        }
    }

    if (SITE_NAME !== undefined && SITE_NAME !== '') {
        if (typeof SITE_NAME !== 'string' || SITE_NAME.trim().length > 60) {
            const err = new Error('SITE_NAME must be a non-empty string of at most 60 characters');
            err.field = 'SITE_NAME';
            throw err;
        }
    }
};

exports.getBusinessSettings = async (req, res) => {
    try {
        const siteName = await settingsService.getSetting('SITE_NAME', 'Zantara');
        const supportEmail = await settingsService.getSetting('SUPPORT_EMAIL', '');
        const supportPhone = await settingsService.getSetting('SUPPORT_PHONE', '');
        const siteUrl = await settingsService.getSetting('SITE_URL', '');
        const siteLogo = await settingsService.getSetting('SITE_LOGO', '');
        const referralRate = await settingsService.getSetting('REFERRAL_COMMISSION_PERCENTAGE', 0.01);
        const appLockTimeout = await settingsService.getSetting('APP_LOCK_TIMEOUT_MINUTES', 3);
        const transferFeeConfig = await settingsService.getSetting('TRANSFER_FEE_CONFIG', {
            type: 'tiered',
            increment: 500,
            feePerIncrement: 20
        });
        const withdrawalFeeConfig = await settingsService.getSetting('WITHDRAWAL_FEE_CONFIG', {
            type: 'percentage',
            value: 10
        });
        
        res.json({
            success: true,
            data: {
                SITE_NAME: siteName,
                SUPPORT_EMAIL: supportEmail,
                SUPPORT_PHONE: supportPhone,
                SITE_URL: siteUrl,
                SITE_LOGO: siteLogo,
                REFERRAL_RATE: referralRate,
                APP_LOCK_TIMEOUT_MINUTES: Number(appLockTimeout),
                TRANSFER_FEE_CONFIG: transferFeeConfig,
                WITHDRAWAL_FEE_CONFIG: withdrawalFeeConfig
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateBusinessSettings = async (req, res) => {
    try {
        const { SITE_NAME, SUPPORT_EMAIL, SUPPORT_PHONE, SITE_URL, SITE_LOGO, REFERRAL_RATE, APP_LOCK_TIMEOUT_MINUTES, TRANSFER_FEE_CONFIG, WITHDRAWAL_FEE_CONFIG } = req.body;

        const rawUpdates = {};
        if (SITE_NAME !== undefined) rawUpdates.SITE_NAME = String(SITE_NAME).trim();
        if (SUPPORT_EMAIL !== undefined) rawUpdates.SUPPORT_EMAIL = String(SUPPORT_EMAIL).trim();
        if (SUPPORT_PHONE !== undefined) rawUpdates.SUPPORT_PHONE = String(SUPPORT_PHONE).trim();
        if (SITE_URL !== undefined) rawUpdates.SITE_URL = String(SITE_URL).trim();
        if (SITE_LOGO !== undefined) rawUpdates.SITE_LOGO = String(SITE_LOGO).trim();

        validateBrandingFields(rawUpdates);

        const updates = {
            ...rawUpdates,
        };
        if (REFERRAL_RATE !== undefined) updates.REFERRAL_COMMISSION_PERCENTAGE = Number(REFERRAL_RATE);
        if (APP_LOCK_TIMEOUT_MINUTES !== undefined) updates.APP_LOCK_TIMEOUT_MINUTES = Number(APP_LOCK_TIMEOUT_MINUTES);
        if (TRANSFER_FEE_CONFIG !== undefined) updates.TRANSFER_FEE_CONFIG = TRANSFER_FEE_CONFIG;
        if (WITHDRAWAL_FEE_CONFIG !== undefined) updates.WITHDRAWAL_FEE_CONFIG = WITHDRAWAL_FEE_CONFIG;

        await settingsService.bulkUpdate(updates);

        res.json({ success: true, message: 'Settings updated successfully' });
    } catch (error) {
        if (error.field) {
            return res.status(400).json({ success: false, message: error.message, field: error.field });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getNotificationSettings = async (req, res) => {
    try {
        const defaultSettings = {
            sms: {
                phone_verification: true,
                password_reset: true,
                change_pin: true,
                change_password: true,
                email_verification: true,
                withdrawal_approved: true,
                critical_system: true
            },
            email: {
                phone_verification: true,
                password_reset: true,
                email_verification: true,
                withdrawal_approved: true,
                critical_system: true
            }
        };

        const notificationSettings = await settingsService.getSetting('NOTIFICATION_SETTINGS', defaultSettings);
        
        res.json({
            success: true,
            data: notificationSettings
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateNotificationSettings = async (req, res) => {
    try {
        const settings = req.body;
        
        await settingsService.bulkUpdate({
            NOTIFICATION_SETTINGS: settings
        });

        res.json({ success: true, message: 'Notification settings updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
