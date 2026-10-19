'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ONBOARDING_ENFORCEMENT_MODE = 'off';

const {
    VirtualAccountService,
    MongoVirtualAccountRepository,
    VIRTUAL_ACCOUNT_CONSENT_VERSION,
    RECOVERY_MAX_ATTEMPTS
} = require('../services/virtualAccount.service');
const virtualAccountService = require('../services/virtualAccount.service');
const paymentGatewayService = require('../services/paymentGateway.service');
const TransactionStatus = require('../models/TransactionStatus');

const activeAccount = (provider, overrides = {}) => ({
    provider,
    gatewayId: `gateway-${provider}`,
    accountReference: provider === 'paystack'
        ? 'PAYSTACK_DVA_991'
        : 'VIRTUAL_507f1f77bcf86cd799439011',
    accountNumber: provider === 'paystack' ? '0123456789' : '9988776655',
    accountName: 'Ada Lovelace',
    bankName: provider === 'paystack' ? 'Wema Bank' : 'Moniepoint',
    currency: 'NGN',
    active: true,
    assigned: true,
    provisioningStatus: 'active',
    ...overrides
});

const eligibleLegalService = {
    async getRequirements() {
        return { missingMandatoryDocuments: [], missingAcceptances: [] };
    }
};

test('post-onboarding scheduling is transition-only and does not await providers', async () => {
    const service = new VirtualAccountService();
    const calls = [];
    let release;
    const providerWait = new Promise(resolve => { release = resolve; });
    service.provisionEligible = async request => {
        calls.push(request);
        await providerWait;
        return { paystack: { status: 'active' }, monnify: { status: 'active' } };
    };

    assert.equal(service.scheduleEligibleProvisioning({
        userId: 'user-1',
        before: { complete: false },
        after: { complete: true },
        source: 'test'
    }), true);
    assert.equal(service.scheduleEligibleProvisioning({
        userId: 'user-1',
        before: { complete: true },
        after: { complete: true }
    }), false);

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [{ userId: 'user-1', verifyLegal: true }]);
    release();
    await new Promise(resolve => setImmediate(resolve));
});

test('account status is database-only, hides incomplete rows, and quarantines provider-less legacy data', async () => {
    let gatewayCalls = 0;
    const paystack = activeAccount('paystack');
    const pendingMonnify = activeAccount('monnify', {
        accountNumber: undefined,
        active: false,
        assigned: false,
        provisioningStatus: 'pending',
        provisioningKey: 'monnify:gateway-monnify'
    });
    const legacy = { bankName: 'Legacy Wema', accountNumber: '1010101010', active: true };
    const user = { _id: 'user-1', virtualAccounts: [paystack, pendingMonnify, legacy] };
    const service = new VirtualAccountService({
        repository: {
            async getUser() { return user; },
            async listLegacyUnverified() { return [legacy]; }
        },
        gatewayService: {
            async getGateway() { gatewayCalls++; throw new Error('status reads must not access providers'); }
        }
    });

    const result = await service.getAccountStatus({ userId: 'user-1' });

    assert.deepEqual(result.accounts, [paystack]);
    assert.deepEqual(result.providers.paystack, { status: 'active', existing: true });
    assert.equal(result.providers.monnify.status, 'legacy_review_required');
    assert.equal(result.providers.monnify.code, 'LEGACY_VIRTUAL_ACCOUNT_REVIEW_REQUIRED');
    assert.equal(result.legacyReviewRequired, true);
    assert.equal(gatewayCalls, 0);
});

test('account status advertises Paystack banks for the database gateway environment', async () => {
    const service = new VirtualAccountService({
        repository: {
            async getUser() { return { _id: 'user-1', virtualAccounts: [], virtualAccountPreferences: {} }; },
            async listLegacyUnverified() { return []; },
            async getGatewayEnvironment(provider) {
                return provider === 'paystack' ? 'live' : 'test';
            }
        }
    });

    const result = await service.getAccountStatus({ userId: 'user-1' });

    assert.deepEqual(result.providers.paystack.consent.preferredBanks, ['wema-bank', 'titan-paystack']);
    assert.equal(result.providers.paystack.consent.preferredBanks.includes('test-bank'), false);
});

