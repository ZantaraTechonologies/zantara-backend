'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');
const virtualAccountService = require('../services/virtualAccount.service');
const authController = require('../controllers/authController');
const adminController = require('../controllers/adminController');
const virtualAccountController = require('../controllers/virtualAccountController');
const monnifyController = require('../controllers/monnifyController');
const {
    serializeVirtualAccount,
    serializeUserProfile,
    serializeAdminUser
} = require('../utils/virtualAccountSerializer');

const INTERNAL_FIELDS = [
    'provisioningToken',
    'provisioningKey',
    'provisioningGatewayContext',
    'provisioningDispatchState',
    'provisioningAttemptCount',
    'provisioningLastDispatchAt',
    'provisioningStartedAt',
    'provisioningExpiresAt',
    'provisioningExpectedAccountCount',
    'provisionedAt',
    'provisioningFailure',
    'gatewayId',
    'accountReference',
    'providerAccountId',
    'providerCustomerId',
    'providerCustomerCode',
    'consentGrantedAt',
    'virtualAccountPreferences',
    'virtualAccountGatewaySnapshots'
];

const makeRes = () => ({
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; if (this.statusCode === null) this.statusCode = 200; return this; }
});

const withPatched = async (patches, operation) => {
    const originals = patches.map(({ target, key }) => ({ target, key, value: target[key] }));
    for (const { target, key, value } of patches) target[key] = value;
    try {
        return await operation();
    } finally {
        for (const { target, key, value } of originals.reverse()) target[key] = value;
    }
};

const assertNoInternalFields = value => {
    const visit = current => {
        if (!current || typeof current !== 'object') return;
        for (const [key, nested] of Object.entries(current)) {
            assert.equal(INTERNAL_FIELDS.includes(key), false, `response exposed internal field ${key}`);
            visit(nested);
        }
    };
    visit(value);
};

const accountFixture = overrides => ({
    _id: 'account-1',
    provider: 'paystack',
    bankName: 'Wema Bank',
    bankCode: '035',
    bankSlug: 'wema-bank',
    accountName: 'Ada Lovelace',
    accountNumber: '0123456789',
    currency: 'NGN',
    active: true,
    assigned: true,
    provisioningStatus: 'active',
    provisioningToken: 'secret-token',
    provisioningKey: 'paystack:gateway-1',
    provisioningGatewayContext: 'encrypted-context',
    provisioningDispatchState: 'complete',
    provisioningAttemptCount: 2,
    provisioningFailure: 'provider stack trace',
    gatewayId: 'gateway-1',
    accountReference: 'DVA_123',
    providerAccountId: 'provider-account-1',
    providerCustomerId: 'provider-customer-1',
    providerCustomerCode: 'CUS_123',
    consentGrantedAt: new Date('2026-01-01T00:00:00.000Z'),
    futureProviderSnapshot: { secretKey: 'sk_live_secret' },
    ...overrides
});

test('active virtual-account serialization exposes only display fields', () => {
    const serialized = serializeVirtualAccount(accountFixture());

    assert.deepEqual(serialized, {
        _id: 'account-1',
        provider: 'paystack',
        bankName: 'Wema Bank',
        bankCode: '035',
        bankSlug: 'wema-bank',
        accountName: 'Ada Lovelace',
        accountNumber: '0123456789',
        currency: 'NGN',
        active: true,
        assigned: true,
        provisioningStatus: 'active'
    });
    assertNoInternalFields(serialized);
});

test('pending virtual-account serialization retains state without recovery metadata', () => {
    const serialized = serializeVirtualAccount(accountFixture({
        accountNumber: undefined,
        active: false,
        assigned: false,
        provisioningStatus: 'pending',
        provisioningDispatchState: 'awaiting_assignment'
    }));

    assert.equal(serialized.provisioningStatus, 'pending');
    assert.equal(serialized.accountNumber, undefined);
    assertNoInternalFields(serialized);
});

test('failed virtual-account serialization retains state without provider failure details', () => {
    const serialized = serializeVirtualAccount(accountFixture({
        active: false,
        assigned: false,
        provisioningStatus: 'failed',
        provisioningFailure: 'raw provider response and retry context'
    }));

    assert.equal(serialized.provisioningStatus, 'failed');
    assert.equal(serialized.provisioningFailure, undefined);
    assertNoInternalFields(serialized);
});

