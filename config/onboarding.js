'use strict';

const ONBOARDING_POLICY_VERSION = 1;
const ONBOARDING_ENFORCEMENT_MODES = Object.freeze([
    'off',
    'observe',
    'new_users'
]);

function getOnboardingConfig() {
    const configuredMode = String(process.env.ONBOARDING_ENFORCEMENT_MODE || '').trim();
    const environment = String(process.env.NODE_ENV || '').trim().toLowerCase();
    if (!configuredMode && ['production', 'staging'].includes(environment)) {
        const error = new Error('ONBOARDING_ENFORCEMENT_MODE is required in staging and production');
        error.code = 'ONBOARDING_CONFIGURATION_INVALID';
        throw error;
    }
    const mode = (configuredMode || 'off').toLowerCase();

    if (!ONBOARDING_ENFORCEMENT_MODES.includes(mode)) {
        const error = new Error(
            `ONBOARDING_ENFORCEMENT_MODE must be one of: ${ONBOARDING_ENFORCEMENT_MODES.join(', ')}`
        );
        error.code = 'ONBOARDING_CONFIGURATION_INVALID';
        throw error;
    }

    return {
        mode,
        policyVersion: ONBOARDING_POLICY_VERSION,
        observeOnly: mode === 'observe',
        enrollNewUsers: mode === 'new_users',
        enforceEnrolledUsers: mode === 'new_users'
    };
}

function assertOnboardingConfiguration() {
    return getOnboardingConfig();
}

module.exports = {
    ONBOARDING_POLICY_VERSION,
    ONBOARDING_ENFORCEMENT_MODES,
    getOnboardingConfig,
    assertOnboardingConfiguration
};
