'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase2a-onboarding-test-secret';

const User = require('../models/User');
const Kyc = require('../models/Kyc');
const legalService = require('../services/legalDocument.service');
const onboardingService = require('../services/onboarding.service');
const requireOnboardingComplete = require('../middlewares/requireOnboardingComplete');
const { getOnboardingConfig } = require('../config/onboarding');

const withPatched = async (patches, operation) => {
    const originals = patches.map(({ target, key }) => ({ target, key, value: target[key] }));
    for (const { target, key, value } of patches) target[key] = value;
    try {
        return await operation();
    } finally {
        for (const { target, key, value } of originals.reverse()) target[key] = value;
    }
};

const withMode = async (mode, operation) => {
    const previous = process.env.ONBOARDING_ENFORCEMENT_MODE;
    if (mode === undefined) delete process.env.ONBOARDING_ENFORCEMENT_MODE;
    else process.env.ONBOARDING_ENFORCEMENT_MODE = mode;
    try {
        return await operation();
    } finally {
        if (previous === undefined) delete process.env.ONBOARDING_ENFORCEMENT_MODE;
        else process.env.ONBOARDING_ENFORCEMENT_MODE = previous;
    }
};

const queryResult = value => ({ select: async () => value });
const sortedResult = value => ({ sort: async () => value });

const baseUser = overrides => ({
    _id: 'user-1',
    status: true,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '+2348012345678',
    isPhoneVerified: false,
    isEmailVerified: false,
    isPinSet: false,
    onboardingPolicyVersion: 1,
    transactionPin: null,
    ...overrides
});

const stateFor = async ({ user, legal = {}, kyc = null, mode = 'new_users' }) => withMode(mode, () => withPatched([
    { target: User, key: 'findById', value: () => queryResult(user) },
    { target: Kyc, key: 'findOne', value: () => sortedResult(kyc) },
    {
        target: legalService,
        key: 'getRequirements',
        value: async () => ({
            missingAcceptances: [],
            missingMandatoryDocuments: [],
            documents: [],
            ...legal
        })
    }
], () => onboardingService.getState({ userId: user._id })));

test('authoritative state requires only PIN while profile, contacts, and legal status remain truthful', async () => {
    const basic = await stateFor({ user: baseUser({ name: ' ' }) });
    assert.equal(basic.currentStep, 'transaction_pin');
    assert.deepEqual(basic.basicKyc.missingFields, ['name']);

    const contacts = await stateFor({ user: baseUser() });
    assert.equal(contacts.currentStep, 'transaction_pin');
    assert.deepEqual(contacts.contactVerification.missing, ['phone', 'email']);
    assert.equal(contacts.contactVerification.status, 'unverified');
    assert.equal(contacts.contactVerification.requiredForOnboarding, false);

    const legal = await stateFor({
        user: baseUser({ isPhoneVerified: true, isEmailVerified: true }),
        legal: { missingAcceptances: ['privacy'] }
    });
    assert.equal(legal.currentStep, 'transaction_pin');
    assert.equal(legal.legalAcceptance.status, 'required');
    assert.equal(legal.legalAcceptance.requiredForOnboarding, false);

    const pin = await stateFor({
        user: baseUser({ isPhoneVerified: true, isEmailVerified: true })
    });
    assert.equal(pin.currentStep, 'transaction_pin');
    assert.equal(pin.transactionPin.isSet, false);

    const complete = await stateFor({
        user: baseUser({
            isPhoneVerified: true,
            isEmailVerified: true,
            isPinSet: false,
            transactionPin: 'bcrypt-hash'
        })
    });
    assert.equal(complete.currentStep, 'complete');
    assert.equal(complete.complete, true);
    assert.equal(complete.dashboardAllowed, true);
    assert.equal(complete.transactionPin.isSet, true);
});

test('manual identity verification is reported accurately but does not gate Basic KYC', async () => {
    for (const status of ['pending', 'rejected', 'approved']) {
        const state = await stateFor({
            user: baseUser({ isPhoneVerified: true, isEmailVerified: true }),
            kyc: {
                status,
                tier: 2,
                createdAt: new Date('2026-01-01T00:00:00Z'),
                ...(status === 'rejected' ? { rejectionReason: 'Unreadable document' } : {})
            }
        });
        assert.equal(state.currentStep, 'transaction_pin');
        assert.equal(state.identityVerification.status, status);
        assert.equal(state.identityVerification.tier, 2);
    }
});

test('legacy and observe-only customers are never blocked by incomplete candidate state', async () => {
    let dependencyCalls = 0;
    const legacyUser = baseUser({ onboardingPolicyVersion: undefined });
    const legacy = await withMode('new_users', () => withPatched([
        { target: User, key: 'findById', value: () => queryResult(legacyUser) },
        { target: Kyc, key: 'findOne', value: () => { dependencyCalls++; throw new Error('must not query'); } },
        { target: legalService, key: 'getRequirements', value: async () => { dependencyCalls++; throw new Error('must not query'); } }
    ], () => onboardingService.getState({ userId: legacyUser._id })));
    assert.equal(legacy.enrolled, false);
    assert.equal(legacy.status, 'not_applicable');
    assert.equal(legacy.dashboardAllowed, true);
    assert.equal(legacy.currentStep, null);
    assert.equal(dependencyCalls, 0);

    const observed = await stateFor({ user: baseUser(), mode: 'observe' });
    assert.equal(observed.observed, true);
    assert.equal(observed.enforced, false);
    assert.equal(observed.dashboardAllowed, true);
});