test('Request Bank Account preserves provider independence and reports partial outcomes', async () => {
    const user = { _id: 'user-1', virtualAccounts: [], virtualAccountPreferences: {} };
    const service = new VirtualAccountService({
        repository: {
            async getUser() { return user; },
            async listLegacyUnverified() { return []; }
        },
        legal: eligibleLegalService
    });
    const calls = [];
    service.provision = async request => {
        calls.push(request);
        if (request.providerCode === 'paystack') {
            return { status: 'active', existing: false, accounts: [activeAccount('paystack')] };
        }
        const error = new Error('Monnify rejected the request');
        error.code = 'MONNIFY_VIRTUAL_ACCOUNT_PROVIDER_REJECTED';
        error.provisioningDisposition = 'definitive_rejection';
        throw error;
    };

    const result = await service.requestBankAccounts({
        userId: 'user-1',
        consents: {
            paystack: {
                granted: true,
                version: VIRTUAL_ACCOUNT_CONSENT_VERSION,
                preferredBank: 'wema-bank'
            },
            monnify: { granted: true, version: VIRTUAL_ACCOUNT_CONSENT_VERSION }
        }
    });

    assert.equal(result.status, 'partial');
    assert.equal(result.providers.paystack.status, 'active');
    assert.equal(result.providers.monnify.status, 'definitive_rejection');
    assert.deepEqual(calls.map(call => call.providerCode), ['paystack', 'monnify']);
    assert.ok(calls.every(call => call.consent === true));
    assert.ok(calls.every(call => call.consentVersion === VIRTUAL_ACCOUNT_CONSENT_VERSION));
    assert.ok(calls.every(call => call.consentChannel === 'request_bank_account'));
});

test('Request Bank Account rejects stale consent per provider without blocking another provider', async () => {
    const user = { _id: 'user-1', virtualAccounts: [], virtualAccountPreferences: {} };
    const service = new VirtualAccountService({
        repository: {
            async getUser() { return user; },
            async listLegacyUnverified() { return []; }
        },
        legal: eligibleLegalService
    });
    const calls = [];
    service.provision = async request => {
        calls.push(request);
        return { status: 'pending', state: 'awaiting_assignment', existing: false, accounts: [] };
    };

    const result = await service.requestBankAccounts({
        userId: 'user-1',
        consents: {
            paystack: { granted: true, version: 'stale_v0', preferredBank: 'wema-bank' },
            monnify: { granted: true, version: VIRTUAL_ACCOUNT_CONSENT_VERSION }
        }
    });

    assert.equal(result.status, 'pending');
    assert.equal(result.providers.paystack.status, 'consent_required');
    assert.equal(result.providers.paystack.code, 'VIRTUAL_ACCOUNT_CONSENT_VERSION_INVALID');
    assert.equal(result.providers.monnify.status, 'awaiting_assignment');
    assert.deepEqual(calls.map(call => call.providerCode), ['monnify']);
});

test('Request Bank Account scopes provisioning and consent to one selected provider', async () => {
    const user = { _id: 'user-1', virtualAccounts: [], virtualAccountPreferences: {} };
    const service = new VirtualAccountService({
        repository: {
            async getUser() { return user; },
            async listLegacyUnverified() { return []; }
        },
        legal: eligibleLegalService
    });
    const calls = [];
    service.provision = async request => {
        calls.push(request);
        return { status: 'pending', state: 'awaiting_assignment', existing: false, accounts: [] };
    };

    const result = await service.requestBankAccounts({
        userId: 'user-1',
        providers: ['monnify'],
        consents: {
            monnify: { granted: true, version: VIRTUAL_ACCOUNT_CONSENT_VERSION }
        },
        retryRejectedProviders: ['paystack']
    });

    assert.deepEqual(calls.map(call => call.providerCode), ['monnify']);
    assert.equal(result.status, 'pending');
    assert.equal(result.providers.monnify.status, 'awaiting_assignment');
    assert.equal(result.providers.paystack.status, 'consent_required');
});

