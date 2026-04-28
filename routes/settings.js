const express = require('express');
const router = express.Router();
const settingsService = require('../services/settings.service');

/**
 * GET /api/settings/public
 * Returns non-sensitive business settings for the frontend branding
 */
router.get('/public', async (req, res) => {
    try {
        const siteName = await settingsService.getSetting('SITE_NAME', 'Zantara');
        const appLockTimeout = await settingsService.getSetting('APP_LOCK_TIMEOUT_MINUTES', 3);
        // Add any other public settings here if needed later (logo, etc)
        
        res.json({
            success: true,
            data: {
                SITE_NAME: siteName,
                APP_LOCK_TIMEOUT_MINUTES: Number(appLockTimeout)
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
