'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const PaymentGateway = require('../models/PaymentGateway');
const paymentGatewayService = require('./paymentGateway.service');
const { getAdapterSpec } = require('../adapters/payment/paymentAdapterRegistry');

const PROVISIONING_LEASE_MS = 15 * 60 * 1000;

const asPlainAccount = account => account?.toObject ? account.toObject() : { ...(account || {}) };

const cleanObject = value => Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
);

class MongoVirtualAccountRepository {
    constructor(UserModel = User, {
        PaymentGatewayModel = PaymentGateway,
        startSession = () => mongoose.startSession()
    } = {}) {
        this.User = UserModel;
        this.PaymentGateway = PaymentGatewayModel;
        this.startSession = startSession;
    }

    async getUser(userId) {
        const query = this.User.findById(userId);
        return typeof query?.select === 'function'
            ? query.select('+virtualAccountGatewaySnapshots +virtualAccounts.provisioningGatewayContext')
            : query;
    }

    async listScope(userId, provider, gatewayId) {
        const user = await this.getUser(userId);
        if (!user) return [];
        return (user.virtualAccounts || [])
            .map(asPlainAccount)
            .filter(account => (
                account.provider === provider && String(account.gatewayId || '') === String(gatewayId)
            ) || (
                provider === 'monnify' && !account.provider && !!account.accountNumber
            ));
    }

    async savePaystackPreference({ userId, preferredBank, consentGrantedAt, provisioningKey }) {
        const result = await this.User.updateOne(
            {
                _id: userId,
                ...(provisioningKey ? { 'virtualAccounts.provisioningKey': { $ne: provisioningKey } } : {})
            },
            {
                $set: {
                    'virtualAccountPreferences.paystack.preferredBank': preferredBank,
                    'virtualAccountPreferences.paystack.consentGrantedAt': consentGrantedAt
                }
            }
        );
        return Number(result?.matchedCount ?? result?.n ?? result?.modifiedCount ?? result?.nModified ?? 0) > 0;
    }

    async findPaystackProvisioningForAssignment({ gatewayId, gatewayContexts, providerCustomerId, providerCustomerCode }) {
        const provisioningKey = `paystack:${gatewayId}`;
        const approvedContexts = [...new Set((gatewayContexts || []).filter(Boolean))];
        const scope = {
            provider: 'paystack',
            gatewayId: String(gatewayId),
            provisioningKey,
            provisioningStatus: { $in: ['pending', 'failed', 'active'] },
            providerCustomerId: String(providerCustomerId),
            providerCustomerCode,
            $or: [
                ...(approvedContexts.length > 0
                    ? [{ provisioningGatewayContext: { $in: approvedContexts } }]
                    : []),
                { provisioningGatewayContext: { $exists: false } },
                { provisioningGatewayContext: '' }
            ]
        };
        let query = this.User.find({ virtualAccounts: { $elemMatch: scope } });
        if (typeof query?.select === 'function') {
            query = query.select('+virtualAccounts.provisioningToken +virtualAccounts.provisioningGatewayContext');
        }
        if (typeof query?.limit === 'function') query = query.limit(2);
        const users = await query;
        const matches = [];

        for (const user of users || []) {
            for (const value of user.virtualAccounts || []) {
                const account = asPlainAccount(value);
                if (
                    account.provider === 'paystack'
                    && String(account.gatewayId || '') === String(gatewayId)
                    && account.provisioningKey === provisioningKey
                    && ['pending', 'failed', 'active'].includes(account.provisioningStatus)
                    && String(account.providerCustomerId || '') === String(providerCustomerId)
                    && account.providerCustomerCode === providerCustomerCode
                    && (!account.provisioningGatewayContext || approvedContexts.includes(account.provisioningGatewayContext))
                ) {
                    matches.push({ userId: user._id, account, token: account.provisioningToken || null });
                }
            }
        }

        return {
            match: matches.length === 1 ? matches[0] : null,
            matchCount: matches.length
        };
    }

    async claimPaystackAssignment({ userId, account, gatewayContext }) {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + PROVISIONING_LEASE_MS);
        const token = crypto.randomBytes(24).toString('hex');
        const claim = {
            provider: 'paystack',
            gatewayId: String(account.gatewayId),
            provisioningKey: account.provisioningKey,
            provisioningStatus: account.provisioningStatus,
            providerCustomerId: String(account.providerCustomerId),
            providerCustomerCode: account.providerCustomerCode
        };
        if (account.provisioningToken) claim.provisioningToken = account.provisioningToken;
        else claim.provisioningToken = { $exists: false };
        if (account.provisioningGatewayContext) {
            claim.provisioningGatewayContext = account.provisioningGatewayContext;
        } else {
            claim.$or = [
                { provisioningGatewayContext: { $exists: false } },
                { provisioningGatewayContext: '' }
            ];
        }

