const settingsService = require('../services/settings.service');

exports.getBusinessSettings = async (req, res) => {
    try {
        const siteName = await settingsService.getSetting('SITE_NAME', 'Zantara');
        const referralRate = await settingsService.getSetting('REFERRAL_COMMISSION_PERCENTAGE', 0.01);
        const appLockTimeout = await settingsService.getSetting('APP_LOCK_TIMEOUT_MINUTES', 3);
        const transferFeeConfig = await settingsService.getSetting('TRANSFER_FEE_CONFIG', {
            type: 'tiered',
            increment: 500,
            feePerIncrement: 20
        });
        
        res.json({
            success: true,
            data: {
                SITE_NAME: siteName,
                REFERRAL_RATE: referralRate,
                APP_LOCK_TIMEOUT_MINUTES: Number(appLockTimeout),
                TRANSFER_FEE_CONFIG: transferFeeConfig
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateBusinessSettings = async (req, res) => {
    try {
        const { SITE_NAME, REFERRAL_RATE, APP_LOCK_TIMEOUT_MINUTES, TRANSFER_FEE_CONFIG } = req.body;
        
        const updates = {};
        if (SITE_NAME !== undefined) updates.SITE_NAME = SITE_NAME;
        if (REFERRAL_RATE !== undefined) updates.REFERRAL_COMMISSION_PERCENTAGE = Number(REFERRAL_RATE);
        if (APP_LOCK_TIMEOUT_MINUTES !== undefined) updates.APP_LOCK_TIMEOUT_MINUTES = Number(APP_LOCK_TIMEOUT_MINUTES);
        if (TRANSFER_FEE_CONFIG !== undefined) updates.TRANSFER_FEE_CONFIG = TRANSFER_FEE_CONFIG;

        await settingsService.bulkUpdate(updates);

        res.json({ success: true, message: 'Settings updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
