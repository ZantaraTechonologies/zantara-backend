'use strict';

const onboardingService = require('../services/onboarding.service');

const getStatus = async (req, res) => {
    try {
        const onboarding = await onboardingService.getState({ userId: req.user.id });
        return res.json({ success: true, onboarding });
    } catch (error) {
        return res.status(error.statusCode || 503).json({
            success: false,
            code: error.code || 'ONBOARDING_STATE_UNAVAILABLE',
            message: error.statusCode ? error.message : 'Unable to determine onboarding status'
        });
    }
};

module.exports = { getStatus };