        const claimed = await this.User.findOneAndUpdate(
            { _id: userId, virtualAccounts: { $elemMatch: claim } },
            {
                $set: {
                    'virtualAccounts.$.provisioningStatus': 'pending',
                    'virtualAccounts.$.provisioningToken': token,
                    'virtualAccounts.$.provisioningGatewayContext': gatewayContext,
                    'virtualAccounts.$.provisioningDispatchState': 'reconciling',
                    'virtualAccounts.$.provisioningStartedAt': now,
                    'virtualAccounts.$.provisioningExpiresAt': expiresAt,
                    'virtualAccounts.$.provisioningFailure': null
                }
            },
            { new: true }
        );
        return claimed ? { claimed: true, token } : { claimed: false, token: null };
    }

    async findActivePaystackDepositOwner({ gatewayId, accountNumber, providerCustomerId, providerCustomerCode }) {
        const scope = {
            provider: 'paystack',
            gatewayId: String(gatewayId),
            accountNumber,
            providerCustomerId: String(providerCustomerId),
            providerCustomerCode,
            provisioningStatus: 'active',
            active: true,
            assigned: true
        };
        let query = this.User.find({ virtualAccounts: { $elemMatch: scope } });
        if (typeof query?.select === 'function') query = query.select('+virtualAccountGatewaySnapshots');
        if (typeof query?.limit === 'function') query = query.limit(2);
        const users = await query;
        const matches = [];

        for (const user of users || []) {
            for (const value of user.virtualAccounts || []) {
                const account = asPlainAccount(value);
                const providerAccountId = String(account.providerAccountId || '');
                if (
                    account.provider === 'paystack'
                    && String(account.gatewayId || '') === String(gatewayId)
                    && account.accountNumber === accountNumber
                    && String(account.providerCustomerId || '') === String(providerCustomerId)
                    && account.providerCustomerCode === providerCustomerCode
                    && account.provisioningStatus === 'active'
                    && account.active === true
                    && account.assigned === true
                    && account.currency === 'NGN'
                    && providerAccountId
                    && account.accountReference === `PAYSTACK_DVA_${providerAccountId}`
                ) {
                    const snapshots = user.virtualAccountGatewaySnapshots;
                    const gatewaySnapshot = snapshots instanceof Map
                        ? snapshots.get(account.accountReference)
                        : snapshots?.[account.accountReference];
                    matches.push({ userId: user._id, account, gatewaySnapshot: gatewaySnapshot || null });
                }
            }
        }

        return {
            match: matches.length === 1 ? matches[0] : null,
            matchCount: matches.length
        };
    }

    async _claimProvisioningWrite({
        userId,
        provider,
        gatewayId,
        provisioningKey,
        preferredBank,
        consentGrantedAt,
        gatewayContext,
        recoverIncompleteExpectedCount,
        session
    }) {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + PROVISIONING_LEASE_MS);
        const token = crypto.randomBytes(24).toString('hex');
        const preferenceSet = provider === 'paystack' ? {
            'virtualAccountPreferences.paystack.preferredBank': preferredBank,
            'virtualAccountPreferences.paystack.consentGrantedAt': consentGrantedAt
        } : {};
        const claimable = await this.User.findOneAndUpdate(
            {
                _id: userId,
                virtualAccounts: {
                    $elemMatch: {
                        provisioningKey,
                        $or: [
                            { provisioningStatus: 'failed' },
                            { provisioningStatus: 'pending', provisioningExpiresAt: { $lte: now } },
                            ...(recoverIncompleteExpectedCount
                                ? [{
                                    provisioningStatus: 'active',
                                    provisioningExpectedAccountCount: recoverIncompleteExpectedCount
                                }]
                                : [])
                        ]
                    }
                }
            },
            {
                $set: {
                    'virtualAccounts.$.provisioningStatus': 'pending',
                    'virtualAccounts.$.provisioningToken': token,
                    'virtualAccounts.$.provisioningStartedAt': now,
                    'virtualAccounts.$.provisioningExpiresAt': expiresAt,
                    'virtualAccounts.$.provisioningFailure': null,
                    'virtualAccounts.$.preferredBank': preferredBank || '',
                    'virtualAccounts.$.active': false,
                    'virtualAccounts.$.assigned': false,
                    ...preferenceSet,
                    ...(provider === 'paystack' ? { 'virtualAccounts.$.provisioningGatewayContext': gatewayContext } : {}),
                    ...(consentGrantedAt ? { 'virtualAccounts.$.consentGrantedAt': consentGrantedAt } : {})
                }
            },
            { new: true, ...(session ? { session } : {}) }
        );
        if (claimable) return { claimed: true, token };

        const inserted = await this.User.findOneAndUpdate(
            { _id: userId, 'virtualAccounts.provisioningKey': { $ne: provisioningKey } },
            {
                ...(provider === 'paystack' ? { $set: preferenceSet } : {}),
                $push: {
                    virtualAccounts: {
                        provider,
                        gatewayId: String(gatewayId),
                        preferredBank: preferredBank || '',
                        ...(consentGrantedAt ? { consentGrantedAt } : {}),
                        provisioningKey,
                        provisioningStatus: 'pending',
                        provisioningToken: token,
                        ...(provider === 'paystack' ? {
                            provisioningGatewayContext: gatewayContext,
                            provisioningDispatchState: 'not_started',
                            provisioningAttemptCount: 0
                        } : {}),
                        provisioningStartedAt: now,
                        provisioningExpiresAt: expiresAt,
                        active: false,
                        assigned: false
                    }
                }
            },
            { new: true, ...(session ? { session } : {}) }
        );
        return inserted ? { claimed: true, token } : { claimed: false, token: null };
    }

    async claimProvisioning(details) {
        const gatewayVersion = Number(details.gatewayMutationVersion);
        if (!Number.isSafeInteger(gatewayVersion) || gatewayVersion < 0) {
            return this._claimProvisioningWrite(details);
        }

        const session = await this.startSession();
        try {
            for (let attempt = 0; attempt < 3; attempt++) {
                session.startTransaction();
                try {
                    const versionFilter = gatewayVersion === 0
                        ? {
                            $or: [
                                { virtualAccountMutationVersion: 0 },
                                { virtualAccountMutationVersion: { $exists: false } }
                            ]
                        }
                        : { virtualAccountMutationVersion: gatewayVersion };
                    const fence = await this.PaymentGateway.updateOne(
                        {
                            _id: details.gatewayId,
                            code: details.provider,
                            adapterType: details.provider,
                            status: 'active',
                            ...versionFilter
                        },
                        { $inc: { virtualAccountClaimVersion: 1 } },
                        { session }
                    );
                    const matched = Number(fence?.matchedCount ?? fence?.n ?? 0);
                    if (matched !== 1) {
                        const error = new Error('Virtual-account gateway changed before provisioning could be claimed');
                        error.code = 'VIRTUAL_ACCOUNT_GATEWAY_CHANGED';
                        error.httpStatus = 409;
                        throw error;
                    }

                    const claim = await this._claimProvisioningWrite({ ...details, session });
                    if (!claim.claimed) {
                        await session.abortTransaction();
                        return claim;
                    }
                    await session.commitTransaction();
                    return claim;
                } catch (error) {
                    try { await session.abortTransaction(); } catch (_) {}
                    const transient = error?.hasErrorLabel?.('TransientTransactionError')
                        || [112, 251].includes(Number(error?.code));
                    if (transient && attempt < 2) continue;
                    throw error;
                }
            }
        } finally {
            await session.endSession();
        }
    }

    async setProvisioningIdentity({ userId, provisioningKey, token, customer = {}, account = null }) {
        const result = await this.User.updateOne(
            {
                _id: userId,
                virtualAccounts: { $elemMatch: { provisioningKey, provisioningToken: token, provisioningStatus: 'pending' } }
            },
            {
                $set: cleanObject({
                    'virtualAccounts.$.providerCustomerId': customer.providerCustomerId,
                    'virtualAccounts.$.providerCustomerCode': customer.providerCustomerCode,
                    ...(account?.providerAccountId ? { 'virtualAccounts.$.providerAccountId': String(account.providerAccountId) } : {}),
                    ...(account?.accountNumber ? { 'virtualAccounts.$.accountNumber': account.accountNumber } : {}),
                    ...(account?.bankSlug ? { 'virtualAccounts.$.bankSlug': account.bankSlug } : {})
                })
            }
        );
        return Number(result?.matchedCount ?? result?.n ?? result?.modifiedCount ?? result?.nModified ?? 0) > 0;
    }

    async setPaystackDispatchState({ userId, provisioningKey, token, state, message, incrementAttempt = false }) {
        const now = new Date();
        const set = {
            'virtualAccounts.$.provisioningDispatchState': state,
            ...(message !== undefined ? {
                'virtualAccounts.$.provisioningFailure': message
                    ? String(message).slice(0, 500)
                    : null
            } : {}),
            ...(state === 'dispatching' ? { 'virtualAccounts.$.provisioningLastDispatchAt': now } : {})
        };
        const update = { $set: set };
        if (incrementAttempt) update.$inc = { 'virtualAccounts.$.provisioningAttemptCount': 1 };
        const result = await this.User.updateOne(
            {
                _id: userId,
                virtualAccounts: {
                    $elemMatch: {
                        provisioningKey,
                        provisioningToken: token,
                        provisioningStatus: 'pending'
                    }
                }
            },
            update
        );
        return Number(result?.matchedCount ?? result?.n ?? result?.modifiedCount ?? result?.nModified ?? 0) > 0;
    }

    async markPaystackAssignmentRecoverable({ userId, account, message }) {
        if (account.provisioningStatus === 'failed') return true;
        const result = await this.User.updateOne(
            {
                _id: userId,
                virtualAccounts: {
                    $elemMatch: {
                        provider: 'paystack',
                        gatewayId: String(account.gatewayId),
                        provisioningKey: account.provisioningKey,
                        provisioningStatus: 'pending',
                        provisioningToken: account.provisioningToken,
                        providerCustomerId: String(account.providerCustomerId),
                        providerCustomerCode: account.providerCustomerCode,
                        $or: [
                            { provisioningDispatchState: { $in: ['awaiting_assignment', 'reconciling'] } },
                            { provisioningDispatchState: { $exists: false } }
                        ]
                    }
                }
            },
            {
                $set: {
                    'virtualAccounts.$.provisioningStatus': 'failed',
                    'virtualAccounts.$.provisioningDispatchState': 'retryable',
                    'virtualAccounts.$.provisioningExpiresAt': null,
                    'virtualAccounts.$.provisioningFailure': String(message || 'Paystack DVA assignment failed').slice(0, 500),
                    'virtualAccounts.$.active': false,
                    'virtualAccounts.$.assigned': false
                },
                $unset: { 'virtualAccounts.$.provisioningToken': 1 }
            }
        );
        return Number(result?.matchedCount ?? result?.n ?? result?.modifiedCount ?? result?.nModified ?? 0) > 0;
    }

    async completeProvisioning({ userId, provider, gatewayId, provisioningKey, token, accounts, snapshotKey, snapshot, requireUnexpiredAt }) {
        if (!Array.isArray(accounts) || accounts.length === 0) {
            throw new Error('At least one virtual account is required to complete provisioning');
        }
        const now = new Date();
        const normalized = accounts.map(account => cleanObject({
            ...account,
            _id: account._id || new mongoose.Types.ObjectId(),
            provider,
            gatewayId: String(gatewayId),
            provisioningKey,
            provisioningStatus: 'active',
            provisioningDispatchState: provider === 'paystack' ? 'complete' : account.provisioningDispatchState,
            provisioningStartedAt: account.provisioningStartedAt || now,
            provisioningExpiresAt: null,
            provisioningExpectedAccountCount: accounts.length,
            provisionedAt: now,
            provisioningFailure: null
        }));
        const set = {
            virtualAccounts: {
                $concatArrays: [
                    {
                        $filter: {
                            input: { $ifNull: ['$virtualAccounts', []] },
                            as: 'account',
                            cond: { $ne: ['$$account.provisioningKey', provisioningKey] }
                        }
                    },
                    { $literal: normalized }
                ]
            }
        };
        if (snapshotKey && snapshot) {
            set[`virtualAccountGatewaySnapshots.${snapshotKey}`] = { $literal: snapshot };
        }
        const claimMatch = { provisioningKey, provisioningToken: token, provisioningStatus: 'pending' };
        if (requireUnexpiredAt) claimMatch.provisioningExpiresAt = { $gt: requireUnexpiredAt };
        const completed = await this.User.findOneAndUpdate(
            {
                _id: userId,
                virtualAccounts: { $elemMatch: claimMatch }
            },
            [{ $set: set }],
            { new: true }
        );
        if (!completed) {
            const error = new Error('Virtual-account provisioning claim was lost before completion');
            error.code = 'VIRTUAL_ACCOUNT_CLAIM_LOST';
            throw error;
        }
        return this.listScope(userId, provider, gatewayId);
    }

    async failProvisioning({ userId, provisioningKey, token, message, requireUnexpiredAt }) {
        const claimMatch = { provisioningKey, provisioningToken: token, provisioningStatus: 'pending' };
        if (requireUnexpiredAt) claimMatch.provisioningExpiresAt = { $gt: requireUnexpiredAt };
        const result = await this.User.updateOne(
            {
                _id: userId,
                virtualAccounts: { $elemMatch: claimMatch }
            },
            {
                $set: {
                    'virtualAccounts.$.provisioningStatus': 'failed',
                    'virtualAccounts.$.provisioningExpiresAt': null,
                    'virtualAccounts.$.provisioningFailure': String(message || 'Virtual-account provisioning failed').slice(0, 500),
                    'virtualAccounts.$.active': false,
                    'virtualAccounts.$.assigned': false
                },
                $unset: { 'virtualAccounts.$.provisioningToken': 1 }
            }
        );
        return Number(result?.modifiedCount ?? result?.nModified ?? 0) > 0;
    }
}

