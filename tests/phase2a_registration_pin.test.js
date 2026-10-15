'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase2a-registration-test-secret';

const User = require('../models/User');
const Wallet = require('../models/Wallet');
const LegalAcceptance = require('../models/LegalAcceptance');
const ActivityLog = require('../models/ActivityLog');
const legalService = require('../services/legalDocument.service');
const onboardingService = require('../services/onboarding.service');
const passwordResetService = require('../services/passwordReset.service');
const virtualAccountService = require('../services/virtualAccount.service');
const notificationService = require('../services/notification.service');
const pinService = require('../services/pin.service');
const authController = require('../controllers/authController');
const pinController = require('../controllers/pinController');
const onboardingController = require('../controllers/onboardingController');
const walletController = require('../controllers/walletController');
const { phoneIdentityCandidates, validateCustomerProfile } = require('../utils/customerProfile');

const withPatched = async (patches, operation) => {
    const originals = patches.map(({ target, key }) => ({ target, key, value: target[key] }));
    for (const { target, key, value } of patches) target[key] = value;
    try {
        return await operation();
    } finally {
        for (const { target, key, value } of originals.reverse()) target[key] = value;
    }
};

const makeRes = () => ({
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    cookie() { return this; }
});

test('customer phone identities are canonicalized while legacy representations remain searchable', () => {
    assert.equal(validateCustomerProfile({
        name: 'Ada Lovelace', email: 'ada@example.com', phone: '+2348012345678'
    }).normalized.phone, '2348012345678');
    assert.deepEqual(phoneIdentityCandidates('08012345678'), [
        '2348012345678', '+2348012345678', '08012345678'
    ]);
});

test('login, password reset, and transfer lookup all accept legacy phone representations', async () => {
    const expectedCandidates = ['2348012345678', '+2348012345678', '08012345678'];

    let loginFilter;
    await withPatched([{
        target: User,
        key: 'findOne',
        value: filter => {
            loginFilter = filter;
            return { select: async () => null };
        }
    }], async () => {
        const res = makeRes();
        await authController.login({
            body: { phone: '08012345678', password: 'Passw0rd!' },
            headers: {}
        }, res);
        assert.equal(res.statusCode, 400);
    });
    assert.deepEqual(loginFilter.$or[1].phone.$in, expectedCandidates);

    let resetIssueFilter;
    await withPatched([{
        target: User,
        key: 'findOneAndUpdate',
        value: filter => {
            resetIssueFilter = filter;
            return { select: async () => null };
        }
    }], () => passwordResetService.issueResetChallenge('+2348012345678'));
    assert.deepEqual(resetIssueFilter.phone.$in, expectedCandidates);

    let resetVerifyFilter;
    await withPatched([{
        target: User,
        key: 'findOne',
        value: filter => {
            resetVerifyFilter = filter;
            return { select: async () => null };
        }
    }], async () => {
        await assert.rejects(
            () => passwordResetService.verifyResetChallenge('2348012345678', '123456'),
            /Invalid or expired/
        );
    });
    assert.deepEqual(resetVerifyFilter.phone.$in, expectedCandidates);

    let transferFilter;
    await withPatched([{
        target: User,
        key: 'findOne',
        value: filter => {
            transferFilter = filter;
            return { select: async () => null };
        }
    }], async () => {
        const res = makeRes();
        await walletController.verifyTransferRecipient({
            query: { identifier: '08012345678' },
            user: { id: 'sender-1' }
        }, res);
        assert.equal(res.statusCode, 404);
    });
    assert.deepEqual(transferFilter.$or[0].phone.$in, expectedCandidates);
});