test('recovery claims persisted work once and a fresh service can resume it after restart', async () => {
    const candidate = {
        userId: 'user-1',
        account: {
            provider: 'paystack',
            provisioningKey: 'paystack:gateway-paystack',
            provisioningStatus: 'failed',
            provisioningFailureDisposition: 'ambiguous_mutation',
            provisioningRecoveryAttemptCount: 1,
            preferredBank: 'wema-bank',
            consentGrantedAt: new Date('2026-01-01T00:00:00.000Z'),
            consentVersion: VIRTUAL_ACCOUNT_CONSENT_VERSION,
            consentChannel: 'request_bank_account'
        }
    };
    let claimed = false;
    const repository = {
        async listRecoveryCandidates() { return claimed ? [] : [candidate]; },
        async claimRecoveryAttempt() {
            if (claimed) return false;
            claimed = true;
            return true;
        }
    };
    const firstProcess = new VirtualAccountService({ repository, legal: eligibleLegalService });
    const secondProcess = new VirtualAccountService({ repository, legal: eligibleLegalService });
    const requests = [];
    secondProcess.provision = async request => {
        requests.push(request);
        return { status: 'active', accounts: [activeAccount('paystack')] };
    };

    const result = await secondProcess.recoverProvisioning({ now: new Date('2026-01-02T00:00:00.000Z') });
    const repeated = await firstProcess.recoverProvisioning({ now: new Date('2026-01-02T00:05:00.000Z') });

    assert.deepEqual(result, {
        skipped: false,
        scanned: 1,
        claimed: 1,
        active: 1,
        pending: 0,
        failed: 0,
        eligibilityScanned: 0,
        eligibilityEligible: 0
    });
    assert.equal(repeated.scanned, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].internalRecovery, true);
    assert.equal(requests[0].verifyLegal, true);
    assert.equal(requests[0].consentVersion, VIRTUAL_ACCOUNT_CONSENT_VERSION);
});

test('a fresh recovery worker finds completed consenting users missed after PIN completion', async () => {
    const consentGrantedAt = new Date('2026-01-01T00:00:00.000Z');
    const users = [
        {
            _id: 'user-consenting',
            status: true,
            isPinSet: true,
            virtualAccounts: [],
            virtualAccountPreferences: {
                paystack: {
                    preferredBank: 'wema-bank',
                    consentGrantedAt,
                    consentVersion: VIRTUAL_ACCOUNT_CONSENT_VERSION,
                    consentChannel: 'request_bank_account'
                },
                monnify: {
                    consentGrantedAt,
                    consentVersion: VIRTUAL_ACCOUNT_CONSENT_VERSION,
                    consentChannel: 'request_bank_account'
                }
            }
        },
        {
            _id: 'user-without-consent',
            status: true,
            isPinSet: true,
            virtualAccounts: [],
            virtualAccountPreferences: {}
        },
        {
            _id: 'user-with-legacy-wema',
            status: true,
            isPinSet: true,
            virtualAccounts: [{ bankName: 'Wema Bank', accountNumber: '1000000001' }],
            virtualAccountPreferences: {
                monnify: {
                    consentGrantedAt,
                    consentVersion: VIRTUAL_ACCOUNT_CONSENT_VERSION,
                    consentChannel: 'request_bank_account'
                }
            }
        }
    ];
    const repository = {
        async listEligibilitySweepPage({ afterId, limit }) {
            assert.equal(afterId, null);
            assert.equal(limit, 25);
            return users;
        },
        async listRecoveryCandidates() { return []; }
    };
    const serviceAfterRestart = new VirtualAccountService({
        repository,
        onboarding: { async getState() { return { complete: true }; } },
        legal: eligibleLegalService
    });
    const requests = [];
    serviceAfterRestart.provision = async request => {
        requests.push(request);
        return { status: request.providerCode === 'paystack' ? 'pending' : 'active' };
    };

    const result = await serviceAfterRestart.recoverProvisioning();

    assert.equal(result.eligibilityScanned, 3);
    assert.equal(result.eligibilityEligible, 2);
    assert.equal(result.pending, 1);
    assert.equal(result.active, 1);
    assert.deepEqual(requests.map(request => request.providerCode), ['paystack', 'monnify']);
    assert.ok(requests.every(request => request.internalRecovery === true));
    assert.ok(requests.every(request => request.verifyLegal === true));
    assert.ok(requests.every(request => request.consentVersion === VIRTUAL_ACCOUNT_CONSENT_VERSION));
    assert.equal(requests[0].preferredBank, 'wema-bank');
});