class VirtualAccountService {
    constructor({ gatewayService = paymentGatewayService, repository = new MongoVirtualAccountRepository() } = {}) {
        this.gatewayService = gatewayService;
        this.repository = repository;
    }

    _error(message, code, httpStatus = 400) {
        const error = new Error(message);
        error.code = code;
        error.httpStatus = httpStatus;
        return error;
    }

    _persistedPaystackPreference(user) {
        const preference = user?.virtualAccountPreferences?.paystack;
        if (preference?.consentGrantedAt && preference?.preferredBank) {
            return {
                consentGrantedAt: new Date(preference.consentGrantedAt),
                preferredBank: preference.preferredBank
            };
        }

        const audited = (user?.virtualAccounts || [])
            .map(asPlainAccount)
            .filter(account => account.provider === 'paystack' && account.consentGrantedAt && account.preferredBank)
            .sort((left, right) => new Date(right.consentGrantedAt) - new Date(left.consentGrantedAt))[0];
        return audited ? {
            consentGrantedAt: new Date(audited.consentGrantedAt),
            preferredBank: audited.preferredBank
        } : null;
    }

    _isEligibilityError(error) {
        return new Set([
            'PAYSTACK_DVA_CONSENT_REQUIRED',
            'PAYSTACK_DVA_BANK_INVALID',
            'PAYSTACK_CUSTOMER_EMAIL_INVALID',
            'PAYSTACK_CUSTOMER_PHONE_INVALID',
            'PAYSTACK_CUSTOMER_NAME_INCOMPLETE',
            'MONNIFY_CUSTOMER_DATA_INVALID'
        ]).has(error?.code);
    }

