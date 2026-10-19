'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const MonnifyAdapter = require('../adapters/payment/monnify.adapter');
const { VirtualAccountService, VIRTUAL_ACCOUNT_CONSENT_VERSION } = require('../services/virtualAccount.service');

process.env.ONBOARDING_ENFORCEMENT_MODE = 'off';

const gateway = {
    _id: 'gateway-monnify',
    code: 'monnify',
    adapterType: 'monnify',
    status: 'active',
    environment: 'test',
    virtualAccountMutationVersion: 0,
    metadata: { contractCode: '1234567890' }
};

const user = {
    _id: '507f1f77bcf86cd799439011',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '08012345678',
    virtualAccounts: [],
    virtualAccountPreferences: {}
};

const v2Body = overrides => ({
    contractCode: gateway.metadata.contractCode,
    accountReference: `VIRTUAL_${user._id}`,
    accountName: user.name,
    currencyCode: 'NGN',
    customerEmail: user.email,
    customerName: user.name,
    reservationReference: 'MNFY-RESERVATION-1',
    reservedAccountType: 'GENERAL',
    status: 'ACTIVE',
    accounts: [
        {
            bankCode: '50515',
            bankName: 'Moniepoint Microfinance Bank',
            accountNumber: '9988776655',
            accountName: user.name
        },
        {
            bankCode: '035',
            bankName: 'Wema Bank',
            accountNumber: '1122334455',
            accountName: user.name
        }
    ],
    ...(overrides || {})
});

const makeAdapter = () => {
    const adapter = new MonnifyAdapter({
        code: 'monnify',
        environment: 'test',
        baseUrl: 'https://sandbox.monnify.com',
        publicKey: 'MK_TEST_KEY',
        secretKey: 'test-secret',
        metadata: gateway.metadata
    });
    adapter.getAccessToken = async () => 'sandbox-token';
    return adapter;
};

test('Monnify reserved-account creation uses V2, verified NIN, and preserves all returned banks', async t => {
    const originalPost = axios.post;
    t.after(() => { axios.post = originalPost; });
    let captured;
    axios.post = async (url, body, options) => {
        captured = { url, body, options };
        return {
            data: {
                requestSuccessful: true,
                responseBody: v2Body()
            }
        };
    };

    const adapter = makeAdapter();
    const result = await adapter.createReservedAccount({
        user,
        accountReference: `VIRTUAL_${user._id}`,
        verifiedIdentity: { verified: true, nin: '12345678901' }
    });

    assert.equal(captured.url, 'https://sandbox.monnify.com/api/v2/bank-transfer/reserved-accounts');
    assert.equal(captured.body.accountReference, `VIRTUAL_${user._id}`);
    assert.equal(captured.body.nin, '12345678901');
    assert.equal(captured.body.bvn, undefined);
    assert.equal(captured.body.getAllAvailableBanks, true);
    assert.equal(captured.options.headers.Authorization, 'Bearer sandbox-token');
    assert.equal(result.apiVersion, 'v2');
    assert.equal(result.accounts.length, 2);
    assert.equal(result.reservationReference, 'MNFY-RESERVATION-1');
    assert.equal(Object.hasOwn(result, 'bvn'), false);
    assert.equal(Object.hasOwn(result, 'nin'), false);
});

test('Monnify V2 lookup preserves ownership metadata and rejects V1 flat evidence', async t => {
    const originalGet = axios.get;
    t.after(() => { axios.get = originalGet; });
    const responses = [v2Body(), {
        accountReference: `VIRTUAL_${user._id}`,
        accountNumber: '9988776655',
        bankCode: '50515',
        bankName: 'Moniepoint Microfinance Bank'
    }];
    const urls = [];
    axios.get = async url => {
        urls.push(url);
        return {
            data: {
                requestSuccessful: true,
                responseBody: responses.shift()
            }
        };
    };

    const adapter = makeAdapter();
    const exact = await adapter.getReservedAccount(`VIRTUAL_${user._id}`);
    const flat = await adapter.getReservedAccount(`VIRTUAL_${user._id}`);

    assert.ok(urls.every(url => url.includes('/api/v2/bank-transfer/reserved-accounts/')));
    assert.equal(exact.contractCode, gateway.metadata.contractCode);
    assert.equal(exact.providerStatus, 'ACTIVE');
    assert.equal(exact.accounts.length, 2);
    assert.deepEqual(flat.accounts, []);
});

