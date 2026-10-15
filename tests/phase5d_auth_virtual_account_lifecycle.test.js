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
const onboardingService = require('../services/onboarding.service');
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
    { target: onboardingService, key: 'getStateForResponse', value: async () => ({ currentStep: 'contact_verification', dashboardAllowed: true }) },
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

test('registration never invokes provider provisioning', async () => {
    let committed = false;
    let provisioningCalls = 0;
    const res = makeRes();
    await withPatched(registrationPatches({
        commitTransaction: async () => { committed = true; },
        provisionEligible: async () => { provisioningCalls++; }
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
    assert.equal(committed, true);
    assert.equal(provisioningCalls, 0);
});

test('registration remains provider-independent even if provisioning would throw', async () => {
    const originalError = console.error;
    const originalLog = console.log;
    console.error = () => {};
    console.log = () => {};
    const res = makeRes();
    let provisioningCalls = 0;
    try {
        await withPatched(registrationPatches({
            commitTransaction: async () => {},
            provisionEligible: async () => { provisioningCalls++; throw new Error('all providers unavailable'); }
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
    assert.equal(provisioningCalls, 0);
});

test('successful login never invokes provider provisioning', async () => {
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
    let provisioningCalls = 0;
    const res = makeRes();
    await withPatched([
        { target: User, key: 'findOne', value: () => ({ select: async () => user }) },
        { target: bcrypt, key: 'compare', value: async () => true },
        { target: ActivityLog, key: 'create', value: async () => ({}) },
        { target: notificationService, key: 'sendInApp', value: async () => ({}) },
        { target: onboardingService, key: 'getStateForResponse', value: async () => ({ currentStep: 'contact_verification', dashboardAllowed: true }) },
        {
            target: virtualAccountService,
            key: 'provisionEligible',
            value: async () => { provisioningCalls++; }
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
    assert.equal(provisioningCalls, 0);
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
        { target: onboardingService, key: 'getStateForResponse', value: async () => ({ currentStep: 'contact_verification', dashboardAllowed: true }) },
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