    async provisionEligible({ userId, paystackConsent = false, paystackPreferredBank } = {}) {
        const user = await this.repository.getUser(userId);
        if (!user) {
            const unavailable = { status: 'failed', code: 'USER_NOT_FOUND', message: 'User not found' };
            return { paystack: unavailable, monnify: unavailable };
        }

        const persistedPaystack = this._persistedPaystackPreference(user);
        const paystackRequest = paystackConsent === true
            ? { consent: true, preferredBank: paystackPreferredBank }
            : persistedPaystack
                ? { consent: true, ...persistedPaystack }
                : null;

        const evaluate = async (providerCode, request = {}) => {
            try {
                return await this.provision({ userId, providerCode, ...request });
            } catch (error) {
                return {
                    status: this._isEligibilityError(error) ? 'skipped' : 'failed',
                    code: error.code || 'VIRTUAL_ACCOUNT_PROVISIONING_FAILED',
                    message: error.message
                };
            }
        };

        const paystack = paystackRequest
            ? evaluate('paystack', paystackRequest)
            : Promise.resolve({
                status: 'skipped',
                code: 'PAYSTACK_DVA_CONSENT_REQUIRED',
                message: 'Express consent is required for Paystack DVA provisioning'
            });
        const monnify = evaluate('monnify');

        const [paystackResult, monnifyResult] = await Promise.all([paystack, monnify]);
        return { paystack: paystackResult, monnify: monnifyResult };
    }

    _isActive(account) {
        return !!account.accountNumber
            && account.active !== false
            && (!account.provisioningStatus || account.provisioningStatus === 'active');
    }

    _isCompletePaystackAccount(account) {
        return account?.provisioningStatus === 'active'
            && account.active === true
            && account.assigned === true
            && account.currency === 'NGN'
            && !!account.providerAccountId
            && !!account.providerCustomerId
            && !!account.providerCustomerCode
            && !!account.accountNumber
            && account.accountReference === `PAYSTACK_DVA_${account.providerAccountId}`;
    }

    _sanitizePaystackAccounts(accounts) {
        return (accounts || []).map(value => {
            const account = asPlainAccount(value);
            delete account.provisioningToken;
            delete account.provisioningGatewayContext;
            delete account.provisioningDispatchState;
            delete account.provisioningAttemptCount;
            delete account.provisioningLastDispatchAt;
            return account;
        });
    }

    _terminalWebhookError(message, code) {
        const error = this._error(message, code);
        error.webhookTerminal = true;
        return error;
    }

    _paystackProviderSlugs(gateway, spec) {
        const environment = gateway?.environment === 'live' ? 'live' : 'test';
        return spec.virtualAccounts.providerSlugsByEnvironment?.[environment] || [];
    }

    _validatePaystackPreferredBank(gateway, preferredBank) {
        const allowedProviderSlugs = this._paystackProviderSlugs(gateway, getAdapterSpec('paystack'));
        if (!preferredBank || !allowedProviderSlugs.includes(preferredBank)) {
            throw this._error(
                `preferredBank must be one of: ${allowedProviderSlugs.join(', ')}`,
                'PAYSTACK_DVA_BANK_INVALID'
            );
        }
    }

    _paystackGatewayContext(gateway) {
        return crypto.createHash('sha256').update(JSON.stringify({
            gatewayId: String(gateway?._id || gateway?.gatewayId || ''),
            code: String(gateway?.code || '').toLowerCase(),
            adapterType: String(gateway?.adapterType || '').toLowerCase(),
            environment: gateway?.environment || '',
            baseUrl: String(gateway?.baseUrl || '').replace(/\/$/, ''),
            secretKey: gateway?.secretKey || ''
        })).digest('hex');
    }

    _paystackApprovedGatewayContexts(gateway) {
        const gatewayId = String(gateway?._id || gateway?.gatewayId || '');
        const gatewayCode = String(gateway?.code || '').toLowerCase();
        const contexts = new Map();
        const add = candidate => {
            if (!candidate) return;
            const candidateGatewayId = String(candidate.gatewayId || candidate._id || '');
            const candidateCode = String(candidate.code || '').toLowerCase();
            const candidateAdapter = String(candidate.adapterType || candidateCode).toLowerCase();
            if (
                candidateGatewayId !== gatewayId
                || candidateCode !== gatewayCode
                || candidateAdapter !== 'paystack'
            ) return;
            const hydrated = typeof this.gatewayService._hydrateGatewayCredentials === 'function'
                ? this.gatewayService._hydrateGatewayCredentials({ ...candidate, _id: gatewayId })
                : { ...candidate, _id: gatewayId };
            contexts.set(this._paystackGatewayContext(hydrated), hydrated);
        };

        add(gateway);
        for (const value of gateway?.webhookVerificationSnapshots || []) {
            add(value?.toObject ? value.toObject() : value);
        }
        return contexts;
    }

    _incompleteMonnifyExpectedCount(accounts, provisioningKey) {
        const operationAccounts = (accounts || []).filter(account => account.provisioningKey === provisioningKey);
        const expected = operationAccounts.reduce(
            (largest, account) => Math.max(largest, Number(account.provisioningExpectedAccountCount) || 0),
            0
        );
        if (expected < 1) return 0;
        const persisted = new Set(
            operationAccounts
                .filter(account => account.provisioningStatus === 'active' && account.accountNumber)
                .map(account => account.accountNumber)
        ).size;
        return persisted < expected ? expected : 0;
    }

    _isAmbiguousPaystackError(error) {
        const status = Number(error?.response?.status);
        if (!Number.isInteger(status)) return true;
        return status >= 500 || [408, 409, 425, 429].includes(status);
    }

    _claimLostError() {
        return this._error(
            'Virtual-account provisioning claim was lost before recovery completed',
            'VIRTUAL_ACCOUNT_CLAIM_LOST',
            409
        );
    }

    async _setPaystackDispatchState(details) {
        const updated = await this.repository.setPaystackDispatchState(details);
        if (!updated) throw this._claimLostError();
    }

    async _pendingPaystackResult(userId, gatewayId, existing = true) {
        return {
            status: 'pending',
            accounts: await this.repository.listScope(userId, 'paystack', gatewayId),
            existing
        };
    }