test('a stored policy version remains enrolled when the current policy version changes', async () => {
    const state = await stateFor({ user: baseUser({ onboardingPolicyVersion: 99 }) });
    assert.equal(state.policyVersion, 99);
    assert.equal(state.enrolled, true);
    assert.equal(state.enforced, true);
    assert.equal(state.dashboardAllowed, false);
});

test('unknown enforcement mode is rejected instead of silently disabling policy', async () => {
    await assert.rejects(
        () => stateFor({ user: baseUser(), mode: 'unexpected' }),
        error => error.code === 'ONBOARDING_CONFIGURATION_INVALID'
    );
});

test('missing mode defaults off locally but is rejected in staging and production', () => {
    const previousMode = process.env.ONBOARDING_ENFORCEMENT_MODE;
    const previousEnvironment = process.env.NODE_ENV;
    try {
        delete process.env.ONBOARDING_ENFORCEMENT_MODE;
        process.env.NODE_ENV = 'development';
        assert.equal(getOnboardingConfig().mode, 'off');

        for (const environment of ['staging', 'production']) {
            process.env.NODE_ENV = environment;
            assert.throws(
                () => getOnboardingConfig(),
                error => error.code === 'ONBOARDING_CONFIGURATION_INVALID'
            );
        }
    } finally {
        if (previousMode === undefined) delete process.env.ONBOARDING_ENFORCEMENT_MODE;
        else process.env.ONBOARDING_ENFORCEMENT_MODE = previousMode;
        if (previousEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnvironment;
    }
});

test('response enrichment degrades safely without granting dashboard access under enforcement', async () => {
    await withMode('new_users', () => withPatched([{
        target: onboardingService,
        key: 'getState',
        value: async () => { throw new Error('database unavailable'); }
    }], async () => {
        const state = await onboardingService.getStateForResponse({ userId: 'user-1' });
        assert.equal(state.status, 'unavailable');
        assert.equal(state.enforced, true);
        assert.equal(state.dashboardAllowed, false);
        assert.equal(state.code, 'ONBOARDING_STATE_UNAVAILABLE');
    }));
});

test('guard blocks only enforced incomplete customers and fails closed on lookup errors', async () => {
    const makeRes = () => ({
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    });

    await withMode('new_users', async () => {
        await withPatched([{
            target: onboardingService,
            key: 'getState',
            value: async () => ({ dashboardAllowed: false, currentStep: 'contact_verification' })
        }], async () => {
            const res = makeRes();
            let nextCalled = false;
            await requireOnboardingComplete({ user: { id: 'user-1', roles: ['user'] } }, res, () => { nextCalled = true; });
            assert.equal(nextCalled, false);
            assert.equal(res.statusCode, 403);
            assert.equal(res.body.code, 'ONBOARDING_INCOMPLETE');
        });

        await withPatched([{
            target: onboardingService,
            key: 'getState',
            value: async () => { throw new Error('database unavailable'); }
        }], async () => {
            const res = makeRes();
            let nextCalled = false;
            await requireOnboardingComplete({ user: { id: 'user-1', roles: ['user'] } }, res, () => { nextCalled = true; });
            assert.equal(nextCalled, false);
            assert.equal(res.statusCode, 503);
            assert.equal(res.body.code, 'ONBOARDING_STATE_UNAVAILABLE');
        });
    });
});

test('missing onboarding legal information does not block dashboard completion', async () => {
    const onboarding = await stateFor({
        user: baseUser({ isPhoneVerified: true, isEmailVerified: true }),
        legal: { missingMandatoryDocuments: ['privacy'] }
    });
    assert.equal(onboarding.status, 'incomplete');
    assert.equal(onboarding.currentStep, 'transaction_pin');
    assert.equal(onboarding.legalAcceptance.status, 'unavailable');
    assert.equal(onboarding.legalAcceptance.requiredForOnboarding, false);

    const complete = await stateFor({
        user: baseUser({ transactionPin: 'bcrypt-hash' }),
        legal: { missingMandatoryDocuments: ['privacy'] }
    });
    assert.equal(complete.currentStep, 'complete');
    assert.equal(complete.dashboardAllowed, true);
    assert.equal(complete.legalAcceptance.status, 'unavailable');
});

test('off and observe modes never block customer routes', async () => {
    for (const mode of ['off', 'observe']) {
        await withMode(mode, () => withPatched([{
            target: onboardingService,
            key: 'getState',
            value: async () => { throw new Error('database unavailable'); }
        }], async () => {
            let nextCalled = false;
            const req = { user: { id: 'user-1', roles: ['user'] } };
            await requireOnboardingComplete(req, {}, () => { nextCalled = true; });
            assert.equal(nextCalled, true, `${mode} must not block`);
            if (mode === 'observe') assert.equal(req.onboarding.code, 'ONBOARDING_STATE_UNAVAILABLE');
        }));
    }
});

test('staff bypass does not query customer onboarding state', async () => {
    await withPatched([{
        target: onboardingService,
        key: 'getState',
        value: async () => { throw new Error('must not query'); }
    }], async () => {
        let nextCalled = false;
        await requireOnboardingComplete({ user: { id: 'admin-1', roles: ['admin'] } }, {}, () => { nextCalled = true; });
        assert.equal(nextCalled, true);
    });
});