test('recovery worker refuses overlapping runs in the same process', async () => {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const candidate = {
        userId: 'user-1',
        account: {
            provider: 'monnify',
            provisioningKey: 'monnify:gateway-monnify',
            provisioningStatus: 'failed',
            consentGrantedAt: new Date('2026-01-01T00:00:00.000Z'),
            consentVersion: VIRTUAL_ACCOUNT_CONSENT_VERSION
        }
    };
    const service = new VirtualAccountService({
        repository: {
            async listRecoveryCandidates() { return [candidate]; },
            async claimRecoveryAttempt() { return true; }
        },
        legal: eligibleLegalService
    });
    service.provision = async () => {
        await wait;
        return { status: 'pending' };
    };

    const running = service.recoverProvisioning();
    await new Promise(resolve => setImmediate(resolve));
    const overlap = await service.recoverProvisioning();
    assert.deepEqual(overlap, { skipped: true, reason: 'already_running', scanned: 0, claimed: 0 });
    release();
    await running;
});

test('Mongo recovery claims use exponential backoff capped at six hours', async () => {
    const writes = [];
    const repository = new MongoVirtualAccountRepository({
        async updateOne(filter, update) {
            writes.push({ filter, update });
            return { modifiedCount: 1 };
        }
    });
    const now = new Date('2026-01-02T00:00:00.000Z');

    await repository.claimRecoveryAttempt({
        userId: 'user-1',
        provisioningKey: 'paystack:gateway-paystack',
        now,
        attempt: 1
    });
    await repository.claimRecoveryAttempt({
        userId: 'user-1',
        provisioningKey: 'paystack:gateway-paystack',
        now,
        attempt: 20
    });

    assert.equal(writes[0].update.$set['virtualAccounts.$.provisioningNextRecoveryAt'].getTime() - now.getTime(), 5 * 60_000);
    assert.equal(writes[1].update.$set['virtualAccounts.$.provisioningNextRecoveryAt'].getTime() - now.getTime(), 6 * 60 * 60_000);
    assert.equal(writes[0].update.$inc, undefined);
    const attemptLimit = writes[0].filter.virtualAccounts.$elemMatch.$and[2].$or[1]
        .provisioningRecoveryAttemptCount.$lt;
    assert.equal(attemptLimit, RECOVERY_MAX_ATTEMPTS);
});

test('recovery budget increments only when a provisioning claim starts and external retry resets it', async () => {
    const writes = [];
    const repository = new MongoVirtualAccountRepository({
        async findOneAndUpdate(filter, update) {
            writes.push({ filter, update });
            return { _id: 'user-1' };
        }
    });
    const details = {
        userId: 'user-1',
        provider: 'paystack',
        gatewayId: 'gateway-paystack',
        provisioningKey: 'paystack:gateway-paystack',
        preferredBank: 'wema-bank',
        consentGrantedAt: new Date('2026-01-01T00:00:00.000Z'),
        consentVersion: VIRTUAL_ACCOUNT_CONSENT_VERSION,
        consentChannel: 'request_bank_account',
        gatewayContext: 'context',
        retryRejected: false,
        recoverIncompleteExpectedCount: 0
    };

    await repository.claimProvisioning({ ...details, internalRecovery: true });
    await repository.claimProvisioning({ ...details, internalRecovery: false });

    assert.equal(writes[0].update.$inc['virtualAccounts.$.provisioningRecoveryAttemptCount'], 1);
    assert.equal(writes[1].update.$inc, undefined);
    assert.equal(writes[1].update.$set['virtualAccounts.$.provisioningRecoveryAttemptCount'], 0);
    assert.equal(writes[1].update.$set['virtualAccounts.$.provisioningNextRecoveryAt'], null);
});

test('Monnify recovery requires the exact deterministic account reference', () => {
    const service = new VirtualAccountService();
    const accountReference = 'VIRTUAL_507f1f77bcf86cd799439011';
    const result = {
        status: true,
        accountReference,
        accounts: [{ bankName: 'Wema Bank', bankCode: '035', accountNumber: '9988776655' }]
    };

    assert.equal(service._validMonnifyResult(result, accountReference), true);
    assert.equal(service._validMonnifyResult({ ...result, accountReference: undefined }, accountReference), false);
    assert.equal(service._validMonnifyResult({ ...result, accountReference: 'VIRTUAL_000000000000000000000000' }, accountReference), false);
});