    _assertPaystackRecoveryAccount(account, { customer, existingAccount, preferredBank, requireActive }) {
        const customerId = String(customer?.providerCustomerId || '');
        const customerCode = String(customer?.providerCustomerCode || '');
        if (
            !customerId
            || !customerCode
            || String(account?.providerCustomerId || '') !== customerId
            || String(account?.providerCustomerCode || '') !== customerCode
        ) {
            throw this._error(
                'Paystack DVA evidence does not match the persisted customer',
                'PAYSTACK_DVA_RECOVERY_CUSTOMER_MISMATCH',
                409
            );
        }
        if (existingAccount?.providerAccountId && String(account.providerAccountId || '') !== String(existingAccount.providerAccountId)) {
            throw this._error('Paystack DVA identity changed during recovery', 'PAYSTACK_DVA_RECOVERY_ACCOUNT_MISMATCH', 409);
        }
        if (existingAccount?.accountNumber && account.accountNumber !== existingAccount.accountNumber) {
            throw this._error('Paystack DVA account number changed during recovery', 'PAYSTACK_DVA_RECOVERY_ACCOUNT_MISMATCH', 409);
        }
        if (preferredBank && account.bankSlug && account.bankSlug !== preferredBank) {
            throw this._error('Paystack DVA bank does not match the provisioning request', 'PAYSTACK_DVA_RECOVERY_BANK_MISMATCH', 409);
        }
        if (requireActive && (
            !account.providerAccountId
            || !account.accountName
            || !account.accountNumber
            || !account.bankName
            || !account.bankSlug
            || account.currency !== 'NGN'
            || account.active !== true
            || account.assigned !== true
        )) {
            throw this._error('Paystack returned incomplete active DVA evidence', 'PAYSTACK_DVA_RESPONSE_INVALID', 502);
        }
    }

    async _completePaystackProvisioning({ user, gateway, provisioningKey, token, account, customer, preferredBank }) {
        const normalized = {
            ...account,
            providerCustomerId: String(account.providerCustomerId || customer.providerCustomerId || ''),
            providerCustomerCode: account.providerCustomerCode || customer.providerCustomerCode || '',
            currency: String(account.currency || 'NGN').toUpperCase()
        };
        this._assertPaystackRecoveryAccount(normalized, {
            customer,
            existingAccount: null,
            preferredBank,
            requireActive: true
        });
        const accountReference = `PAYSTACK_DVA_${normalized.providerAccountId}`;
        const accounts = await this.repository.completeProvisioning({
            userId: user._id,
            provider: 'paystack',
            gatewayId: gateway._id,
            provisioningKey,
            token,
            accounts: [{
                bankName: normalized.bankName,
                bankCode: normalized.bankCode,
                bankSlug: normalized.bankSlug,
                accountName: normalized.accountName,
                accountNumber: normalized.accountNumber,
                currency: normalized.currency,
                accountReference,
                providerAccountId: String(normalized.providerAccountId),
                providerCustomerId: normalized.providerCustomerId,
                providerCustomerCode: normalized.providerCustomerCode,
                preferredBank: normalized.bankSlug,
                active: true,
                assigned: true
            }],
            snapshotKey: accountReference,
            snapshot: this.gatewayService._snapshotGatewayConfig(gateway)
        });
        return { status: 'active', accounts, existing: false };
    }

    async _provisionPaystack({ user, gateway, adapter, preferredBank, provisioningKey, token, existingAccount, previousOperation }) {
        this._validatePaystackPreferredBank(gateway, preferredBank);
        const customerData = adapter.getVirtualAccountCustomer(user);
        let dispatchState = existingAccount?.provisioningDispatchState
            || previousOperation?.provisioningDispatchState
            || 'not_started';
        const previousAttemptCount = Number(
            existingAccount?.provisioningAttemptCount
            ?? previousOperation?.provisioningAttemptCount
            ?? 0
        );
        const legacyRecoveryStateUnknown = !!previousOperation
            && !previousOperation.provisioningDispatchState;
        let customer = null;
        if (existingAccount?.providerCustomerCode) {
            customer = await adapter.fetchCustomer(existingAccount.providerCustomerCode);
        }
        if (!customer) customer = await adapter.fetchCustomer(customerData.email);
        if (customer && existingAccount?.providerCustomerCode
            && customer.providerCustomerCode !== existingAccount.providerCustomerCode) {
            throw this._error(
                'Paystack customer identity changed during recovery',
                'PAYSTACK_DVA_RECOVERY_CUSTOMER_MISMATCH',
                409
            );
        }
        if (!customer) {
            if (['customer_creating', 'dispatching', 'awaiting_assignment', 'reconciling'].includes(dispatchState)) {
                await this._setPaystackDispatchState({
                    userId: user._id,
                    provisioningKey,
                    token,
                    state: 'reconciling',
                    message: 'Waiting for Paystack customer reconciliation after an interrupted request'
                });
                return this._pendingPaystackResult(user._id, gateway._id);
            }
            await this._setPaystackDispatchState({
                userId: user._id,
                provisioningKey,
                token,
                state: 'customer_creating',
                message: null
            });
            try {
                customer = await adapter.createCustomer(customerData);
            } catch (error) {
                if (!this._isAmbiguousPaystackError(error)) {
                    await this._setPaystackDispatchState({
                        userId: user._id,
                        provisioningKey,
                        token,
                        state: 'not_started',
                        message: error.message
                    });
                    throw error;
                }
                await this._setPaystackDispatchState({
                    userId: user._id,
                    provisioningKey,
                    token,
                    state: 'reconciling',
                    message: error.message
                });
                return this._pendingPaystackResult(user._id, gateway._id);
            }
            dispatchState = 'customer_ready';
        }
        if (!customer?.providerCustomerCode) {
            throw this._error('Paystack did not return a customer code', 'PAYSTACK_CUSTOMER_RESPONSE_INVALID', 502);
        }

        const identityUpdated = await this.repository.setProvisioningIdentity({
            userId: user._id,
            provisioningKey,
            token,
            customer
        });
        if (!identityUpdated) throw this._claimLostError();
        if (['not_started', 'customer_creating'].includes(dispatchState)) {
            await this._setPaystackDispatchState({
                userId: user._id,
                provisioningKey,
                token,
                state: 'customer_ready',
                message: null
            });
            dispatchState = 'customer_ready';
        }

        let account = customer.dedicatedAccount;
        if (!account && existingAccount?.providerAccountId && typeof adapter.fetchDedicatedVirtualAccount === 'function') {
            try {
                account = await adapter.fetchDedicatedVirtualAccount(existingAccount.providerAccountId);
            } catch (error) {
                if (!this._isAmbiguousPaystackError(error)) throw error;
                await this._setPaystackDispatchState({
                    userId: user._id,
                    provisioningKey,
                    token,
                    state: 'reconciling',
                    message: error.message
                });
                return this._pendingPaystackResult(user._id, gateway._id);
            }
        }
        if (account) {
            account = {
                ...account,
                providerCustomerId: String(account.providerCustomerId || customer.providerCustomerId || ''),
                providerCustomerCode: account.providerCustomerCode || customer.providerCustomerCode || '',
                currency: String(account.currency || 'NGN').toUpperCase()
            };
            this._assertPaystackRecoveryAccount(account, {
                customer,
                existingAccount,
                preferredBank,
                requireActive: false
            });
            const accountIdentityUpdated = await this.repository.setProvisioningIdentity({
                userId: user._id,
                provisioningKey,
                token,
                customer,
                account
            });
            if (!accountIdentityUpdated) throw this._claimLostError();
            if (account.accountNumber && account.active && account.assigned) {
                return this._completePaystackProvisioning({
                    user,
                    gateway,
                    provisioningKey,
                    token,
                    account,
                    customer,
                    preferredBank
                });
            }
            await this._setPaystackDispatchState({
                userId: user._id,
                provisioningKey,
                token,
                state: 'awaiting_assignment',
                message: null
            });
            return this._pendingPaystackResult(user._id, gateway._id, false);
        }

        const confirmedRetryable = dispatchState === 'retryable';
        const providerMutationMayHaveOccurred = !confirmedRetryable && (previousAttemptCount > 0
            || legacyRecoveryStateUnknown
            || ['dispatching', 'awaiting_assignment', 'reconciling'].includes(dispatchState));
        if (providerMutationMayHaveOccurred) {
            await this._setPaystackDispatchState({
                userId: user._id,
                provisioningKey,
                token,
                state: 'reconciling',
                message: 'Waiting for Paystack DVA reconciliation before another assignment request'
            });
            return this._pendingPaystackResult(user._id, gateway._id);
        }

        await this._setPaystackDispatchState({
            userId: user._id,
            provisioningKey,
            token,
            state: 'dispatching',
            message: null,
            incrementAttempt: true
        });
        let result;
        try {
            result = await adapter.createDedicatedVirtualAccount({
                customer: customer.providerCustomerCode,
                preferredBank,
                ...customerData
            });
        } catch (error) {
            if (!this._isAmbiguousPaystackError(error)) {
                await this._setPaystackDispatchState({
                    userId: user._id,
                    provisioningKey,
                    token,
                    state: 'retryable',
                    message: error.message
                });
                throw error;
            }
            await this._setPaystackDispatchState({
                userId: user._id,
                provisioningKey,
                token,
                state: 'awaiting_assignment',
                message: error.message
            });
            return this._pendingPaystackResult(user._id, gateway._id, false);
        }
        account = result?.account;
        if (account) {
            account = {
                ...account,
                providerCustomerId: String(account.providerCustomerId || customer.providerCustomerId || ''),
                providerCustomerCode: account.providerCustomerCode || customer.providerCustomerCode || '',
                currency: String(account.currency || 'NGN').toUpperCase()
            };
            this._assertPaystackRecoveryAccount(account, {
                customer,
                existingAccount,
                preferredBank,
                requireActive: false
            });
            const accountIdentityUpdated = await this.repository.setProvisioningIdentity({
                userId: user._id,
                provisioningKey,
                token,
                customer,
                account
            });
            if (!accountIdentityUpdated) throw this._claimLostError();
        }
        if (!account?.accountNumber || result.status !== 'active' || !account.active || !account.assigned) {
            await this._setPaystackDispatchState({
                userId: user._id,
                provisioningKey,
                token,
                state: 'awaiting_assignment',
                message: null
            });
            return this._pendingPaystackResult(user._id, gateway._id, false);
        }
        return this._completePaystackProvisioning({
            user,
            gateway,
            provisioningKey,
            token,
            account,
            customer,
            preferredBank
        });
    }

