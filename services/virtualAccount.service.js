'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const PaymentGateway = require('../models/PaymentGateway');
const paymentGatewayService = require('./paymentGateway.service');
const onboardingService = require('./onboarding.service');
const legalService = require('./legalDocument.service');
const onboardingConfigService = require('./onboardingConfig.service');
const { getAdapterSpec } = require('../adapters/payment/paymentAdapterRegistry');

const PROVISIONING_LEASE_MS = 15 * 60 * 1000;
const VIRTUAL_ACCOUNT_CONSENT_VERSION = 'permanent_virtual_account_v1';
const VIRTUAL_ACCOUNT_PROVIDERS = Object.freeze(['paystack', 'monnify']);
const RECOVERY_BATCH_SIZE = 25;
const ELIGIBILITY_SWEEP_BATCH_SIZE = 25;
const RECOVERY_MAX_ATTEMPTS = 5;
const RECOVERY_BASE_DELAY_MS = 5 * 60 * 1000;
const RECOVERY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;

const recoveryDelayMs = attempt => Math.min(
    RECOVERY_BASE_DELAY_MS * (2 ** Math.max(0, Number(attempt || 1) - 1)),
    RECOVERY_MAX_DELAY_MS
);

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

    async getGatewayEnvironment(provider) {
        let query = this.PaymentGateway.findOne({ code: provider });
        if (typeof query?.select === 'function') query = query.select('environment');
        const gateway = await query;
        return gateway?.environment === 'live' ? 'live' : 'test';
    }

    async listScope(userId, provider, gatewayId) {
        const user = await this.getUser(userId);
        if (!user) return [];
        return (user.virtualAccounts || [])
            .map(asPlainAccount)
            .filter(account => (
                account.provider === provider && String(account.gatewayId || '') === String(gatewayId)
            ));
    }

    async listLegacyUnverified(userId) {
        const user = await this.getUser(userId);
        if (!user) return [];
        return (user.virtualAccounts || [])
            .map(asPlainAccount)
            .filter(account => !account.provider && !!account.accountNumber);
    }

    async saveProviderPreference({
        userId,
        provider,
        preferredBank,
        consentGrantedAt,
        consentVersion,
        consentChannel,
        provisioningKey
    }) {
        if (!VIRTUAL_ACCOUNT_PROVIDERS.includes(provider)) return false;
        const prefix = `virtualAccountPreferences.${provider}`;
        const result = await this.User.updateOne(
            {
                _id: userId,
                ...(provisioningKey ? { 'virtualAccounts.provisioningKey': { $ne: provisioningKey } } : {})
            },
            {
                $set: {
                    ...(preferredBank ? { [`${prefix}.preferredBank`]: preferredBank } : {}),
                    [`${prefix}.consentGrantedAt`]: consentGrantedAt,
                    [`${prefix}.consentVersion`]: consentVersion,
                    [`${prefix}.consentChannel`]: consentChannel
                }
            }
        );
        return Number(result?.matchedCount ?? result?.n ?? result?.modifiedCount ?? result?.nModified ?? 0) > 0;
    }

    async savePaystackPreference(details) {
        return this.saveProviderPreference({ ...details, provider: 'paystack' });
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
                    'virtualAccounts.$.provisioningFailure': null,
                    'virtualAccounts.$.provisioningFailureCode': null,
                    'virtualAccounts.$.provisioningFailureDisposition': null
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

    async findActiveMonnifyDepositOwner({ gatewayId, accountReference, accountNumber, allowUnscopedCanonical = false }) {
        const scope = {
            provider: 'monnify',
            ...(allowUnscopedCanonical
                ? {
                    $or: [
                        { gatewayId: String(gatewayId) },
                        { gatewayId: { $exists: false } },
                        { gatewayId: null },
                        { gatewayId: '' }
                    ]
                }
                : { gatewayId: String(gatewayId) }),
            accountReference,
            accountNumber,
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
                if (
                    account.provider === 'monnify'
                    && (
                        String(account.gatewayId || '') === String(gatewayId)
                        || (allowUnscopedCanonical && !account.gatewayId)
                    )
                    && account.accountReference === accountReference
                    && account.accountNumber === accountNumber
                    && account.provisioningStatus === 'active'
                    && account.active === true
                    && account.assigned === true
                    && account.currency === 'NGN'
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

    async listRecoveryCandidates({ now = new Date(), limit = RECOVERY_BATCH_SIZE } = {}) {
        const due = {
            provider: { $in: VIRTUAL_ACCOUNT_PROVIDERS },
            $and: [
                {
                    $or: [
                        { provisioningStatus: 'pending', provisioningExpiresAt: { $lte: now } },
                        {
                            provisioningStatus: 'failed',
                            provisioningFailureDisposition: { $ne: 'definitive_rejection' }
                        }
                    ]
                },
                {
                    $or: [
                        { provisioningNextRecoveryAt: { $exists: false } },
                        { provisioningNextRecoveryAt: null },
                        { provisioningNextRecoveryAt: { $lte: now } }
                    ]
                },
                {
                    $or: [
                        { provisioningRecoveryAttemptCount: { $exists: false } },
                        { provisioningRecoveryAttemptCount: { $lt: RECOVERY_MAX_ATTEMPTS } }
                    ]
                }
            ]
        };
        let query = this.User.find({ virtualAccounts: { $elemMatch: due } });
        if (typeof query?.sort === 'function') query = query.sort({ updatedAt: 1 });
        if (typeof query?.limit === 'function') query = query.limit(limit);
        const users = await query;
        const candidates = [];
        for (const user of users || []) {
            for (const value of user.virtualAccounts || []) {
                const account = asPlainAccount(value);
                const attempts = Number(account.provisioningRecoveryAttemptCount || 0);
                const nextAt = account.provisioningNextRecoveryAt
                    ? new Date(account.provisioningNextRecoveryAt)
                    : null;
                const pendingExpired = account.provisioningStatus === 'pending'
                    && account.provisioningExpiresAt
                    && new Date(account.provisioningExpiresAt) <= now;
                const retryableFailure = account.provisioningStatus === 'failed'
                    && account.provisioningFailureDisposition !== 'definitive_rejection';
                if (
                    VIRTUAL_ACCOUNT_PROVIDERS.includes(account.provider)
                    && account.provisioningKey
                    && attempts < RECOVERY_MAX_ATTEMPTS
                    && (!nextAt || nextAt <= now)
                    && (pendingExpired || retryableFailure)
                ) {
                    candidates.push({ userId: user._id, account });
                }
            }
        }
        return candidates.slice(0, limit);
    }

    async listEligibilitySweepPage({ afterId = null, limit = ELIGIBILITY_SWEEP_BATCH_SIZE } = {}) {
        let query = this.User.find(afterId ? { _id: { $gt: afterId } } : {});
        if (typeof query?.sort === 'function') query = query.sort({ _id: 1 });
        if (typeof query?.limit === 'function') query = query.limit(limit);
        if (typeof query?.select === 'function') {
            query = query.select('_id status isPinSet virtualAccounts virtualAccountPreferences');
        }
        return await query || [];
    }

    async claimRecoveryAttempt({ userId, provisioningKey, now = new Date(), attempt }) {
        const nextRecoveryAt = new Date(now.getTime() + recoveryDelayMs(attempt));
        const due = {
            provisioningKey,
            provider: { $in: VIRTUAL_ACCOUNT_PROVIDERS },
            $and: [
                {
                    $or: [
                        { provisioningStatus: 'pending', provisioningExpiresAt: { $lte: now } },
                        {
                            provisioningStatus: 'failed',
                            provisioningFailureDisposition: { $ne: 'definitive_rejection' }
                        }
                    ]
                },
                {
                    $or: [
                        { provisioningNextRecoveryAt: { $exists: false } },
                        { provisioningNextRecoveryAt: null },
                        { provisioningNextRecoveryAt: { $lte: now } }
                    ]
                },
                {
                    $or: [
                        { provisioningRecoveryAttemptCount: { $exists: false } },
                        { provisioningRecoveryAttemptCount: { $lt: RECOVERY_MAX_ATTEMPTS } }
                    ]
                }
            ]
        };
        const result = await this.User.updateOne(
            { _id: userId, virtualAccounts: { $elemMatch: due } },
            {
                $set: {
                    'virtualAccounts.$.provisioningLastRecoveryAt': now,
                    'virtualAccounts.$.provisioningNextRecoveryAt': nextRecoveryAt
                }
            }
        );
        return Number(result?.modifiedCount ?? result?.nModified ?? 0) > 0;
    }

    async _claimProvisioningWrite({
        userId,
        provider,
        gatewayId,
        provisioningKey,
        preferredBank,
        consentGrantedAt,
        consentVersion,
        consentChannel,
        gatewayContext,
        retryRejected,
        recoverIncompleteExpectedCount,
        internalRecovery,
        session
    }) {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + PROVISIONING_LEASE_MS);
        const token = crypto.randomBytes(24).toString('hex');
        const preferencePrefix = `virtualAccountPreferences.${provider}`;
        const preferenceSet = consentGrantedAt ? {
            ...(preferredBank ? { [`${preferencePrefix}.preferredBank`]: preferredBank } : {}),
            [`${preferencePrefix}.consentGrantedAt`]: consentGrantedAt,
            [`${preferencePrefix}.consentVersion`]: consentVersion,
            [`${preferencePrefix}.consentChannel`]: consentChannel
        } : {};
        const claimable = await this.User.findOneAndUpdate(
            {
                _id: userId,
                virtualAccounts: {
                    $elemMatch: {
                        provisioningKey,
                        $or: [
                            {
                                provisioningStatus: 'failed',
                                provisioningFailureDisposition: { $ne: 'definitive_rejection' }
                            },
                            ...(retryRejected ? [{
                                provisioningStatus: 'failed',
                                provisioningFailureDisposition: 'definitive_rejection'
                            }] : []),
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
                ...(internalRecovery ? {
                    $inc: { 'virtualAccounts.$.provisioningRecoveryAttemptCount': 1 }
                } : {}),
                $set: {
                    'virtualAccounts.$.provisioningStatus': 'pending',
                    'virtualAccounts.$.provisioningToken': token,
                    'virtualAccounts.$.provisioningStartedAt': now,
                    'virtualAccounts.$.provisioningExpiresAt': expiresAt,
                    'virtualAccounts.$.provisioningFailure': null,
                    'virtualAccounts.$.provisioningFailureCode': null,
                    'virtualAccounts.$.provisioningFailureDisposition': null,
                    'virtualAccounts.$.preferredBank': preferredBank || '',
                    'virtualAccounts.$.active': false,
                    'virtualAccounts.$.assigned': false,
                    ...(!internalRecovery ? {
                        'virtualAccounts.$.provisioningRecoveryAttemptCount': 0,
                        'virtualAccounts.$.provisioningLastRecoveryAt': null,
                        'virtualAccounts.$.provisioningNextRecoveryAt': null
                    } : {}),
                    ...preferenceSet,
                    ...(provider === 'paystack' ? { 'virtualAccounts.$.provisioningGatewayContext': gatewayContext } : {}),
                    ...(consentGrantedAt ? {
                        'virtualAccounts.$.consentGrantedAt': consentGrantedAt,
                        'virtualAccounts.$.consentVersion': consentVersion,
                        'virtualAccounts.$.consentChannel': consentChannel
                    } : {})
                }
            },
            { new: true, ...(session ? { session } : {}) }
        );
        if (claimable) return { claimed: true, token };

        const inserted = await this.User.findOneAndUpdate(
            { _id: userId, 'virtualAccounts.provisioningKey': { $ne: provisioningKey } },
            {
                ...(consentGrantedAt ? { $set: preferenceSet } : {}),
                $push: {
                    virtualAccounts: {
                        provider,
                        gatewayId: String(gatewayId),
                        preferredBank: preferredBank || '',
                        ...(consentGrantedAt ? { consentGrantedAt, consentVersion, consentChannel } : {}),
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
                        provisioningRecoveryAttemptCount: internalRecovery ? 1 : 0,
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

    async setPaystackDispatchState({ userId, provisioningKey, token, state, message, code, disposition, incrementAttempt = false }) {
        const now = new Date();
        const set = {
            'virtualAccounts.$.provisioningDispatchState': state,
            ...(message !== undefined ? {
                'virtualAccounts.$.provisioningFailure': message
                    ? String(message).slice(0, 500)
                    : null
            } : {}),
            ...(code !== undefined ? {
                'virtualAccounts.$.provisioningFailureCode': code ? String(code).slice(0, 100) : null
            } : {}),
            ...(disposition !== undefined ? {
                'virtualAccounts.$.provisioningFailureDisposition': disposition || null
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
                    'virtualAccounts.$.provisioningFailureCode': 'PAYSTACK_DVA_ASSIGNMENT_FAILED',
                    'virtualAccounts.$.provisioningFailureDisposition': 'retryable',
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
            provisioningFailure: null,
            provisioningFailureCode: null,
            provisioningFailureDisposition: null
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

    async failProvisioning({ userId, provisioningKey, token, message, code, disposition, requireUnexpiredAt }) {
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
                    'virtualAccounts.$.provisioningFailureCode': code ? String(code).slice(0, 100) : null,
                    'virtualAccounts.$.provisioningFailureDisposition': disposition || null,
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
    constructor({
        gatewayService = paymentGatewayService,
        repository = new MongoVirtualAccountRepository(),
        onboarding = onboardingService,
        legal = legalService,
        bankIdentityService = null
    } = {}) {
        this.gatewayService = gatewayService;
        this.repository = repository;
        this.onboardingService = onboarding;
        this.legalService = legal;
        this.bankIdentityService = bankIdentityService;
        this.recoveryRunning = false;
        this.eligibilitySweepCursor = null;
    }

    _error(message, code, httpStatus = 400) {
        const error = new Error(message);
        error.code = code;
        error.httpStatus = httpStatus;
        return error;
    }

    _persistedProviderConsent(user, provider) {
        const preference = user?.virtualAccountPreferences?.[provider];
        if (
            preference?.consentGrantedAt
            && preference?.consentVersion === VIRTUAL_ACCOUNT_CONSENT_VERSION
        ) {
            return {
                consentGrantedAt: new Date(preference.consentGrantedAt),
                consentVersion: preference.consentVersion,
                consentChannel: preference.consentChannel || 'provider_specific_api',
                ...(preference.preferredBank ? { preferredBank: preference.preferredBank } : {})
            };
        }

        const audited = (user?.virtualAccounts || [])
            .map(asPlainAccount)
            .filter(account => (
                account.provider === provider
                && account.consentGrantedAt
                && account.consentVersion === VIRTUAL_ACCOUNT_CONSENT_VERSION
            ))
            .sort((left, right) => new Date(right.consentGrantedAt) - new Date(left.consentGrantedAt))[0];
        return audited ? {
            consentGrantedAt: new Date(audited.consentGrantedAt),
            consentVersion: audited.consentVersion,
            consentChannel: audited.consentChannel || 'provider_specific_api',
            ...(audited.preferredBank ? { preferredBank: audited.preferredBank } : {})
        } : null;
    }

    _persistedPaystackPreference(user) {
        return this._persistedProviderConsent(user, 'paystack');
    }

    _isEligibilityError(error) {
        return new Set([
            'ONBOARDING_INCOMPLETE',
            'PAYSTACK_DVA_CONSENT_REQUIRED',
            'MONNIFY_VIRTUAL_ACCOUNT_CONSENT_REQUIRED',
            'VIRTUAL_ACCOUNT_CONSENT_VERSION_INVALID',
            'PAYSTACK_DVA_BANK_INVALID',
            'PAYSTACK_CUSTOMER_EMAIL_INVALID',
            'PAYSTACK_CUSTOMER_PHONE_INVALID',
            'PAYSTACK_CUSTOMER_NAME_INCOMPLETE',
            'MONNIFY_CUSTOMER_DATA_INVALID'
        ]).has(error?.code);
    }

    async _assertOnboardingEligibility(userId) {
        const config = await onboardingConfigService.getConfig();
        if (!config.enforceEnrolledUsers) return null;

        const onboarding = await this.onboardingService.getState({ userId, config });
        if (onboarding.enrolled && !onboarding.complete) {
            throw this._error(
                'Complete onboarding before provisioning a virtual account',
                'ONBOARDING_INCOMPLETE',
                403
            );
        }
        return onboarding;
    }

    async _assertLegalEligibility(userId) {
        const requirements = await this.legalService.getRequirements({ userId: String(userId) });
        if ((requirements.missingMandatoryDocuments || []).length > 0) {
            throw this._error(
                'Virtual-account provisioning is unavailable until mandatory legal documents are configured',
                'LEGAL_SERVICE_UNAVAILABLE',
                503
            );
        }
        if ((requirements.missingAcceptances || []).length > 0) {
            throw this._error(
                'Current legal acceptance is required before provisioning a virtual account',
                'LEGAL_ACCEPTANCE_REQUIRED',
                428
            );
        }
    }

    _consentRequiredCode(provider) {
        return provider === 'paystack'
            ? 'PAYSTACK_DVA_CONSENT_REQUIRED'
            : 'MONNIFY_VIRTUAL_ACCOUNT_CONSENT_REQUIRED';
    }

    _consentRequirement(provider, gateway = null) {
        const spec = getAdapterSpec(provider);
        const environment = gateway?.environment === 'live' ? 'live' : 'test';
        const providerSlugs = provider === 'paystack'
            ? spec?.virtualAccounts?.providerSlugsByEnvironment?.[environment] || []
            : [];
        return {
            required: true,
            version: VIRTUAL_ACCOUNT_CONSENT_VERSION,
            purpose: 'permanent_virtual_account',
            provider,
            ...(providerSlugs.length > 0 ? { preferredBanks: providerSlugs } : {})
        };
    }

    _legacyConsentForRecovery(account) {
        if (!account?.consentGrantedAt) return null;
        return {
            consentGrantedAt: new Date(account.consentGrantedAt),
            consentVersion: account.consentVersion || 'legacy_explicit_v0',
            consentChannel: account.consentChannel || 'legacy_recovery',
            ...(account.preferredBank ? { preferredBank: account.preferredBank } : {})
        };
    }

    async provisionEligible({
        userId,
        paystackConsent = false,
        paystackPreferredBank,
        monnifyConsent = false,
        verifyLegal = false
    } = {}) {
        try {
            await this._assertOnboardingEligibility(userId);
            if (verifyLegal) await this._assertLegalEligibility(userId);
        } catch (error) {
            if (!['ONBOARDING_INCOMPLETE', 'LEGAL_ACCEPTANCE_REQUIRED', 'LEGAL_SERVICE_UNAVAILABLE'].includes(error?.code)) {
                throw error;
            }
            const skipped = { status: 'skipped', code: error.code, message: error.message };
            return { paystack: skipped, monnify: skipped };
        }

        const user = await this.repository.getUser(userId);
        if (!user) {
            const unavailable = { status: 'failed', code: 'USER_NOT_FOUND', message: 'User not found' };
            return { paystack: unavailable, monnify: unavailable };
        }

        const storedAccounts = (user.virtualAccounts || []).map(asPlainAccount);
        const activePaystack = storedAccounts.filter(account => (
            account.provider === 'paystack' && this._isDisplayUsable(account)
        ));
        const activeMonnify = storedAccounts.filter(account => (
            account.provider === 'monnify' && this._isDisplayUsable(account)
        ));
        const hasLegacyUnverified = storedAccounts.some(account => !account.provider && !!account.accountNumber);
        const persistedPaystack = this._persistedProviderConsent(user, 'paystack');
        const persistedMonnify = this._persistedProviderConsent(user, 'monnify');
        const paystackRequest = paystackConsent === true
            ? {
                consent: true,
                preferredBank: paystackPreferredBank,
                consentVersion: VIRTUAL_ACCOUNT_CONSENT_VERSION,
                consentChannel: 'provider_specific_api'
            }
            : persistedPaystack
                ? { consent: true, ...persistedPaystack }
                : null;
        const monnifyRequest = monnifyConsent === true
            ? {
                consent: true,
                consentVersion: VIRTUAL_ACCOUNT_CONSENT_VERSION,
                consentChannel: 'provider_specific_api'
            }
            : persistedMonnify
                ? { consent: true, ...persistedMonnify }
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

        const paystack = activePaystack.length > 0
            ? Promise.resolve({ status: 'active', accounts: this._sanitizePaystackAccounts(activePaystack), existing: true })
            : paystackRequest
            ? evaluate('paystack', paystackRequest)
            : Promise.resolve({
                status: 'skipped',
                code: 'PAYSTACK_DVA_CONSENT_REQUIRED',
                message: 'Express consent is required for Paystack DVA provisioning'
            });
        const monnify = activeMonnify.length > 0
            ? Promise.resolve({ status: 'active', accounts: activeMonnify, existing: true })
            : hasLegacyUnverified
                ? Promise.resolve({
                    status: 'skipped',
                    code: 'LEGACY_VIRTUAL_ACCOUNT_REVIEW_REQUIRED',
                    message: 'A historical bank account requires manual ownership review'
                })
                : monnifyRequest
            ? evaluate('monnify', monnifyRequest)
            : Promise.resolve({
                status: 'skipped',
                code: 'MONNIFY_VIRTUAL_ACCOUNT_CONSENT_REQUIRED',
                message: 'Express consent is required for Monnify reserved-account provisioning'
            });

        const [paystackResult, monnifyResult] = await Promise.all([paystack, monnify]);
        return { paystack: paystackResult, monnify: monnifyResult };
    }

    scheduleEligibleProvisioning({ userId, before, after, source = 'onboarding_transition' } = {}) {
        if (!userId || !after?.complete || before?.complete === true) return false;
        console.info('[VirtualAccount] Provisioning eligibility evaluation scheduled', { source });
        queueMicrotask(() => {
            void this.provisionEligible({ userId, verifyLegal: true })
                .then(outcomes => {
                    for (const [provider, outcome] of Object.entries(outcomes || {})) {
                        if (outcome.status === 'active') {
                            console.info('[VirtualAccount] Existing account reused or provisioning completed', { provider });
                        } else if (outcome.status === 'pending') {
                            console.info('[VirtualAccount] Provider assignment pending', { provider });
                        }
                    }
                })
                .catch(error => {
                    console.error('[VirtualAccount] Scheduled eligibility evaluation failed', {
                        code: error?.code || 'VIRTUAL_ACCOUNT_PROVISIONING_FAILED'
                    });
                });
        });
        return true;
    }

    _accountOperationalState(account) {
        if (this._isDisplayUsable(account)) return { status: 'active' };
        if (account?.provisioningFailureDisposition === 'definitive_rejection') {
            return {
                status: 'definitive_rejection',
                code: account.provisioningFailureCode || 'VIRTUAL_ACCOUNT_PROVIDER_REJECTED'
            };
        }
        if (
            account?.provisioningFailureDisposition === 'ambiguous_mutation'
            || account?.provisioningDispatchState === 'reconciling'
        ) {
            return { status: 'reconciliation_required', code: account.provisioningFailureCode || 'VIRTUAL_ACCOUNT_RECONCILIATION_REQUIRED' };
        }
        if (account?.provisioningStatus === 'pending') return { status: 'awaiting_assignment' };
        if (account?.provisioningStatus === 'failed') {
            return { status: 'transient_failure', code: account.provisioningFailureCode || 'VIRTUAL_ACCOUNT_PROVIDER_UNAVAILABLE' };
        }
        return null;
    }

    _isDisplayUsable(account) {
        return VIRTUAL_ACCOUNT_PROVIDERS.includes(String(account?.provider || '').toLowerCase())
            && !!account?.gatewayId
            && !!account?.accountReference
            && !!String(account?.bankName || '').trim()
            && !!String(account?.accountName || '').trim()
            && !!account?.accountNumber
            && account?.currency === 'NGN'
            && account?.active === true
            && account?.assigned === true
            && account?.provisioningStatus === 'active';
    }

    async getAccountStatus({ userId } = {}) {
        const user = await this.repository.getUser(userId);
        if (!user) throw this._error('User not found', 'USER_NOT_FOUND', 404);
        const accounts = (user.virtualAccounts || []).map(asPlainAccount);
        const legacy = typeof this.repository.listLegacyUnverified === 'function'
            ? await this.repository.listLegacyUnverified(userId)
            : accounts.filter(account => !account.provider && !!account.accountNumber);
        const providers = {};

        for (const provider of VIRTUAL_ACCOUNT_PROVIDERS) {
            const providerAccounts = accounts.filter(account => account.provider === provider);
            const usable = providerAccounts.filter(account => this._isDisplayUsable(account));
            const operation = providerAccounts
                .filter(account => account.provisioningKey)
                .sort((left, right) => new Date(right.provisioningStartedAt || 0) - new Date(left.provisioningStartedAt || 0))[0];
            if (usable.length > 0) {
                providers[provider] = { status: 'active', existing: true };
                continue;
            }
            if (provider === 'monnify' && legacy.length > 0) {
                providers[provider] = {
                    status: 'legacy_review_required',
                    code: 'LEGACY_VIRTUAL_ACCOUNT_REVIEW_REQUIRED'
                };
                continue;
            }
            const operational = this._accountOperationalState(operation);
            if (operational) {
                providers[provider] = operational;
                continue;
            }
            const gateway = typeof this.repository.getGatewayEnvironment === 'function'
                ? { environment: await this.repository.getGatewayEnvironment(provider) }
                : null;
            providers[provider] = this._persistedProviderConsent(user, provider)
                ? { status: 'eligible', consent: this._consentRequirement(provider, gateway) }
                : {
                    status: 'consent_required',
                    code: this._consentRequiredCode(provider),
                    consent: this._consentRequirement(provider, gateway)
                };
        }

        return {
            accounts: accounts.filter(account => this._isDisplayUsable(account)),
            providers,
            legacyReviewRequired: legacy.length > 0
        };
    }

    async requestBankAccounts({ userId, providers: requestedProviders, consents = {}, retryRejectedProviders = [] } = {}) {
        await this._assertOnboardingEligibility(userId);
        await this._assertLegalEligibility(userId);
        const user = await this.repository.getUser(userId);
        if (!user) throw this._error('User not found', 'USER_NOT_FOUND', 404);
        const initial = await this.getAccountStatus({ userId });
        const providerOutcomes = {};
        const providersToRequest = requestedProviders === undefined
            ? VIRTUAL_ACCOUNT_PROVIDERS
            : VIRTUAL_ACCOUNT_PROVIDERS.filter(provider => requestedProviders.includes(provider));

        for (const provider of providersToRequest) {
            if (initial.providers[provider]?.status === 'active') {
                providerOutcomes[provider] = initial.providers[provider];
                continue;
            }
            if (initial.providers[provider]?.status === 'legacy_review_required') {
                providerOutcomes[provider] = initial.providers[provider];
                continue;
            }

            const submitted = consents?.[provider];
            const persisted = this._persistedProviderConsent(user, provider);
            const consentRequirement = initial.providers[provider]?.consent || this._consentRequirement(provider);
            let consentEvidence = persisted;
            if (submitted?.granted === true) {
                if (submitted.version !== VIRTUAL_ACCOUNT_CONSENT_VERSION) {
                    providerOutcomes[provider] = {
                        status: 'consent_required',
                        code: 'VIRTUAL_ACCOUNT_CONSENT_VERSION_INVALID',
                        consent: consentRequirement
                    };
                    continue;
                }
                consentEvidence = {
                    consentGrantedAt: new Date(),
                    consentVersion: VIRTUAL_ACCOUNT_CONSENT_VERSION,
                    consentChannel: 'request_bank_account',
                    ...(submitted.preferredBank ? { preferredBank: submitted.preferredBank } : {})
                };
            }
            if (!consentEvidence) {
                providerOutcomes[provider] = {
                    status: 'consent_required',
                    code: this._consentRequiredCode(provider),
                    consent: consentRequirement
                };
                continue;
            }

            try {
                const result = await this.provision({
                    userId,
                    providerCode: provider,
                    consent: true,
                    consentGrantedAt: consentEvidence.consentGrantedAt,
                    consentVersion: consentEvidence.consentVersion,
                    consentChannel: consentEvidence.consentChannel,
                    preferredBank: submitted?.preferredBank || consentEvidence.preferredBank,
                    retryRejected: retryRejectedProviders.includes(provider)
                });
                providerOutcomes[provider] = {
                    status: result.state || (result.status === 'active' ? 'active' : 'awaiting_assignment'),
                    ...(result.code ? { code: result.code } : {}),
                    existing: result.existing === true
                };
            } catch (error) {
                const disposition = error?.paystackDvaDisposition || error?.provisioningDisposition;
                providerOutcomes[provider] = {
                    status: disposition === 'definitive_rejection'
                        ? 'definitive_rejection'
                        : disposition === 'ambiguous_mutation'
                            ? 'reconciliation_required'
                            : this._isEligibilityError(error) || ['VIRTUAL_ACCOUNT_GATEWAY_INACTIVE', 'LEGAL_ACCEPTANCE_REQUIRED'].includes(error?.code)
                                ? 'ineligible'
                                : 'transient_failure',
                    code: error?.code || 'VIRTUAL_ACCOUNT_PROVISIONING_FAILED'
                };
            }
        }

        const current = await this.getAccountStatus({ userId });
        const providers = { ...current.providers, ...providerOutcomes };
        const states = Object.values(providerOutcomes).map(value => value.status);
        const status = states.every(value => value === 'active')
            ? 'active'
            : states.some(value => value === 'active')
                ? 'partial'
                : states.some(value => ['awaiting_assignment', 'reconciliation_required'].includes(value))
                    ? 'pending'
                    : states.some(value => value === 'transient_failure')
                        ? 'failed'
                        : 'action_required';
        return { status, accounts: current.accounts, providers };
    }

    async _recoverMissedEligibility({ limit = ELIGIBILITY_SWEEP_BATCH_SIZE } = {}) {
        const summary = { scanned: 0, eligible: 0, active: 0, pending: 0, failed: 0 };
        if (typeof this.repository.listEligibilitySweepPage !== 'function') return summary;

        const users = await this.repository.listEligibilitySweepPage({
            afterId: this.eligibilitySweepCursor,
            limit
        });
        if (users.length === 0) {
            this.eligibilitySweepCursor = null;
            return summary;
        }
        this.eligibilitySweepCursor = users[users.length - 1]._id;

        for (const user of users) {
            summary.scanned += 1;
            if (user?.status !== true || user?.isPinSet !== true) continue;

            const accounts = (user.virtualAccounts || []).map(asPlainAccount);
            const legacyMonnify = accounts.some(account => !account.provider && !!account.accountNumber);
            const providers = VIRTUAL_ACCOUNT_PROVIDERS.filter(provider => (
                this._persistedProviderConsent(user, provider)
                && !accounts.some(account => String(account.provider || '').toLowerCase() === provider)
                && !(provider === 'monnify' && legacyMonnify)
            ));
            if (providers.length === 0) continue;

            let onboarding;
            try {
                onboarding = await this.onboardingService.getState({ userId: user._id });
            } catch (error) {
                summary.failed += providers.length;
                console.warn('[VirtualAccount] Eligibility recovery could not verify onboarding', {
                    code: error?.code || 'ONBOARDING_STATE_UNAVAILABLE'
                });
                continue;
            }
            if (onboarding?.complete !== true) continue;

            for (const provider of providers) {
                const consent = this._persistedProviderConsent(user, provider);
                summary.eligible += 1;
                try {
                    const result = await this.provision({
                        userId: user._id,
                        providerCode: provider,
                        consent: true,
                        consentGrantedAt: consent.consentGrantedAt,
                        consentVersion: consent.consentVersion,
                        consentChannel: consent.consentChannel,
                        preferredBank: consent.preferredBank,
                        verifyLegal: true,
                        internalRecovery: true
                    });
                    if (result.status === 'active') summary.active += 1;
                    else summary.pending += 1;
                } catch (error) {
                    summary.failed += 1;
                    console.warn('[VirtualAccount] Eligibility recovery attempt failed', {
                        provider,
                        code: error?.code || 'VIRTUAL_ACCOUNT_PROVISIONING_FAILED'
                    });
                }
            }
        }
        return summary;
    }

    async recoverProvisioning({ now = new Date(), limit = RECOVERY_BATCH_SIZE } = {}) {
        if (this.recoveryRunning) return { skipped: true, reason: 'already_running', scanned: 0, claimed: 0 };
        this.recoveryRunning = true;
        const summary = {
            skipped: false,
            scanned: 0,
            claimed: 0,
            active: 0,
            pending: 0,
            failed: 0,
            eligibilityScanned: 0,
            eligibilityEligible: 0
        };
        try {
            const eligibility = await this._recoverMissedEligibility({ limit });
            summary.eligibilityScanned = eligibility.scanned;
            summary.eligibilityEligible = eligibility.eligible;
            summary.active += eligibility.active;
            summary.pending += eligibility.pending;
            summary.failed += eligibility.failed;

            const candidates = await this.repository.listRecoveryCandidates({ now, limit });
            summary.scanned = candidates.length;
            for (const candidate of candidates) {
                const attempts = Number(candidate.account.provisioningRecoveryAttemptCount || 0) + 1;
                const claimed = await this.repository.claimRecoveryAttempt({
                    userId: candidate.userId,
                    provisioningKey: candidate.account.provisioningKey,
                    now,
                    attempt: attempts
                });
                if (!claimed) continue;
                summary.claimed += 1;
                const consentEvidence = this._legacyConsentForRecovery(candidate.account);
                if (!consentEvidence) {
                    summary.failed += 1;
                    console.warn('[VirtualAccount] Recovery skipped because provider consent evidence is unavailable', {
                        provider: candidate.account.provider
                    });
                    continue;
                }
                try {
                    const result = await this.provision({
                        userId: candidate.userId,
                        providerCode: candidate.account.provider,
                        consent: true,
                        consentGrantedAt: consentEvidence.consentGrantedAt,
                        consentVersion: consentEvidence.consentVersion,
                        consentChannel: consentEvidence.consentChannel,
                        preferredBank: consentEvidence.preferredBank,
                        verifyLegal: true,
                        internalRecovery: true
                    });
                    if (result.status === 'active') summary.active += 1;
                    else summary.pending += 1;
                    console.info('[VirtualAccount] Recovery worker processed provisioning state', {
                        provider: candidate.account.provider,
                        status: result.state || result.status,
                        attempt: attempts
                    });
                } catch (error) {
                    summary.failed += 1;
                    console.warn('[VirtualAccount] Recovery worker attempt failed', {
                        provider: candidate.account.provider,
                        code: error?.code || 'VIRTUAL_ACCOUNT_PROVISIONING_FAILED',
                        attempt: attempts
                    });
                }
            }
            return summary;
        } finally {
            this.recoveryRunning = false;
        }
    }

    _isActive(account) {
        return this._isDisplayUsable(account);
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
        if (error?.paystackDvaDisposition) {
            return error.paystackDvaDisposition === 'ambiguous_mutation';
        }
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
        const accounts = await this.repository.listScope(userId, 'paystack', gatewayId);
        const operation = accounts.find(account => account.provisioningKey === `paystack:${gatewayId}`);
        return {
            status: 'pending',
            state: operation?.provisioningFailureDisposition === 'ambiguous_mutation'
                || operation?.provisioningDispatchState === 'reconciling'
                ? 'reconciliation_required'
                : 'awaiting_assignment',
            accounts,
            existing
        };
    }

    async _assertPaystackProviderCapability(adapter, gateway, preferredBank) {
        if (typeof adapter.listDedicatedAccountProviders !== 'function') return;
        try {
            const supported = await adapter.listDedicatedAccountProviders();
            const environmentAllowed = new Set(this._paystackProviderSlugs(gateway, getAdapterSpec('paystack')));
            const merchantAllowed = new Set(
                (supported || [])
                    .map(value => value?.providerSlug)
                    .filter(value => environmentAllowed.has(value))
            );
            if (!merchantAllowed.has(preferredBank)) {
                throw this._error(
                    'The selected Paystack bank is not currently available for this merchant',
                    'PAYSTACK_DVA_BANK_UNAVAILABLE',
                    422
                );
            }
        } catch (error) {
            if (error?.code === 'PAYSTACK_DVA_BANK_UNAVAILABLE') throw error;
            console.warn('[VirtualAccount] Provider capability discovery unavailable', {
                provider: 'paystack',
                code: error?.code || 'PAYSTACK_DVA_CAPABILITY_UNAVAILABLE'
            });
        }
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

    async _completePaystackProvisioning({ user, gateway, provisioningKey, token, account, customer, preferredBank, consentEvidence }) {
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
                consentGrantedAt: consentEvidence?.consentGrantedAt,
                consentVersion: consentEvidence?.consentVersion,
                consentChannel: consentEvidence?.consentChannel,
                active: true,
                assigned: true
            }],
            snapshotKey: accountReference,
            snapshot: this.gatewayService._snapshotGatewayConfig(gateway)
        });
        return { status: 'active', accounts, existing: false };
    }

    async _provisionPaystack({ user, gateway, adapter, preferredBank, provisioningKey, token, existingAccount, previousOperation, consentEvidence }) {
        this._validatePaystackPreferredBank(gateway, preferredBank);
        await this._assertPaystackProviderCapability(adapter, gateway, preferredBank);
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
                    const definitive = error?.paystackDvaDisposition === 'definitive_rejection';
                    await this._setPaystackDispatchState({
                        userId: user._id,
                        provisioningKey,
                        token,
                        state: definitive ? 'rejected' : 'retryable',
                        message: error.message,
                        code: error.code,
                        disposition: error.paystackDvaDisposition
                    });
                    throw error;
                }
                await this._setPaystackDispatchState({
                    userId: user._id,
                    provisioningKey,
                    token,
                    state: 'reconciling',
                    message: error.message,
                    code: error.code,
                    disposition: error.paystackDvaDisposition
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
                    message: error.message,
                    code: error.code,
                    disposition: error.paystackDvaDisposition
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
                    preferredBank,
                    consentEvidence
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

        const confirmedSafeToRetry = ['retryable', 'rejected'].includes(dispatchState);
        const providerMutationMayHaveOccurred = !confirmedSafeToRetry && (previousAttemptCount > 0
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
                const definitive = error?.paystackDvaDisposition === 'definitive_rejection';
                await this._setPaystackDispatchState({
                    userId: user._id,
                    provisioningKey,
                    token,
                    state: definitive ? 'rejected' : 'retryable',
                    message: error.message,
                    code: error.code,
                    disposition: error.paystackDvaDisposition
                });
                throw error;
            }
            await this._setPaystackDispatchState({
                userId: user._id,
                provisioningKey,
                token,
                state: 'awaiting_assignment',
                message: error.message,
                code: error.code,
                disposition: error.paystackDvaDisposition
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
            preferredBank,
            consentEvidence
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
                consentGrantedAt: pending.consentGrantedAt,
                consentVersion: pending.consentVersion,
                consentChannel: pending.consentChannel,
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

    async resolveMonnifyDepositOwner({ gateway, accountReference, accountNumber }) {
        const gatewayId = String(gateway?._id || gateway?.gatewayId || '');
        const adapterType = String(gateway?.adapterType || gateway?.code || '').toLowerCase();
        const gatewayCode = String(gateway?.code || '').toLowerCase();
        if (!gatewayId || adapterType !== 'monnify') {
            throw this._terminalWebhookError('Monnify reserved-account deposit gateway is invalid', 'MONNIFY_VIRTUAL_ACCOUNT_GATEWAY_INVALID');
        }
        if (!/^VIRTUAL_[a-f\d]{24}$/i.test(String(accountReference || '')) || !/^\d{10}$/.test(String(accountNumber || ''))) {
            throw this._terminalWebhookError('Monnify reserved-account ownership evidence is incomplete', 'MONNIFY_VIRTUAL_ACCOUNT_DEPOSIT_MALFORMED');
        }
        const lookup = await this.repository.findActiveMonnifyDepositOwner({
            gatewayId,
            accountReference,
            accountNumber,
            allowUnscopedCanonical: gatewayCode === 'monnify'
        });
        if (lookup.matchCount !== 1 || !lookup.match) {
            throw this._terminalWebhookError(
                lookup.matchCount > 1
                    ? 'Monnify reserved-account deposit ownership is ambiguous'
                    : 'Monnify reserved-account deposit does not match an active persisted account',
                lookup.matchCount > 1
                    ? 'MONNIFY_VIRTUAL_ACCOUNT_DEPOSIT_AMBIGUOUS'
                    : 'MONNIFY_VIRTUAL_ACCOUNT_DEPOSIT_UNMATCHED'
            );
        }
        return lookup.match;
    }

    _validMonnifyResult(result, accountReference, { gateway, user } = {}) {
        const accounts = Array.isArray(result?.accounts) ? result.accounts : [];
        const accountKeys = accounts.map(account => (
            `${String(account?.bankCode || '').trim()}:${String(account?.accountNumber || '').trim()}`
        ));
        const basicEvidenceValid = !!result?.status
            && result.accountReference === accountReference
            && accounts.length > 0
            && new Set(accountKeys).size === accountKeys.length
            && accounts.every(account => (
                /^\d{10}$/.test(String(account?.accountNumber || ''))
                && !!String(account?.bankName || '').trim()
                && !!String(account?.bankCode || '').trim()
            ));
        if (!basicEvidenceValid || result.apiVersion !== 'v2') return basicEvidenceValid;

        const expectedContractCode = String(gateway?.metadata?.contractCode || '').trim();
        const expectedEmail = String(user?.email || '').trim().toLowerCase();
        return !!expectedContractCode
            && !!expectedEmail
            && result.contractCode === expectedContractCode
            && result.currencyCode === 'NGN'
            && result.reservedAccountType === 'GENERAL'
            && result.providerStatus === 'ACTIVE'
            && String(result.customerEmail || '').trim().toLowerCase() === expectedEmail
            && !!String(result.reservationReference || '').trim()
            && accounts.every(account => !!String(account?.accountName || '').trim());
    }

    _isMonnifyNotFound(error) {
        return Number(error?.providerHttpStatus ?? error?.response?.status) === 404
            || error?.code === 'MONNIFY_RESERVED_ACCOUNT_NOT_FOUND';
    }

    _isMonnifyDefinitiveRejection(error) {
        const status = Number(error?.providerHttpStatus ?? error?.response?.status);
        return Number.isInteger(status)
            && status >= 400
            && status < 500
            && ![408, 409, 425, 429].includes(status);
    }

    _isMonnifyDuplicateReference(error) {
        const evidence = `${error?.providerResponseCode || ''} ${error?.message || ''}`.toLowerCase();
        return evidence.includes('reference')
            && (evidence.includes('already') || evidence.includes('exist') || evidence.includes('used'));
    }

    async _verifiedMonnifyIdentity(userId, adapter) {
        if (adapter?.requiresVerifiedBankIdentity !== true) return null;
        if (typeof this.bankIdentityService?.getVerifiedMonnifyIdentity !== 'function') {
            throw this._error(
                'Verified bank identity processing is not configured',
                'MONNIFY_IDENTITY_VERIFICATION_UNAVAILABLE',
                503
            );
        }
        const identity = await this.bankIdentityService.getVerifiedMonnifyIdentity(String(userId));
        if (
            identity?.verified !== true
            || (!/^\d{11}$/.test(String(identity?.bvn || '')) && !/^\d{11}$/.test(String(identity?.nin || '')))
        ) {
            throw this._error(
                'Verified BVN or NIN is required for Monnify virtual-account provisioning',
                'MONNIFY_IDENTITY_VERIFICATION_REQUIRED',
                403
            );
        }
        return identity;
    }

    async _markMonnifyReconciliation({ userId, provisioningKey, token, error }) {
        const updated = await this.repository.setPaystackDispatchState({
            userId,
            provisioningKey,
            token,
            state: 'reconciling',
            message: 'Monnify reserved-account assignment requires reconciliation',
            code: error?.code || 'MONNIFY_VIRTUAL_ACCOUNT_MUTATION_AMBIGUOUS',
            disposition: 'ambiguous_mutation'
        });
        if (!updated) throw this._claimLostError();
        return {
            status: 'pending',
            state: 'reconciliation_required',
            accounts: await this.repository.listScope(userId, 'monnify', provisioningKey.split(':').slice(1).join(':')),
            existing: true
        };
    }

    async _provisionMonnify({ user, gateway, adapter, provisioningKey, token, consentEvidence, existingOperation, verifiedIdentity }) {
        adapter.assertVirtualAccountCustomer(user);
        const accountReference = `VIRTUAL_${user._id}`;
        let result = null;
        let mayCreate = typeof adapter.getReservedAccount !== 'function';
        let creationDispatched = false;
        if (typeof adapter.getReservedAccount === 'function') {
            try {
                result = await adapter.getReservedAccount(accountReference);
            } catch (error) {
                if (!this._isMonnifyNotFound(error)) {
                    return this._markMonnifyReconciliation({
                        userId: user._id,
                        provisioningKey,
                        token,
                        error
                    });
                }
                if (['dispatching', 'reconciling'].includes(existingOperation?.provisioningDispatchState)) {
                    return this._markMonnifyReconciliation({
                        userId: user._id,
                        provisioningKey,
                        token,
                        error
                    });
                }
                mayCreate = true;
            }
        }

        if (result && !this._validMonnifyResult(result, accountReference, { gateway, user })) {
            throw this._error('Monnify returned incomplete reserved-account evidence', 'MONNIFY_VIRTUAL_ACCOUNT_RESPONSE_INVALID', 502);
        }
        if (!result && mayCreate) {
            const dispatchUpdated = await this.repository.setPaystackDispatchState({
                userId: user._id,
                provisioningKey,
                token,
                state: 'dispatching',
                message: null,
                code: null,
                disposition: null,
                incrementAttempt: true
            });
            if (!dispatchUpdated) throw this._claimLostError();
            try {
                creationDispatched = true;
                result = await adapter.createReservedAccount({ user, accountReference, verifiedIdentity });
            } catch (error) {
                if (error?.requestDispatched === false) {
                    throw error;
                }
                try {
                    if (typeof adapter.getReservedAccount !== 'function') throw error;
                    result = await adapter.getReservedAccount(accountReference);
                } catch (lookupError) {
                    if (this._isMonnifyNotFound(lookupError) && this._isMonnifyDefinitiveRejection(error)) {
                        if (this._isMonnifyDuplicateReference(error)) {
                            return this._markMonnifyReconciliation({
                                userId: user._id,
                                provisioningKey,
                                token,
                                error
                            });
                        }
                        error.code = error.code || 'MONNIFY_VIRTUAL_ACCOUNT_PROVIDER_REJECTED';
                        error.provisioningDisposition = 'definitive_rejection';
                        throw error;
                    }
                    return this._markMonnifyReconciliation({
                        userId: user._id,
                        provisioningKey,
                        token,
                        error: lookupError
                    });
                }
            }
        }
        if (!this._validMonnifyResult(result, accountReference, { gateway, user })) {
            if (creationDispatched) {
                return this._markMonnifyReconciliation({
                    userId: user._id,
                    provisioningKey,
                    token,
                    error: this._error(
                        'Monnify returned incomplete reserved-account evidence after creation',
                        'MONNIFY_VIRTUAL_ACCOUNT_RESPONSE_AMBIGUOUS',
                        502
                    )
                });
            }
            throw this._error('Monnify returned incomplete reserved-account evidence', 'MONNIFY_VIRTUAL_ACCOUNT_RESPONSE_INVALID', 502);
        }
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
                consentGrantedAt: consentEvidence?.consentGrantedAt,
                consentVersion: consentEvidence?.consentVersion,
                consentChannel: consentEvidence?.consentChannel,
                provisioningDispatchState: 'complete',
                active: true,
                assigned: true
            })),
            snapshotKey: accountReference,
            snapshot: this.gatewayService._snapshotGatewayConfig(gateway)
        });
        return { status: 'active', accounts, existing: false };
    }

    async provision({
        userId,
        providerCode,
        preferredBank,
        consent,
        consentGrantedAt,
        consentVersion,
        consentChannel,
        retryRejected = false,
        verifyLegal = false,
        internalRecovery = false
    }) {
        const normalizedCode = String(providerCode || '').trim().toLowerCase();
        if (!userId || !normalizedCode) {
            throw this._error('User and virtual-account provider are required', 'VIRTUAL_ACCOUNT_REQUEST_INVALID');
        }
        await this._assertOnboardingEligibility(userId);
        if (verifyLegal) await this._assertLegalEligibility(userId);
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
        const gatewayId = String(gateway._id);
        const provisioningKey = `${provider}:${gatewayId}`;
        const gatewayContext = provider === 'paystack' ? this._paystackGatewayContext(gateway) : null;
        const gatewayMutationVersion = gatewayId.startsWith('legacy-env-')
            ? undefined
            : Number(gateway.virtualAccountMutationVersion || 0);
        const current = await this.repository.listScope(userId, provider, gatewayId);
        if (provider === 'monnify' && typeof this.repository.listLegacyUnverified === 'function') {
            const legacy = await this.repository.listLegacyUnverified(userId);
            if (legacy.length > 0 && current.length === 0) {
                throw this._error(
                    'A historical bank account requires manual ownership review before Monnify provisioning can continue',
                    'LEGACY_VIRTUAL_ACCOUNT_REVIEW_REQUIRED',
                    409
                );
            }
        }
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
        if (consent !== true) {
            throw this._error(
                `Express consent is required for ${provider} permanent-account provisioning`,
                this._consentRequiredCode(provider)
            );
        }
        const effectiveConsentVersion = consentVersion || VIRTUAL_ACCOUNT_CONSENT_VERSION;
        if (!internalRecovery && effectiveConsentVersion !== VIRTUAL_ACCOUNT_CONSENT_VERSION) {
            throw this._error(
                'The virtual-account consent version is not current',
                'VIRTUAL_ACCOUNT_CONSENT_VERSION_INVALID',
                409
            );
        }
        const effectiveConsentChannel = consentChannel || 'provider_specific_api';
        if (!['provider_specific_api', 'request_bank_account', 'legacy_recovery'].includes(effectiveConsentChannel)) {
            throw this._error('The virtual-account consent channel is invalid', 'VIRTUAL_ACCOUNT_CONSENT_INVALID');
        }
        if (provider === 'paystack') this._validatePaystackPreferredBank(gateway, preferredBank);
        const adapter = this.gatewayService.getAdapterInstance(gateway);
        const existingOperation = current.find(account => account.provisioningKey === provisioningKey) || null;
        const retryingDefinitiveRejection = retryRejected === true
            && existingOperation?.provisioningStatus === 'failed'
            && existingOperation?.provisioningFailureDisposition === 'definitive_rejection';
        if (provider === 'paystack' && existingOperation) {
            if (existingOperation.provisioningGatewayContext
                && existingOperation.provisioningGatewayContext !== gatewayContext
                && !retryingDefinitiveRejection) {
                throw this._error(
                    'Paystack gateway credentials changed during DVA provisioning; the original operation requires reconciliation',
                    'PAYSTACK_DVA_GATEWAY_CONTEXT_MISMATCH',
                    409
                );
            }
            if (existingOperation.preferredBank
                && existingOperation.preferredBank !== preferredBank
                && !retryingDefinitiveRejection) {
                throw this._error(
                    'Paystack DVA recovery must use the original preferred bank',
                    'PAYSTACK_DVA_RECOVERY_BANK_MISMATCH',
                    409
                );
            }
        }
        let effectiveConsentGrantedAt = null;
        effectiveConsentGrantedAt = consentGrantedAt ? new Date(consentGrantedAt) : new Date();
        if (Number.isNaN(effectiveConsentGrantedAt.getTime()) || effectiveConsentGrantedAt > new Date()) {
            throw this._error('Virtual-account consent timestamp is invalid', this._consentRequiredCode(provider));
        }
        const consentEvidence = {
            consentGrantedAt: effectiveConsentGrantedAt,
            consentVersion: effectiveConsentVersion,
            consentChannel: effectiveConsentChannel,
            ...(preferredBank ? { preferredBank } : {})
        };
        let verifiedMonnifyIdentity = null;
        try {
            if (provider === 'paystack') {
                adapter.getVirtualAccountCustomer(user);
            } else if (provider === 'monnify') {
                adapter.assertVirtualAccountCustomer(user);
                verifiedMonnifyIdentity = await this._verifiedMonnifyIdentity(userId, adapter);
            }
        } catch (error) {
            if (!consentGrantedAt && this._isEligibilityError(error)) {
                const savePreference = typeof this.repository.saveProviderPreference === 'function'
                    ? this.repository.saveProviderPreference.bind(this.repository)
                    : provider === 'paystack' && typeof this.repository.savePaystackPreference === 'function'
                        ? this.repository.savePaystackPreference.bind(this.repository)
                        : null;
                if (savePreference) {
                    await savePreference({
                        userId,
                        provider,
                        preferredBank,
                        consentGrantedAt: effectiveConsentGrantedAt,
                        consentVersion: effectiveConsentVersion,
                        consentChannel: effectiveConsentChannel,
                        provisioningKey
                    });
                }
            }
            throw error;
        }

        const claim = await this.repository.claimProvisioning({
            userId,
            provider,
            gatewayId,
            provisioningKey,
            preferredBank,
            consentGrantedAt: effectiveConsentGrantedAt,
            consentVersion: effectiveConsentVersion,
            consentChannel: effectiveConsentChannel,
            gatewayContext,
            retryRejected: retryingDefinitiveRejection,
            gatewayMutationVersion,
            recoverIncompleteExpectedCount: monnifyRecoveryInFlight ? 0 : incompleteMonnifyExpectedCount,
            internalRecovery
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
            if (
                winningOperation?.provisioningStatus === 'failed'
                && winningOperation?.provisioningFailureDisposition === 'definitive_rejection'
            ) {
                return {
                    status: 'failed',
                    state: 'definitive_rejection',
                    code: winningOperation.provisioningFailureCode || 'VIRTUAL_ACCOUNT_PROVIDER_REJECTED',
                    message: winningOperation.provisioningFailure || `${provider} rejected the virtual-account provisioning request.`,
                    accounts: provider === 'paystack' ? this._sanitizePaystackAccounts(accounts) : accounts,
                    existing: true
                };
            }
            const operational = this._accountOperationalState(winningOperation);
            return {
                status: 'pending',
                state: operational?.status === 'reconciliation_required'
                    ? 'reconciliation_required'
                    : 'awaiting_assignment',
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
                    previousOperation: existingOperation,
                    consentEvidence
                });
                return { ...result, accounts: this._sanitizePaystackAccounts(result.accounts) };
            }
            if (provider === 'monnify') {
                return await this._provisionMonnify({
                    user,
                    gateway,
                    adapter,
                    provisioningKey,
                    token: claim.token,
                    consentEvidence,
                    existingOperation,
                    verifiedIdentity: verifiedMonnifyIdentity
                });
            }
            throw this._error(`${provider} virtual-account provisioning is not implemented`, 'VIRTUAL_ACCOUNT_PROVIDER_UNSUPPORTED');
        } catch (error) {
            await this.repository.failProvisioning({
                userId,
                provisioningKey,
                token: claim.token,
                message: error.message,
                code: error.code,
                disposition: error.paystackDvaDisposition || error.provisioningDisposition
            });
            throw error;
        }
    }
}

module.exports = new VirtualAccountService();
module.exports.VirtualAccountService = VirtualAccountService;
module.exports.MongoVirtualAccountRepository = MongoVirtualAccountRepository;
module.exports.VIRTUAL_ACCOUNT_CONSENT_VERSION = VIRTUAL_ACCOUNT_CONSENT_VERSION;
module.exports.RECOVERY_MAX_ATTEMPTS = RECOVERY_MAX_ATTEMPTS;