test('Monnify V2 completion requires exact merchant, customer, status, and unique bank evidence', () => {
    const service = new VirtualAccountService();
    const accountReference = 'VIRTUAL_507f1f77bcf86cd799439011';
    const gateway = { metadata: { contractCode: '1234567890' } };
    const user = { email: 'ada@example.com' };
    const result = {
        status: true,
        apiVersion: 'v2',
        contractCode: '1234567890',
        accountReference,
        currencyCode: 'NGN',
        customerEmail: 'ada@example.com',
        reservationReference: 'RESERVATION-1',
        reservedAccountType: 'GENERAL',
        providerStatus: 'ACTIVE',
        accounts: [{
            bankName: 'Moniepoint',
            bankCode: '50515',
            accountName: 'Ada Lovelace',
            accountNumber: '9988776655'
        }]
    };

    assert.equal(service._validMonnifyResult(result, accountReference, { gateway, user }), true);
    assert.equal(service._validMonnifyResult({ ...result, contractCode: 'other' }, accountReference, { gateway, user }), false);
    assert.equal(service._validMonnifyResult({ ...result, customerEmail: 'other@example.com' }, accountReference, { gateway, user }), false);
    assert.equal(service._validMonnifyResult({ ...result, providerStatus: 'PENDING' }, accountReference, { gateway, user }), false);
    assert.equal(service._validMonnifyResult({
        ...result,
        accounts: [result.accounts[0], { ...result.accounts[0] }]
    }, accountReference, { gateway, user }), false);
});

test('Monnify ambiguous creation is reconciled without repeating the mutation', async () => {
    const service = new VirtualAccountService();
    let createCalls = 0;
    service._markMonnifyReconciliation = async () => ({
        status: 'pending',
        state: 'reconciliation_required',
        accounts: [],
        existing: true
    });
    const notFound = new Error('not found');
    notFound.response = { status: 404 };
    const result = await service._provisionMonnify({
        user: { _id: '507f1f77bcf86cd799439011', name: 'Ada Lovelace' },
        gateway: { _id: 'gateway-monnify' },
        adapter: {
            assertVirtualAccountCustomer() {},
            async getReservedAccount() { throw notFound; },
            async createReservedAccount() { createCalls += 1; }
        },
        provisioningKey: 'monnify:gateway-monnify',
        token: 'claim-token',
        consentEvidence: {},
        existingOperation: { provisioningDispatchState: 'reconciling' }
    });

    assert.equal(result.state, 'reconciliation_required');
    assert.equal(createCalls, 0);
});

test('Monnify deposit ownership requires exactly one gateway/reference/account match', async () => {
    const accountReference = 'VIRTUAL_507f1f77bcf86cd799439011';
    const owner = { userId: '507f1f77bcf86cd799439011', account: activeAccount('monnify') };
    let lookup = { match: owner, matchCount: 1 };
    const service = new VirtualAccountService({
        repository: {
            async findActiveMonnifyDepositOwner(request) {
                assert.deepEqual(request, {
                    gatewayId: 'gateway-monnify',
                    accountReference,
                    accountNumber: '9988776655',
                    allowUnscopedCanonical: true
                });
                return lookup;
            }
        }
    });
    const gateway = { _id: 'gateway-monnify', code: 'monnify', adapterType: 'monnify' };

    assert.equal((await service.resolveMonnifyDepositOwner({
        gateway,
        accountReference,
        accountNumber: '9988776655'
    })).userId, owner.userId);

    lookup = { match: null, matchCount: 2 };
    await assert.rejects(
        service.resolveMonnifyDepositOwner({ gateway, accountReference, accountNumber: '9988776655' }),
        error => error.code === 'MONNIFY_VIRTUAL_ACCOUNT_DEPOSIT_AMBIGUOUS' && error.webhookTerminal === true
    );

    await assert.rejects(
        service.resolveMonnifyDepositOwner({ gateway, accountReference: 'VIRTUAL_user-1', accountNumber: '9988776655' }),
        error => error.code === 'MONNIFY_VIRTUAL_ACCOUNT_DEPOSIT_MALFORMED' && error.webhookTerminal === true
    );
});