    async handlePaystackAssignmentWebhook({ gateway, normalized }) {
        const gatewayId = String(gateway?._id || '');
        const adapterType = String(gateway?.adapterType || gateway?.code || '').toLowerCase();
        if (!gatewayId || adapterType !== 'paystack') {
            throw this._terminalWebhookError('Paystack assignment webhook gateway is invalid', 'PAYSTACK_DVA_WEBHOOK_GATEWAY_INVALID');
        }
        if (
            normalized?.eventDomain !== 'virtual_account_provisioning'
            || !['dedicatedaccount.assign.success', 'dedicatedaccount.assign.failed'].includes(normalized.eventType)
        ) {
            throw this._terminalWebhookError('Paystack assignment webhook event is invalid', 'PAYSTACK_DVA_WEBHOOK_EVENT_INVALID');
        }

        const evidence = normalized.virtualAccount || {};
        if (!evidence.providerCustomerId || !evidence.providerCustomerCode) {
            throw this._terminalWebhookError('Paystack assignment webhook customer identity is incomplete', 'PAYSTACK_DVA_WEBHOOK_MALFORMED');
        }

        const approvedGatewayContexts = this._paystackApprovedGatewayContexts(gateway);
        const gatewayContext = this._paystackGatewayContext(gateway);
        const lookup = await this.repository.findPaystackProvisioningForAssignment({
            gatewayId,
            gatewayContexts: [...approvedGatewayContexts.keys()],
            providerCustomerId: evidence.providerCustomerId,
            providerCustomerCode: evidence.providerCustomerCode
        });
        if (lookup.matchCount !== 1 || !lookup.match) {
            throw this._terminalWebhookError(
                lookup.matchCount > 1
                    ? 'Paystack assignment webhook matches multiple provisioning records'
                    : 'Paystack assignment webhook does not match an active provisioning request',
                lookup.matchCount > 1 ? 'PAYSTACK_DVA_WEBHOOK_AMBIGUOUS' : 'PAYSTACK_DVA_WEBHOOK_UNMATCHED'
            );
        }

        const { userId, account: pending } = lookup.match;
        const provisioningGatewayContext = pending.provisioningGatewayContext || gatewayContext;
        const provisioningGateway = approvedGatewayContexts.get(provisioningGatewayContext);
        if (!provisioningGateway) {
            throw this._terminalWebhookError(
                'Paystack assignment webhook does not match an approved provisioning gateway context',
                'PAYSTACK_DVA_WEBHOOK_GATEWAY_CONTEXT_MISMATCH'
            );
        }
        const incoming = evidence.account;
        if (incoming?.providerAccountId && pending.providerAccountId
            && String(incoming.providerAccountId) !== String(pending.providerAccountId)) {
            throw this._terminalWebhookError('Paystack assignment webhook account does not match the provisioning request', 'PAYSTACK_DVA_WEBHOOK_ACCOUNT_MISMATCH');
        }
        if (incoming?.accountNumber && pending.accountNumber && incoming.accountNumber !== pending.accountNumber) {
            throw this._terminalWebhookError('Paystack assignment webhook account number does not match the provisioning request', 'PAYSTACK_DVA_WEBHOOK_ACCOUNT_MISMATCH');
        }
        if (incoming?.bankSlug && pending.preferredBank && incoming.bankSlug !== pending.preferredBank) {
            throw this._terminalWebhookError('Paystack assignment webhook bank does not match the provisioning request', 'PAYSTACK_DVA_WEBHOOK_BANK_MISMATCH');
        }

        if (pending.provisioningStatus === 'active') {
            if (normalized.eventType === 'dedicatedaccount.assign.failed') {
                return { status: 'active', userId: String(userId), accounts: [pending], existing: true };
            }
            if (
                !incoming
                || String(incoming.providerAccountId || '') !== String(pending.providerAccountId || '')
                || incoming.accountNumber !== pending.accountNumber
            ) {
                throw this._terminalWebhookError('Duplicate Paystack assignment response conflicts with the active account', 'PAYSTACK_DVA_WEBHOOK_ACCOUNT_MISMATCH');
            }
            return { status: 'active', userId: String(userId), accounts: [pending], existing: true };
        }

        if (normalized.eventType === 'dedicatedaccount.assign.failed') {
            const failed = await this.repository.markPaystackAssignmentRecoverable({
                userId,
                account: pending,
                message: evidence.reason
            });
            if (failed === false) {
                throw this._error(
                    'Paystack assignment failure could not safely claim the current provisioning operation',
                    'VIRTUAL_ACCOUNT_CLAIM_LOST',
                    409
                );
            }
            return { status: 'failed', userId: String(userId) };
        }

        if (
            !incoming?.providerAccountId
            || !incoming.accountName
            || !incoming.accountNumber
            || !incoming.bankName
            || !incoming.bankSlug
            || incoming.currency !== 'NGN'
            || incoming.active !== true
            || incoming.assigned !== true
            || incoming.providerCustomerId !== String(evidence.providerCustomerId)
            || incoming.providerCustomerCode !== evidence.providerCustomerCode
        ) {
            throw this._terminalWebhookError('Paystack assignment success payload is incomplete', 'PAYSTACK_DVA_WEBHOOK_MALFORMED');
        }
        const assignmentClaim = await this.repository.claimPaystackAssignment({
            userId,
            account: pending,
            gatewayContext: provisioningGatewayContext
        });
        if (!assignmentClaim.claimed) {
            throw this._error(
                'Paystack assignment provisioning state changed before completion',
                'VIRTUAL_ACCOUNT_CLAIM_LOST',
                409
            );
        }

        const accountReference = `PAYSTACK_DVA_${incoming.providerAccountId}`;
        const accounts = await this.repository.completeProvisioning({
            userId,
            provider: 'paystack',
            gatewayId,
            provisioningKey: pending.provisioningKey,
            token: assignmentClaim.token,
            accounts: [{
                bankName: incoming.bankName,
                bankCode: incoming.bankCode,
                bankSlug: incoming.bankSlug,
                accountName: incoming.accountName,
                accountNumber: incoming.accountNumber,
                currency: incoming.currency,
                accountReference,
                providerAccountId: incoming.providerAccountId,
                providerCustomerId: evidence.providerCustomerId,
                providerCustomerCode: evidence.providerCustomerCode,
                preferredBank: incoming.bankSlug,
                active: true,
                assigned: true
            }],
            snapshotKey: accountReference,
            snapshot: this.gatewayService._snapshotGatewayConfig(provisioningGateway)
        });
        return { status: 'active', userId: String(userId), accounts };
    }