test('new-user registration requires matching password confirmation before writes', async () => {
    let writes = 0;
    await withPatched([
        { target: onboardingService, key: 'requiresConfirmationForNewUser', value: () => true },
        { target: User, key: 'create', value: async () => { writes++; } },
        { target: mongoose, key: 'startSession', value: async () => { writes++; } }
    ], async () => {
        const missing = makeRes();
        await authController.register({
            body: { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+2348012345678', password: 'Passw0rd!' },
            headers: {}
        }, missing);
        assert.equal(missing.statusCode, 400);
        assert.equal(missing.body.code, 'PASSWORD_CONFIRMATION_REQUIRED');

        const mismatch = makeRes();
        await authController.register({
            body: {
                name: 'Ada Lovelace', email: 'ada@example.com', phone: '+2348012345678',
                password: 'Passw0rd!', confirmPassword: 'different'
            },
            headers: {}
        }, mismatch);
        assert.equal(mismatch.statusCode, 400);
        assert.equal(mismatch.body.code, 'PASSWORD_CONFIRMATION_MISMATCH');
        assert.equal(writes, 0);
    });
});

test('registration rejects malformed customer identity while onboarding enforcement is off', async () => {
    let writes = 0;
    await withPatched([
        { target: onboardingService, key: 'requiresConfirmationForNewUser', value: () => false },
        { target: User, key: 'findOne', value: async () => { writes++; return null; } },
        { target: mongoose, key: 'startSession', value: async () => { writes++; } }
    ], async () => {
        const res = makeRes();
        await authController.register({
            body: {
                name: 'Ada Lovelace',
                email: 'not-an-email',
                phone: 'invalid-phone',
                password: 'Passw0rd!'
            },
            headers: {}
        }, res);

        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, 'CUSTOMER_PROFILE_INVALID');
        assert.deepEqual(res.body.data.invalidFields.sort(), ['email', 'phone']);
        assert.equal(writes, 0);
    });
});

test('legacy registration may omit confirmation and preserves referral, legal, and wallet transaction writes', async () => {
    const session = {
        startTransaction() {},
        async commitTransaction() {},
        async abortTransaction() {},
        endSession() {}
    };
    const created = [];
    const logs = [];
    const onboarding = { currentStep: 'contact_verification', dashboardAllowed: true };
    const user = {
        _id: 'new-user', name: 'Ada Lovelace', email: 'ada@example.com', phone: '+2348012345678',
        role: 'user', roles: ['user'], status: true, isPhoneVerified: false, isEmailVerified: false,
        isPinSet: false, myReferralCode: 'generated', async save() { return this; }
    };

    await withPatched([
        { target: onboardingService, key: 'requiresConfirmationForNewUser', value: () => false },
        { target: onboardingService, key: 'registrationPolicyFields', value: () => ({}) },
        { target: onboardingService, key: 'getStateForResponse', value: async () => onboarding },
        {
            target: User,
            key: 'findOne',
            value: async filter => filter.myReferralCode === 'friend'
                ? { _id: 'referrer', phone: '+2348099999999', email: 'friend@example.com' }
                : null
        },
        {
            target: User,
            key: 'create',
            value: async (rows, options) => {
                created.push({ type: 'user', rows, options });
                return [user];
            }
        },
        {
            target: Wallet,
            key: 'create',
            value: async (rows, options) => { created.push({ type: 'wallet', rows, options }); return rows; }
        },
        {
            target: LegalAcceptance,
            key: 'insertMany',
            value: async (rows, options) => { created.push({ type: 'legal', rows, options }); return rows; }
        },
        { target: legalService, key: 'validateSignupAcceptances', value: async () => [{ documentId: 'doc', documentType: 'terms', version: 1, channel: 'web', acceptanceType: 'agreement', contentHash: 'hash' }] },
        { target: ActivityLog, key: 'create', value: async () => ({}) },
        { target: notificationService, key: 'sendInApp', value: async () => ({}) },
        { target: virtualAccountService, key: 'provisionEligible', value: async () => ({}) },
        { target: bcrypt, key: 'hash', value: async value => `hashed:${value}` },
        { target: mongoose, key: 'startSession', value: async () => session },
        { target: console, key: 'log', value: (...args) => logs.push(args.join(' ')) }
    ], async () => {
        const res = makeRes();
        await authController.register({
            body: {
                name: ' Ada   Lovelace ', email: 'ADA@example.com', phone: '+2348012345678',
                password: 'Passw0rd!', referralCode: ' FRIEND ', legalAcceptances: [{}]
            },
            ip: '127.0.0.1', headers: { 'user-agent': 'phase2a-test' }
        }, res);

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.onboarding, onboarding);
        const userWrite = created.find(entry => entry.type === 'user');
        assert.equal(userWrite.rows[0].referredBy, 'referrer');
        assert.equal(userWrite.rows[0].referrerCode, 'friend');
        assert.equal(userWrite.rows[0].password, 'hashed:Passw0rd!');
        assert.equal(userWrite.rows[0].phone, '2348012345678');
        assert.equal('confirmPassword' in userWrite.rows[0], false);
        assert.equal(created.find(entry => entry.type === 'wallet').options.session, session);
        assert.equal(created.find(entry => entry.type === 'legal').options.session, session);
        assert.equal(userWrite.options.session, session);
        assert.equal(logs.join('\n').includes(user.phone), false);
    });
});