test('profile serialization is a bare allowlisted user with safe virtual accounts', async () => {
    const user = {
        _id: 'user-1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+2348012345678',
        role: 'user',
        roles: ['user'],
        isPinSet: true,
        password: 'password-hash',
        otp: '123456',
        virtualAccounts: [accountFixture()],
        virtualAccountPreferences: { paystack: { consentGrantedAt: new Date() } },
        virtualAccountGatewaySnapshots: { paystack: { secretKey: 'sk_live_secret' } }
    };
    const res = makeRes();

    await withPatched([
        { target: virtualAccountService, key: 'provisionEligible', value: async () => ({}) },
        { target: User, key: 'findById', value: () => ({ select: async () => user }) }
    ], () => authController.profile({ user: { id: 'user-1' } }, res));

    assert.equal(res.body.name, 'Ada Lovelace');
    assert.equal(res.body.id, 'user-1');
    assert.equal(res.body.user, undefined);
    assert.equal(res.body.password, undefined);
    assert.equal(res.body.otp, undefined);
    assert.equal(res.body.virtualAccounts[0].accountNumber, '0123456789');
    assertNoInternalFields(res.body);
});

test('explicit provider-neutral provisioning does not expose pending account records', async () => {
    const res = makeRes();
    await withPatched([
        {
            target: virtualAccountService,
            key: 'provision',
            value: async () => ({
                status: 'pending',
                existing: false,
                accounts: [accountFixture({ provisioningStatus: 'pending' })]
            })
        }
    ], () => virtualAccountController.provisionVirtualAccount({
        user: { id: 'user-1' },
        params: { provider: 'paystack' },
        body: { consent: true }
    }, res));

    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.body.accounts, []);
    assertNoInternalFields(res.body);
});

test('explicit provider-neutral provisioning returns persisted rejection as failure', async () => {
    const res = makeRes();
    let request;
    await withPatched([
        {
            target: virtualAccountService,
            key: 'provision',
            value: async value => {
                request = value;
                return {
                    status: 'failed',
                    code: 'PAYSTACK_DVA_MERCHANT_RESTRICTED',
                    message: 'Paystack DVA access is not enabled for this merchant.',
                    existing: true,
                    accounts: [accountFixture({ provisioningStatus: 'failed' })]
                };
            }
        }
    ], () => virtualAccountController.provisionVirtualAccount({
        user: { id: 'user-1' },
        params: { provider: 'paystack' },
        body: { consent: true, retryRejected: true }
    }, res));

    assert.equal(request.retryRejected, true);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'PAYSTACK_DVA_MERCHANT_RESTRICTED');
    assertNoInternalFields(res.body);
});

test('legacy Monnify provisioning returns failure without exposing failed account records', async () => {
    const res = makeRes();
    await withPatched([
        {
            target: virtualAccountService,
            key: 'provision',
            value: async () => ({
                status: 'failed',
                existing: true,
                accounts: [accountFixture({ provider: 'monnify', provisioningStatus: 'failed' })]
            })
        }
    ], () => monnifyController.generateVirtualAccounts({
        user: { id: 'user-1' },
        body: { consent: true, consentVersion: 'permanent_virtual_account_v1' }
    }, res));

    assert.equal(res.statusCode, 422);
    assert.equal(res.body.success, false);
    assert.deepEqual(res.body.accounts, []);
    assertNoInternalFields(res.body);
});

test('admin user serialization excludes credentials, OTP data, and virtual-account internals', async () => {
    const rawUser = {
        _id: 'user-1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+2348012345678',
        role: 'user',
        status: true,
        balance: 2500,
        password: 'password-hash',
        passwordHistory: ['old-hash'],
        transactionPin: 'pin-hash',
        otp: '123456',
        passwordResetTokenDigest: 'reset-digest',
        virtualAccounts: [accountFixture()],
        virtualAccountGatewaySnapshots: { paystack: { secretKey: 'sk_live_secret' } }
    };
    const res = makeRes();

    await withPatched([
        { target: User, key: 'aggregate', value: async () => [rawUser] },
        { target: User, key: 'countDocuments', value: async () => 1 }
    ], () => adminController.getAllUsers({ query: {} }, res));

    const serialized = res.body.data.users[0];
    assert.deepEqual(serialized, serializeAdminUser(rawUser));
    assert.equal(serialized.balance, 2500);
    assert.equal(serialized.password, undefined);
    assert.equal(serialized.passwordHistory, undefined);
    assert.equal(serialized.transactionPin, undefined);
    assert.equal(serialized.otp, undefined);
    assert.equal(serialized.passwordResetTokenDigest, undefined);
    assertNoInternalFields(serialized);
});

test('pure profile serializer does not admit future user schema fields', () => {
    const serialized = serializeUserProfile({
        _id: 'user-1',
        name: 'Ada Lovelace',
        virtualAccounts: [],
        futureCredentialMaterial: 'must-not-leak'
    });

    assert.equal(serialized.futureCredentialMaterial, undefined);
});