    async resolvePaystackDepositOwner({ gateway, accountNumber, providerCustomerId, providerCustomerCode }) {
        const gatewayId = String(gateway?._id || '');
        const adapterType = String(gateway?.adapterType || gateway?.code || '').toLowerCase();
        if (!gatewayId || adapterType !== 'paystack') {
            throw this._terminalWebhookError('Paystack DVA deposit gateway is invalid', 'PAYSTACK_DVA_DEPOSIT_GATEWAY_INVALID');
        }
        if (!accountNumber || !providerCustomerId || !providerCustomerCode) {
            throw this._terminalWebhookError('Paystack DVA deposit ownership evidence is incomplete', 'PAYSTACK_DVA_DEPOSIT_MALFORMED');
        }

        const lookup = await this.repository.findActivePaystackDepositOwner({
            gatewayId,
            accountNumber,
            providerCustomerId,
            providerCustomerCode
        });
        if (lookup.matchCount !== 1 || !lookup.match) {
            throw this._terminalWebhookError(
                lookup.matchCount > 1
                    ? 'Paystack DVA deposit ownership is ambiguous'
                    : 'Paystack DVA deposit does not match an active virtual account',
                lookup.matchCount > 1 ? 'PAYSTACK_DVA_DEPOSIT_AMBIGUOUS' : 'PAYSTACK_DVA_DEPOSIT_UNMATCHED'
            );
        }
        return lookup.match;
    }

    async _provisionMonnify({ user, gateway, adapter, provisioningKey, token }) {
        adapter.assertVirtualAccountCustomer(user);
        let result;
        try {
            result = await adapter.createReservedAccount(user);
        } catch (error) {
            if (!String(error.message || '').includes('same reference')) throw error;
            result = await adapter.getReservedAccount(`VIRTUAL_${user._id}`);
        }
        if (!result?.status || !Array.isArray(result.accounts) || result.accounts.length === 0) {
            throw this._error('Monnify returned no virtual accounts', 'MONNIFY_VIRTUAL_ACCOUNT_RESPONSE_INVALID', 502);
        }
        const accountReference = result.accountReference || `VIRTUAL_${user._id}`;
        const accounts = await this.repository.completeProvisioning({
            userId: user._id,
            provider: 'monnify',
            gatewayId: gateway._id,
            provisioningKey,
            token,
            accounts: result.accounts.map(account => ({
                bankName: account.bankName,
                bankCode: account.bankCode,
                accountName: account.accountName || user.name,
                accountNumber: account.accountNumber,
                currency: 'NGN',
                accountReference,
                active: true,
                assigned: true
            })),
            snapshotKey: accountReference,
            snapshot: this.gatewayService._snapshotGatewayConfig(gateway)
        });
        return { status: 'active', accounts, existing: false };
    }

