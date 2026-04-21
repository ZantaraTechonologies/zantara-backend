const settingsService = require('../services/settings.service');

exports.getBusinessSettings = async (req, res) => {
    try {
        const siteName = await settingsService.getSetting('SITE_NAME', 'Zantara');
        const referralRate = await settingsService.getSetting('REFERRAL_COMMISSION_PERCENTAGE', 0.01);
        
        res.json({
            success: true,
            data: {
                SITE_NAME: siteName,
                REFERRAL_RATE: referralRate
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateBusinessSettings = async (req, res) => {
    try {
        const { SITE_NAME, REFERRAL_RATE } = req.body;
        
        const updates = {};
        if (SITE_NAME !== undefined) updates.SITE_NAME = SITE_NAME;
        if (REFERRAL_RATE !== undefined) updates.REFERRAL_COMMISSION_PERCENTAGE = Number(REFERRAL_RATE);

        await settingsService.bulkUpdate(updates);

        res.json({ success: true, message: 'Settings updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