test('enforced PIN setup requires the correct step and matching confirmation', async () => {
    let setCalls = 0;
    const scheduled = [];
    const transactionPinState = {
        enforced: true,
        currentStep: 'transaction_pin',
        complete: false
    };
    const completedState = { ...transactionPinState, currentStep: 'complete', complete: true };

    await withPatched([
        {
            target: onboardingService,
            key: 'getStateForResponse',
            value: async () => setCalls === 0 ? transactionPinState : completedState
        },
        { target: pinService, key: 'setPin', value: async () => { setCalls++; return { message: 'Transaction PIN set successfully' }; } },
        { target: virtualAccountService, key: 'scheduleEligibleProvisioning', value: value => { scheduled.push(value); return true; } },
        { target: ActivityLog, key: 'create', value: async () => ({}) },
        { target: notificationService, key: 'sendInApp', value: async () => ({}) }
    ], async () => {
        const missing = makeRes();
        await pinController.setPin({ user: { id: 'user-1' }, body: { pin: '1234' }, headers: {} }, missing);
        assert.equal(missing.statusCode, 400);
        assert.equal(setCalls, 0);

        const mismatch = makeRes();
        await pinController.setPin({ user: { id: 'user-1' }, body: { pin: '1234', confirmPin: '4321' }, headers: {} }, mismatch);
        assert.equal(mismatch.statusCode, 400);
        assert.equal(setCalls, 0);

        const success = makeRes();
        await pinController.setPin({
            user: { id: 'user-1' }, body: { pin: '1234', confirmPin: '1234' },
            ip: '127.0.0.1', headers: { 'user-agent': 'phase2a-test' }
        }, success);
        assert.equal(success.statusCode, 200);
        assert.equal(setCalls, 1);
        assert.deepEqual(success.body.onboarding, completedState);
        assert.equal(scheduled.length, 1);
        assert.equal(scheduled[0].userId, 'user-1');
        assert.deepEqual(scheduled[0].before, transactionPinState);
        assert.deepEqual(scheduled[0].after, completedState);
    });
});

test('enforced PIN setup cannot skip contact verification', async () => {
    let setCalls = 0;
    await withPatched([
        {
            target: onboardingService,
            key: 'getStateForResponse',
            value: async () => ({ enforced: true, currentStep: 'contact_verification' })
        },
        { target: pinService, key: 'setPin', value: async () => { setCalls++; } }
    ], async () => {
        const res = makeRes();
        await pinController.setPin({
            user: { id: 'user-1' }, body: { pin: '1234', confirmPin: '1234' }, headers: {}
        }, res);
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.code, 'ONBOARDING_STEP_INVALID');
        assert.equal(setCalls, 0);
    });
});

test('login, profile, and status endpoints expose the same interrupted onboarding state', async () => {
    const authoritative = {
        policyVersion: 1,
        mode: 'new_users',
        enrolled: true,
        enforced: true,
        status: 'incomplete',
        currentStep: 'contact_verification',
        complete: false,
        dashboardAllowed: false
    };
    const user = {
        _id: 'interrupted-user',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+2348012345678',
        password: 'password-hash',
        role: 'user',
        roles: ['user'],
        status: true,
        isPhoneVerified: false,
        isEmailVerified: false,
        isPinSet: false,
        virtualAccounts: [],
        linkedAccounts: [],
        async save() { return this; }
    };

    await withPatched([
        { target: onboardingService, key: 'getStateForResponse', value: async () => authoritative },
        { target: onboardingService, key: 'getState', value: async () => authoritative },
        {
            target: User,
            key: 'findOne',
            value: () => ({ select: async () => user })
        },
        {
            target: User,
            key: 'findById',
            value: () => ({ select: async () => user })
        },
        { target: bcrypt, key: 'compare', value: async () => true },
        { target: ActivityLog, key: 'create', value: async () => ({}) },
        { target: notificationService, key: 'sendInApp', value: async () => ({}) },
        { target: virtualAccountService, key: 'provisionEligible', value: async () => ({}) }
    ], async () => {
        const loginRes = makeRes();
        await authController.login({
            body: { email: user.email, password: 'Passw0rd!' },
            ip: '127.0.0.1',
            headers: { 'user-agent': 'phase2a-test' }
        }, loginRes);

        const profileRes = makeRes();
        await authController.profile({ user: { id: user._id } }, profileRes);

        const statusRes = makeRes();
        await onboardingController.getStatus({ user: { id: user._id } }, statusRes);

        assert.deepEqual(loginRes.body.onboarding, authoritative);
        assert.deepEqual(profileRes.body.onboarding, authoritative);
        assert.deepEqual(statusRes.body.onboarding, authoritative);
    });
});
