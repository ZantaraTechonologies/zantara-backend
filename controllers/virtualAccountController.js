'use strict';

const virtualAccountService = require('../services/virtualAccount.service');
const { serializeVirtualAccounts } = require('../utils/virtualAccountSerializer');

const provisionVirtualAccount = async (req, res) => {
    try {
        const result = await virtualAccountService.provision({
            userId: req.user.id,
            providerCode: req.params.provider,
            preferredBank: req.body?.preferredBank,
            consent: req.body?.consent === true,
            consentVersion: req.body?.consentVersion,
            consentChannel: 'provider_specific_api',
            retryRejected: req.body?.retryRejected === true
        });
        const failed = result.status === 'failed';
        return res.status(failed ? 422 : result.status === 'pending' ? 202 : 200).json({
            success: !failed,
            status: result.status,
            ...(result.state ? { state: result.state } : {}),
            ...(failed ? {
                code: result.code || 'VIRTUAL_ACCOUNT_PROVISIONING_FAILED',
                message: result.message || 'Virtual-account provisioning failed'
            } : {}),
            existing: result.existing,
            accounts: serializeVirtualAccounts(result.accounts)
        });
    } catch (error) {
        const status = error.httpStatus || (error.response ? 502 : 500);
        return res.status(status).json({
            success: false,
            code: error.code || 'VIRTUAL_ACCOUNT_PROVISIONING_FAILED',
            message: error.message,
            ...(['PAYSTACK_DVA_CONSENT_REQUIRED', 'MONNIFY_VIRTUAL_ACCOUNT_CONSENT_REQUIRED', 'VIRTUAL_ACCOUNT_CONSENT_VERSION_INVALID'].includes(error.code)
                ? { data: { consent: virtualAccountService._consentRequirement(String(req.params.provider || '').toLowerCase()) } }
                : {})
        });
    }
};

const getVirtualAccounts = async (req, res) => {
    try {
        const result = await virtualAccountService.getAccountStatus({ userId: req.user.id });
        return res.json({
            success: true,
            accounts: serializeVirtualAccounts(result.accounts),
            providers: result.providers,
            legacyReviewRequired: result.legacyReviewRequired
        });
    } catch (error) {
        return res.status(error.httpStatus || 500).json({
            success: false,
            code: error.code || 'VIRTUAL_ACCOUNT_STATUS_UNAVAILABLE',
            message: error.httpStatus ? error.message : 'Virtual-account status is temporarily unavailable'
        });
    }
};

const requestBankAccounts = async (req, res) => {
    try {
        const requestedProviders = req.body?.providers;
        if (requestedProviders !== undefined && (
            !Array.isArray(requestedProviders)
            || requestedProviders.length !== 1
            || !['paystack', 'monnify'].includes(requestedProviders[0])
        )) {
            return res.status(400).json({
                success: false,
                code: 'VIRTUAL_ACCOUNT_PROVIDER_INVALID',
                message: 'Select exactly one supported virtual-account provider'
            });
        }
        const consents = req.body?.consents;
        if (consents !== undefined && (!consents || typeof consents !== 'object' || Array.isArray(consents))) {
            return res.status(400).json({
                success: false,
                code: 'VIRTUAL_ACCOUNT_CONSENT_INVALID',
                message: 'Provider-specific consent details must be supplied as an object'
            });
        }
        const retryRejectedProviders = Array.isArray(req.body?.retryRejectedProviders)
            ? req.body.retryRejectedProviders.filter(provider => ['paystack', 'monnify'].includes(provider))
            : [];
        const result = await virtualAccountService.requestBankAccounts({
            userId: req.user.id,
            providers: requestedProviders,
            consents: consents || {},
            retryRejectedProviders
        });
        return res.status(result.status === 'pending' ? 202 : 200).json({
            success: !['failed'].includes(result.status),
            status: result.status,
            accounts: serializeVirtualAccounts(result.accounts),
            providers: result.providers
        });
    } catch (error) {
        return res.status(error.httpStatus || 500).json({
            success: false,
            code: error.code || 'VIRTUAL_ACCOUNT_REQUEST_FAILED',
            message: error.httpStatus ? error.message : 'Bank-account request is temporarily unavailable'
        });
    }
};

module.exports = { provisionVirtualAccount, getVirtualAccounts, requestBankAccounts };