    async provision({ userId, providerCode, preferredBank, consent, consentGrantedAt }) {
        const normalizedCode = String(providerCode || '').trim().toLowerCase();
        if (!userId || !normalizedCode) {
            throw this._error('User and virtual-account provider are required', 'VIRTUAL_ACCOUNT_REQUEST_INVALID');
        }
        const user = await this.repository.getUser(userId);
        if (!user) throw this._error('User not found', 'USER_NOT_FOUND', 404);

        const gateway = await this.gatewayService.getGateway(normalizedCode);
        if (!gateway) {
            throw this._error(`${normalizedCode} gateway is not active`, 'VIRTUAL_ACCOUNT_GATEWAY_INACTIVE', 503);
        }
        const provider = String(gateway.adapterType || gateway.code || '').toLowerCase();
        const spec = getAdapterSpec(provider);
        if (!spec?.virtualAccounts?.supported) {
            throw this._error(`${provider} does not support permanent virtual accounts`, 'VIRTUAL_ACCOUNT_PROVIDER_UNSUPPORTED');
        }
        const isCanonicalGateway = String(gateway.code || '').toLowerCase() === provider;
        if (provider === 'paystack') {
            if (consent !== true) {
                throw this._error('Express consent is required for Paystack DVA provisioning', 'PAYSTACK_DVA_CONSENT_REQUIRED');
            }
            this._validatePaystackPreferredBank(gateway, preferredBank);
        }
        const gatewayId = String(gateway._id);
        const provisioningKey = `${provider}:${gatewayId}`;
        const gatewayContext = provider === 'paystack' ? this._paystackGatewayContext(gateway) : null;
        const gatewayMutationVersion = gatewayId.startsWith('legacy-env-')
            ? undefined
            : Number(gateway.virtualAccountMutationVersion || 0);
        const current = await this.repository.listScope(userId, provider, gatewayId);
        const incompleteMonnifyExpectedCount = provider === 'monnify'
            ? this._incompleteMonnifyExpectedCount(current, provisioningKey)
            : 0;
        const monnifyRecoveryInFlight = incompleteMonnifyExpectedCount > 0 && current.some(account => (
            account.provisioningKey === provisioningKey
            && account.provisioningStatus === 'pending'
            && account.provisioningExpiresAt
            && new Date(account.provisioningExpiresAt) > new Date()
        ));
        const active = current.filter(account => provider === 'paystack'
            ? this._isCompletePaystackAccount(account)
            : this._isActive(account));
        if (!isCanonicalGateway) {
            const boundActive = active.filter(account => (
                account.provider === provider
                && String(account.gatewayId || '') === gatewayId
            ));
            if (boundActive.length > 0 && incompleteMonnifyExpectedCount === 0) {
                return {
                    status: 'active',
                    accounts: provider === 'paystack' ? this._sanitizePaystackAccounts(boundActive) : boundActive,
                    existing: true
                };
            }
            throw this._error(
                `${gateway.code} cannot provision virtual accounts because its canonical ${provider} webhook route cannot identify it`,
                'VIRTUAL_ACCOUNT_GATEWAY_ALIAS_UNSUPPORTED',
                409
            );
        }
        if (active.length > 0 && incompleteMonnifyExpectedCount === 0) {
            return {
                status: 'active',
                accounts: provider === 'paystack' ? this._sanitizePaystackAccounts(active) : active,
                existing: true
            };
        }
        if (gateway.status !== 'active') {
            throw this._error(`${normalizedCode} gateway is not active`, 'VIRTUAL_ACCOUNT_GATEWAY_INACTIVE', 503);
        }
        const adapter = this.gatewayService.getAdapterInstance(gateway);
        const existingOperation = current.find(account => account.provisioningKey === provisioningKey) || null;
        if (provider === 'paystack' && existingOperation) {
            if (existingOperation.provisioningGatewayContext
                && existingOperation.provisioningGatewayContext !== gatewayContext) {
                throw this._error(
                    'Paystack gateway credentials changed during DVA provisioning; the original operation requires reconciliation',
                    'PAYSTACK_DVA_GATEWAY_CONTEXT_MISMATCH',
                    409
                );
            }
            if (existingOperation.preferredBank && existingOperation.preferredBank !== preferredBank) {
                throw this._error(
                    'Paystack DVA recovery must use the original preferred bank',
                    'PAYSTACK_DVA_RECOVERY_BANK_MISMATCH',
                    409
                );
            }
        }
        let effectiveConsentGrantedAt = null;
        if (provider === 'paystack') {
            effectiveConsentGrantedAt = consentGrantedAt ? new Date(consentGrantedAt) : new Date();
            if (Number.isNaN(effectiveConsentGrantedAt.getTime()) || effectiveConsentGrantedAt > new Date()) {
                throw this._error('Paystack consent timestamp is invalid', 'PAYSTACK_DVA_CONSENT_REQUIRED');
            }
            try {
                adapter.getVirtualAccountCustomer(user);
            } catch (error) {
                if (!consentGrantedAt && this._isEligibilityError(error)) {
                    await this.repository.savePaystackPreference({
                        userId,
                        preferredBank,
                        consentGrantedAt: effectiveConsentGrantedAt,
                        provisioningKey
                    });
                }
                throw error;
            }
        } else if (provider === 'monnify') {
            adapter.assertVirtualAccountCustomer(user);
        }

        const claim = await this.repository.claimProvisioning({
            userId,
            provider,
            gatewayId,
            provisioningKey,
            preferredBank,
            consentGrantedAt: effectiveConsentGrantedAt,
            gatewayContext,
            gatewayMutationVersion,
            recoverIncompleteExpectedCount: monnifyRecoveryInFlight ? 0 : incompleteMonnifyExpectedCount
        });
        if (!claim.claimed) {
            const accounts = await this.repository.listScope(userId, provider, gatewayId);
            const winningOperation = accounts.find(account => account.provisioningKey === provisioningKey);
            if (provider === 'paystack' && winningOperation?.preferredBank
                && winningOperation.preferredBank !== preferredBank) {
                throw this._error(
                    'Paystack DVA provisioning was claimed for a different preferred bank',
                    'PAYSTACK_DVA_RECOVERY_BANK_MISMATCH',
                    409
                );
            }
            return {
                status: 'pending',
                accounts: provider === 'paystack' ? this._sanitizePaystackAccounts(accounts) : accounts,
                existing: true
            };
        }

        try {
            const claimedAccounts = await this.repository.listScope(userId, provider, gatewayId);
            const existingAccount = claimedAccounts.find(account => account.provisioningKey === provisioningKey) || null;
            if (provider === 'paystack') {
                const result = await this._provisionPaystack({
                    user,
                    gateway,
                    adapter,
                    preferredBank,
                    provisioningKey,
                    token: claim.token,
                    existingAccount,
                    previousOperation: existingOperation
                });
                return { ...result, accounts: this._sanitizePaystackAccounts(result.accounts) };
            }
            if (provider === 'monnify') {
                return await this._provisionMonnify({
                    user,
                    gateway,
                    adapter,
                    provisioningKey,
                    token: claim.token
                });
            }
            throw this._error(`${provider} virtual-account provisioning is not implemented`, 'VIRTUAL_ACCOUNT_PROVIDER_UNSUPPORTED');
        } catch (error) {
            await this.repository.failProvisioning({
                userId,
                provisioningKey,
                token: claim.token,
                message: error.message
            });
            throw error;
        }
    }
}

module.exports = new VirtualAccountService();
module.exports.VirtualAccountService = VirtualAccountService;
module.exports.MongoVirtualAccountRepository = MongoVirtualAccountRepository;
