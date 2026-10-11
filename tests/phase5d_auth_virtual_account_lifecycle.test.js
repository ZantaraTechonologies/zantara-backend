'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase5d-auth-test-secret';

const User = require('../models/User');
const Wallet = require('../models/Wallet');
const LegalAcceptance = require('../models/LegalAcceptance');
const ActivityLog = require('../models/ActivityLog');
const legalService = require('../services/legalDocument.service');
const notificationService = require('../services/notification.service');
const virtualAccountService = require('../services/virtualAccount.service');
const authController = require('../controllers/authController');

const makeRes = () => ({
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; if (this.statusCode === null) this.statusCode = 200; return this; },
    cookie() { return this; },
    clearCookie() { return this; }
});

const withPatched = async (patches, operation) => {
    const originals = patches.map(({ target, key, value }) => ({ target, key, value: target[key] }));
    for (const { target, key, value } of patches) target[key] = value;
    try {
        return await operation();
    } finally {
        for (const { target, key, value } of originals.reverse()) target[key] = value;
    }
};

const registrationUser = () => ({
    _id: 'phase5d-register-user',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '+2348012345678',
    role: 'user',
    roles: ['user'],
    status: true,
    isPhoneVerified: false,
    myReferralCode: 'phase5d',
    async save() { return this; }
});

const registrationPatches = ({ provisionEligible, commitTransaction }) => [
    { target: User, key: 'findOne', value: async () => null },
    { target: User, key: 'create', value: async () => [registrationUser()] },
    { target: Wallet, key: 'create', value: async () => [] },
    { target: LegalAcceptance, key: 'insertMany', value: async () => [] },
    { target: ActivityLog, key: 'create', value: async () => ({}) },
    { target: legalService, key: 'validateSignupAcceptances', value: async () => [] },
    { target: virtualAccountService, key: 'provisionEligible', value: provisionEligible },
    { target: bcrypt, key: 'hash', value: async () => 'hashed-password' },
    {
        target: mongoose,
        key: 'startSession',
        value: async () => ({
            startTransaction() {},
            commitTransaction,
            async abortTransaction() {},
            endSession() {}
        })
    }
];

test('registration schedules the shared lifecycle after commit without waiting for providers', async () => {
    let committed = false;
    let observed;
    let releaseProviders;
    const providersPending = new Promise(resolve => { releaseProviders = resolve; });
    const res = makeRes();
    await withPatched(registrationPatches({
        commitTransaction: async () => { committed = true; },
        provisionEligible: async request => {
            assert.equal(committed, true);
            observed = request;
            await providersPending;
            return {
                paystack: { status: 'active', accounts: [] },
                monnify: { status: 'active', accounts: [] }
            };
        }
    }), async () => {
        await authController.register({
            body: {
                name: 'Ada Lovelace',
                email: 'ada@example.com',
                phone: '+2348012345678',
                password: 'Passw0rd!',
                consent: 'true',
                preferredBank: 'wema-bank',
                legalAcceptances: []
            },
            ip: '127.0.0.1',
            headers: { 'user-agent': 'phase5d-test' }
        }, res);
    });

    assert.equal(res.statusCode, 200);
    releaseProviders();
    assert.deepEqual(observed, {
        userId: 'phase5d-register-user',
        paystackConsent: true,
        paystackPreferredBank: 'wema-bank'
    });
});

test('registration remains successful when the automatic lifecycle throws', async () => {
    const originalError = console.error;
    const originalLog = console.log;
    console.error = () => {};
    console.log = () => {};
    const res = makeRes();
    try {
        await withPatched(registrationPatches({
            commitTransaction: async () => {},
            provisionEligible: async () => { throw new Error('all providers unavailable'); }
        }), async () => {
            await authController.register({
                body: {
                    name: 'Ada Lovelace',
                    email: 'ada@example.com',
                    phone: '+2348012345678',
                    password: 'Passw0rd!',
                    legalAcceptances: []
                },
                ip: '127.0.0.1',
                headers: { 'user-agent': 'phase5d-test' }
            }, res);
        });
    } finally {
        console.error = originalError;
        console.log = originalLog;
    }
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
});

test('successful login schedules account reevaluation without depending on provider completion', async () => {
    const user = {
        _id: 'phase5d-login-user',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+2348012345678',
        password: 'password-hash',
        role: 'user',
        roles: ['user'],
        status: true,
        async save() { return this; }
    };
    const observed = [];
    let releaseProviders;
    const providersPending = new Promise(resolve => { releaseProviders = resolve; });
    const res = makeRes();
    await withPatched([
        { target: User, key: 'findOne', value: () => ({ select: async () => user }) },
        { target: bcrypt, key: 'compare', value: async () => true },
        { target: ActivityLog, key: 'create', value: async () => ({}) },
        { target: notificationService, key: 'sendInApp', value: async () => ({}) },
        {
            target: virtualAccountService,
            key: 'provisionEligible',
            value: async request => {
                observed.push(request);
                await providersPending;
                return {
                    paystack: { status: 'skipped' },
                    monnify: { status: 'active', accounts: [] }
                };
            }
        }
    ], async () => {
        await authController.login({
            body: { email: 'ada@example.com', password: 'Passw0rd!' },
            ip: '127.0.0.1',
            headers: { 'user-agent': 'phase5d-test' }
        }, res);
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(observed, [{ userId: 'phase5d-login-user' }]);
    releaseProviders();
});

test('profile retrieval is read-only and never invokes provider provisioning', async () => {
    const events = [];
    const profileUser = { _id: 'phase5d-profile-user', name: 'Ada Lovelace', virtualAccounts: [] };
    const res = makeRes();
    await withPatched([
        {
            target: virtualAccountService,
            key: 'provisionEligible',
            value: async () => {
                throw new Error('profile must not invoke provisioning');
            }
        },
        {
            target: User,
            key: 'findById',
            value: id => ({
                select: async () => {
                    events.push(`profile:${id}`);
                    return profileUser;
                }
            })
        }
    ], async () => {
        await authController.profile({ user: { id: 'phase5d-profile-user' } }, res);
    });

    assert.deepEqual(events, ['profile:phase5d-profile-user']);
    assert.deepEqual(res.body.virtualAccounts, []);
});
