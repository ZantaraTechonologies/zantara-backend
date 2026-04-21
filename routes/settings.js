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
        // Add any other public settings here if needed later (logo, etc)
        
        res.json({
            success: true,
            data: {
                SITE_NAME: siteName
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
