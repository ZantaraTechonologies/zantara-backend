'use strict';

const onboardingService = require('../services/onboarding.service');
const onboardingConfigService = require('../services/onboardingConfig.service');

const staffRoles = new Set(['admin', 'superAdmin']);

const requireOnboardingComplete = async (req, res, next) => {
    const roles = [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
        .filter(Boolean);
    if (roles.some(role => staffRoles.has(role))) return next();

    if (!req.user?.id) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    let config;
    try {
        config = await onboardingConfigService.getConfig();
    } catch (_) {
        return res.status(503).json({
            success: false,
            code: 'ONBOARDING_CONFIGURATION_INVALID',
            message: 'Onboarding policy is unavailable. Please try again later.'
        });
    }

    if (config.mode === 'off') return next();

    try {
        const onboarding = await onboardingService.getState({ userId: req.user.id, config });
        req.onboarding = onboarding;
        if (config.observeOnly) return next();
        if (onboarding.dashboardAllowed) return next();
        if (onboarding.status === 'unavailable') {
            return res.status(503).json({
                success: false,
                code: 'ONBOARDING_DEPENDENCY_UNAVAILABLE',
                message: 'An onboarding requirement is temporarily unavailable. Please try again later.',
                data: { onboarding }
            });
        }

        return res.status(403).json({
            success: false,
            code: 'ONBOARDING_INCOMPLETE',
            message: 'Complete onboarding before accessing this resource.',
            data: { onboarding }
        });
    } catch (_) {
        if (config.observeOnly) {
            req.onboarding = {
                status: 'unavailable',
                mode: config.mode,
                observed: true,
                dashboardAllowed: true,
                code: 'ONBOARDING_STATE_UNAVAILABLE'
            };
            return next();
        }
        return res.status(503).json({
            success: false,
            code: 'ONBOARDING_STATE_UNAVAILABLE',
            message: 'Unable to verify onboarding eligibility. Please try again later.'
        });
    }
};

module.exports = requireOnboardingComplete;
