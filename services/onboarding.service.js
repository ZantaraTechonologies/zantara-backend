'use strict';

const User = require('../models/User');
const Kyc = require('../models/Kyc');
const legalService = require('./legalDocument.service');
const { getOnboardingConfig } = require('../config/onboarding');
const { validateCustomerProfile } = require('../utils/customerProfile');

const createOnboardingError = (message, code, statusCode) => {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
};

const manualIdentityStatus = kyc => {
    if (!kyc) return { status: 'not_submitted', tier: null };
    return {
        status: kyc.status,
        tier: Number(kyc.tier || 1),
        submittedAt: kyc.createdAt || null,
        verifiedAt: kyc.verifiedAt || null,
        ...(kyc.status === 'rejected' && kyc.rejectionReason
            ? { rejectionReason: kyc.rejectionReason }
            : {})
    };
};

class OnboardingService {
    async getState({ userId } = {}) {
        if (!userId) {
            throw createOnboardingError('Authenticated user is required', 'ONBOARDING_USER_REQUIRED', 401);
        }

        const config = getOnboardingConfig();
        const userQuery = User.findById(userId);
        const user = typeof userQuery?.select === 'function'
            ? await userQuery.select(
                'name email phone status isPhoneVerified isEmailVerified isPinSet onboardingPolicyVersion onboardingEnrolledAt +transactionPin'
            )
            : await userQuery;
        if (!user) {
            throw createOnboardingError('User not found', 'ONBOARDING_USER_NOT_FOUND', 404);
        }
        if (!user.status) {
            throw createOnboardingError('Account is disabled', 'ONBOARDING_ACCOUNT_DISABLED', 403);
        }

        const storedPolicyVersion = Number(user.onboardingPolicyVersion);
        const enrolled = Number.isSafeInteger(storedPolicyVersion) && storedPolicyVersion > 0;
        const enforced = config.enforceEnrolledUsers && enrolled;
        if (config.enforceEnrolledUsers && !enrolled) {
            return {
                policyVersion: null,
                mode: config.mode,
                enrolled: false,
                enforced: false,
                observed: false,
                status: 'not_applicable',
                currentStep: null,
                complete: false,
                dashboardAllowed: true
            };
        }

        const kycQuery = Kyc.findOne({ userId: user._id });
        const latestKycPromise = typeof kycQuery?.sort === 'function'
            ? kycQuery.sort({ createdAt: -1 })
            : kycQuery;
        const [legalRequirements, latestKyc] = await Promise.all([
            legalService.getRequirements({ userId: String(user._id) }),
            latestKycPromise
        ]);

        const profile = validateCustomerProfile(user);
        const missingContacts = [
            ...(user.isPhoneVerified === true ? [] : ['phone']),
            ...(user.isEmailVerified === true ? [] : ['email'])
        ];
        const missingLegal = Array.isArray(legalRequirements.missingAcceptances)
            ? legalRequirements.missingAcceptances
            : [];
        const missingMandatoryDocuments = Array.isArray(legalRequirements.missingMandatoryDocuments)
            ? legalRequirements.missingMandatoryDocuments
            : [];
        const legalUnavailable = missingMandatoryDocuments.length > 0;
        const pinSet = typeof user.transactionPin === 'string' && user.transactionPin.length > 0;

        let currentStep = 'complete';
        if (!profile.complete) currentStep = 'basic_kyc';
        else if (missingContacts.length > 0) currentStep = 'contact_verification';
        else if (missingMandatoryDocuments.length > 0 || missingLegal.length > 0) currentStep = 'legal_acceptance';
        else if (!pinSet) currentStep = 'transaction_pin';

        const complete = currentStep === 'complete';
        return {
            policyVersion: enrolled ? storedPolicyVersion : null,
            mode: config.mode,
            enrolled,
            enforced,
            observed: config.observeOnly,
            status: legalUnavailable ? 'unavailable' : complete ? 'complete' : 'incomplete',
            currentStep,
            complete,
            dashboardAllowed: !enforced || complete,
            basicKyc: {
                status: profile.complete ? 'complete' : 'incomplete',
                missingFields: profile.missingFields,
                invalidFields: profile.invalidFields
            },
            contactVerification: {
                status: missingContacts.length === 0 ? 'complete' : 'required',
                phoneVerified: user.isPhoneVerified === true,
                emailVerified: user.isEmailVerified === true,
                missing: missingContacts
            },
            legalAcceptance: {
                status: missingMandatoryDocuments.length > 0
                    ? 'unavailable'
                    : missingLegal.length > 0 ? 'required' : 'complete',
                missingDocumentTypes: missingLegal,
                missingMandatoryDocuments
            },
            transactionPin: {
                status: pinSet ? 'complete' : 'required',
                isSet: pinSet
            },
            identityVerification: manualIdentityStatus(latestKyc)
        };
    }

    async getStateForResponse({ userId } = {}) {
        try {
            return await this.getState({ userId });
        } catch (_) {
            const config = getOnboardingConfig();
            return {
                policyVersion: null,
                mode: config.mode,
                enrolled: null,
                enforced: config.enforceEnrolledUsers,
                observed: config.observeOnly,
                status: 'unavailable',
                currentStep: null,
                complete: false,
                dashboardAllowed: !config.enforceEnrolledUsers,
                code: 'ONBOARDING_STATE_UNAVAILABLE'
            };
        }
    }

    registrationPolicyFields(now = new Date()) {
        const config = getOnboardingConfig();
        if (!config.enrollNewUsers) return {};
        return {
            onboardingPolicyVersion: config.policyVersion,
            onboardingEnrolledAt: now
        };
    }

    requiresConfirmationForNewUser() {
        return getOnboardingConfig().enrollNewUsers;
    }

    requiresProfileValidation(user) {
        const storedPolicyVersion = Number(user?.onboardingPolicyVersion);
        return getOnboardingConfig().enforceEnrolledUsers
            && Number.isSafeInteger(storedPolicyVersion)
            && storedPolicyVersion > 0;
    }
}

module.exports = new OnboardingService();
module.exports.createOnboardingError = createOnboardingError;