test('Monnify identity validation fails before token acquisition or provider dispatch', async t => {
    const originalPost = axios.post;
    t.after(() => { axios.post = originalPost; });
    let tokenCalls = 0;
    let postCalls = 0;
    axios.post = async () => { postCalls += 1; };
    const adapter = makeAdapter();
    adapter.getAccessToken = async () => { tokenCalls += 1; return 'token'; };

    await assert.rejects(
        adapter.createReservedAccount({
            user,
            accountReference: `VIRTUAL_${user._id}`,
            verifiedIdentity: { verified: false, bvn: '12345678901' }
        }),
        error => error.code === 'MONNIFY_IDENTITY_VERIFICATION_REQUIRED'
    );
    await assert.rejects(
        adapter.createReservedAccount({
            user,
            accountReference: `VIRTUAL_${user._id}`,
            verifiedIdentity: { verified: true, nin: '1234' }
        }),
        error => error.code === 'MONNIFY_IDENTITY_VERIFICATION_REQUIRED'
    );

    assert.equal(tokenCalls, 0);
    assert.equal(postCalls, 0);
});

test('real Monnify adapter is blocked before a claim when no approved identity service exists', async () => {
    const adapter = makeAdapter();
    let providerCalls = 0;
    let claimCalls = 0;
    adapter.getReservedAccount = async () => { providerCalls += 1; };
    adapter.createReservedAccount = async () => { providerCalls += 1; };
    const repository = {
        async getUser() { return user; },
        async listScope() { return []; },
        async listLegacyUnverified() { return []; },
        async claimProvisioning() { claimCalls += 1; return { claimed: false }; }
    };
    const service = new VirtualAccountService({
        repository,
        gatewayService: {
            async getGateway() { return gateway; },
            getAdapterInstance() { return adapter; }
        }
    });

    await assert.rejects(
        service.provision({
            userId: user._id,
            providerCode: 'monnify',
            consent: true,
            consentVersion: VIRTUAL_ACCOUNT_CONSENT_VERSION
        }),
        error => error.code === 'MONNIFY_IDENTITY_VERIFICATION_UNAVAILABLE'
    );

    assert.equal(claimCalls, 0);
    assert.equal(providerCalls, 0);
});

test('Monnify webhook normalization accepts the documented reserved-account product reference', () => {
    const adapter = makeAdapter();
    const normalized = adapter.normalizeWebhook({
        eventType: 'SUCCESSFUL_TRANSACTION',
        eventData: {
            transactionReference: 'MNFY|20261019|001',
            paymentReference: 'PAYMENT-001',
            amountPaid: 1500,
            currency: 'NGN',
            product: {
                type: 'RESERVED_ACCOUNT',
                reference: `VIRTUAL_${user._id}`
            },
            destinationAccountInformation: {
                bankCode: '50515',
                accountNumber: '9988776655'
            }
        }
    });

    assert.equal(normalized.virtualAccountReference, `VIRTUAL_${user._id}`);
    assert.equal(normalized.destinationAccountNumber, '9988776655');
    assert.equal(normalized.destinationBankCode, '50515');
    assert.equal(normalized.currency, 'NGN');
    assert.equal(normalized.reference, 'PAYMENT-001');
});

test('Monnify hosted checkout rejects a successful response without a trusted checkout URL', async t => {
    const originalPost = axios.post;
    t.after(() => { axios.post = originalPost; });
    axios.post = async () => ({
        data: {
            requestSuccessful: true,
            responseBody: { paymentReference: 'MONNIFY-23456789ABCDEFGH' }
        }
    });
    const adapter = makeAdapter();

    await assert.rejects(
        adapter.initializePayment({
            user,
            amount: 100,
            reference: 'MONNIFY-23456789ABCDEFGH'
        }),
        error => error.code === 'MONNIFY_INITIALIZATION_RESPONSE_INVALID'
    );
});