test('racing and duplicate Monnify reserved-account webhooks settle exactly once', async () => {
    const originals = {
        getGateway: paymentGatewayService.getGateway,
        getAdapterInstance: paymentGatewayService.getAdapterInstance,
        selectWebhookGateway: paymentGatewayService._selectWebhookGateway,
        claimWebhookEvent: paymentGatewayService._claimWebhookEvent,
        setWebhookEventState: paymentGatewayService._setWebhookEventState,
        finalizeFundingCredit: paymentGatewayService.finalizeFundingCredit,
        resolveOwner: virtualAccountService.resolveMonnifyDepositOwner,
        transactionFindOne: TransactionStatus.findOne,
        transactionCreate: TransactionStatus.create
    };
    const gateway = {
        _id: 'gateway-monnify',
        code: 'monnify',
        adapterType: 'monnify',
        name: 'Monnify'
    };
    const normalized = {
        eventId: 'MNFY-TX-1',
        eventType: 'SUCCESSFUL_TRANSACTION',
        status: 'success',
        reference: 'MNFY-PAY-1',
        providerTransactionId: 'MNFY-TX-1',
        amount: 5000,
        currency: 'NGN',
        virtualAccountReference: 'VIRTUAL_507f1f77bcf86cd799439011',
        destinationAccountNumber: '9988776655'
    };
    const adapter = {
        normalizeWebhook() { return normalized; },
        async verifyPayment() {
            return {
                success: true,
                status: 'success',
                reference: normalized.reference,
                providerTransactionId: normalized.providerTransactionId,
                amount: normalized.amount,
                currency: normalized.currency
            };
        }
    };
    let eventProcessed = false;
    let transaction = null;
    let ownerCalls = 0;
    let createCalls = 0;
    let settlementCalls = 0;

    paymentGatewayService.getGateway = async () => gateway;
    paymentGatewayService.getAdapterInstance = () => adapter;
    paymentGatewayService._selectWebhookGateway = () => ({ matched: true, gateway, adapter });
    paymentGatewayService._claimWebhookEvent = async () => eventProcessed
        ? { response: { status: 200, message: 'Duplicate webhook ignored' } }
        : { webhookEvent: { provider: 'monnify', eventId: normalized.eventId } };
    paymentGatewayService._setWebhookEventState = async (_event, status) => {
        if (status === 'processed') eventProcessed = true;
    };
    paymentGatewayService.finalizeFundingCredit = async () => {
        settlementCalls++;
        return { success: true, status: 'success', credited: true };
    };
    virtualAccountService.resolveMonnifyDepositOwner = async () => {
        ownerCalls++;
        return {
            userId: '507f1f77bcf86cd799439011',
            account: activeAccount('monnify'),
            gatewaySnapshot: { gatewayId: gateway._id, code: 'monnify', adapterType: 'monnify' }
        };
    };
    TransactionStatus.findOne = () => ({
        select: async () => transaction,
        then: (resolve, reject) => Promise.resolve(transaction).then(resolve, reject)
    });
    TransactionStatus.create = async document => {
        createCalls++;
        transaction = { ...document };
        const error = new Error('concurrent transaction winner');
        error.code = 11000;
        throw error;
    };

    try {
        const request = { headers: {}, body: Buffer.from('{}') };
        const first = await paymentGatewayService.routeWebhook('monnify', request);
        const duplicate = await paymentGatewayService.routeWebhook('monnify', request);

        assert.equal(first.status, 200);
        assert.equal(duplicate.status, 200);
        assert.equal(ownerCalls, 1);
        assert.equal(createCalls, 1);
        assert.equal(settlementCalls, 1);
        assert.equal(transaction.userId, '507f1f77bcf86cd799439011');
        assert.equal(transaction.channels.includes('virtual_account'), true);
        assert.equal(transaction.provider, 'monnify');
        assert.equal(transaction.gatewayId, gateway._id);
    } finally {
        paymentGatewayService.getGateway = originals.getGateway;
        paymentGatewayService.getAdapterInstance = originals.getAdapterInstance;
        paymentGatewayService._selectWebhookGateway = originals.selectWebhookGateway;
        paymentGatewayService._claimWebhookEvent = originals.claimWebhookEvent;
        paymentGatewayService._setWebhookEventState = originals.setWebhookEventState;
        paymentGatewayService.finalizeFundingCredit = originals.finalizeFundingCredit;
        virtualAccountService.resolveMonnifyDepositOwner = originals.resolveOwner;
        TransactionStatus.findOne = originals.transactionFindOne;
        TransactionStatus.create = originals.transactionCreate;
    }
});
