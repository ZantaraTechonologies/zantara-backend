'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const PaystackAdapter = require('../adapters/payment/paystack.adapter');
const {
    VirtualAccountService,
    MongoVirtualAccountRepository,
    VIRTUAL_ACCOUNT_CONSENT_VERSION
} = require('../services/virtualAccount.service');
const User = require('../models/User');
const { normalizePaystackDvaError } = require('../utils/paystackDvaError');

const clone = value => JSON.parse(JSON.stringify(value));

class FakeVirtualAccountRepository {
    constructor(user) {
        this.user = clone(user);
        this.tokenCounter = 0;
        this.snapshots = {};
        this.failNextCompletion = false;
    }

    async getUser(userId) {
        return String(this.user._id) === String(userId) ? this.user : null;
    }

    async listScope(userId, provider, gatewayId) {
        if (String(this.user._id) !== String(userId)) return [];
        return this.user.virtualAccounts
            .filter(account => account.provider === provider && String(account.gatewayId) === String(gatewayId))
            .map(clone);
    }

    async listLegacyUnverified(userId) {
        if (String(this.user._id) !== String(userId)) return [];
        return this.user.virtualAccounts.filter(account => !account.provider && !!account.accountNumber).map(clone);
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
        if (String(this.user._id) !== String(userId)) return false;
        if (provisioningKey && this.user.virtualAccounts.some(account => account.provisioningKey === provisioningKey)) {
            return false;
        }
        this.user.virtualAccountPreferences = {
            ...(this.user.virtualAccountPreferences || {}),
            [provider]: { preferredBank, consentGrantedAt, consentVersion, consentChannel }
        };
        return true;
    }

    async savePaystackPreference(details) {
        return this.saveProviderPreference({ ...details, provider: 'paystack' });
    }

    async claimProvisioning({
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
        recoverIncompleteExpectedCount
    }) {
        if (String(this.user._id) !== String(userId)) return { claimed: false, token: null };
        let account = this.user.virtualAccounts.find(item => item.provisioningKey === provisioningKey);
        if (account && account.provisioningStatus === 'pending'
            && (!account.provisioningExpiresAt || new Date(account.provisioningExpiresAt) > new Date())) {
            return { claimed: false, token: null };
        }
        if (account?.provisioningStatus === 'failed'
            && account.provisioningFailureDisposition === 'definitive_rejection'
            && !retryRejected) {
            return { claimed: false, token: null };
        }
        if (account && account.provisioningStatus === 'active' && !recoverIncompleteExpectedCount) {
            return { claimed: false, token: null };
        }
        const token = `claim-${++this.tokenCounter}`;
        if (!account) {
            account = {
                provider,
                gatewayId: String(gatewayId),
                provisioningKey,
                preferredBank: preferredBank || '',
                ...(consentGrantedAt ? { consentGrantedAt, consentVersion, consentChannel } : {}),
                ...(provider === 'paystack' ? {
                    provisioningGatewayContext: gatewayContext,
                    provisioningDispatchState: 'not_started',
                    provisioningAttemptCount: 0
                } : {}),
                active: false,
                assigned: false
            };
            this.user.virtualAccounts.push(account);
        }
        Object.assign(account, {
            provisioningStatus: 'pending',
            provisioningToken: token,
            provisioningFailure: null,
            provisioningFailureCode: null,
            provisioningFailureDisposition: null,
            preferredBank: preferredBank || '',
            active: false,
            assigned: false,
            provisioningStartedAt: new Date(),
            provisioningExpiresAt: new Date(Date.now() + 15 * 60_000),
            ...(provider === 'paystack' ? { provisioningGatewayContext: gatewayContext } : {})
        });
        if (consentGrantedAt) {
            this.user.virtualAccountPreferences = {
                ...(this.user.virtualAccountPreferences || {}),
                [provider]: { preferredBank, consentGrantedAt, consentVersion, consentChannel }
            };
        }
        return { claimed: true, token };
    }

    async setProvisioningIdentity({ provisioningKey, token, customer, account: providerAccount }) {
        const account = this.user.virtualAccounts.find(item =>
            item.provisioningKey === provisioningKey && item.provisioningToken === token
        );
        if (!account) return false;
        account.providerCustomerId = customer.providerCustomerId;
        account.providerCustomerCode = customer.providerCustomerCode;
        if (providerAccount?.providerAccountId) account.providerAccountId = String(providerAccount.providerAccountId);
        if (providerAccount?.accountNumber) account.accountNumber = providerAccount.accountNumber;
        if (providerAccount?.bankSlug) account.bankSlug = providerAccount.bankSlug;
        return true;
    }

    async setPaystackDispatchState({ provisioningKey, token, state, message, code, disposition, incrementAttempt }) {
        const account = this.user.virtualAccounts.find(item =>
            item.provisioningKey === provisioningKey
            && item.provisioningToken === token
            && item.provisioningStatus === 'pending'
        );
        if (!account) return false;
        account.provisioningDispatchState = state;
        account.provisioningFailure = message || null;
        if (code !== undefined) account.provisioningFailureCode = code || null;
        if (disposition !== undefined) account.provisioningFailureDisposition = disposition || null;
        if (incrementAttempt) account.provisioningAttemptCount = Number(account.provisioningAttemptCount || 0) + 1;
        if (state === 'dispatching') account.provisioningLastDispatchAt = new Date();
        return true;
    }

    async completeProvisioning({ provider, gatewayId, provisioningKey, token, accounts, snapshotKey, snapshot }) {
        const placeholderIndex = this.user.virtualAccounts.findIndex(item =>
            item.provisioningKey === provisioningKey
            && item.provisioningToken === token
            && item.provisioningStatus === 'pending'
        );
        if (placeholderIndex < 0) {
            const error = new Error('claim lost');
            error.code = 'VIRTUAL_ACCOUNT_CLAIM_LOST';
            throw error;
        }
        if (this.failNextCompletion) {
            this.failNextCompletion = false;
            throw new Error('simulated atomic completion failure');
        }

        const placeholder = this.user.virtualAccounts[placeholderIndex];
        const completedAccounts = accounts.map(account => {
            const completed = {
                ...placeholder,
                ...account,
                provider,
                gatewayId: String(gatewayId),
                provisioningKey,
                provisioningStatus: 'active',
                provisioningDispatchState: provider === 'paystack' ? 'complete' : account.provisioningDispatchState,
                provisioningExpectedAccountCount: accounts.length,
                provisioningExpiresAt: null
            };
            delete completed.provisioningToken;
            return completed;
        });
        this.user.virtualAccounts = [
            ...this.user.virtualAccounts.filter(item => item.provisioningKey !== provisioningKey),
            ...completedAccounts
        ];
        if (snapshotKey) this.snapshots[snapshotKey] = snapshot;
        return this.listScope(this.user._id, provider, gatewayId);
    }

    async failProvisioning({ provisioningKey, token, message, code, disposition }) {
        const account = this.user.virtualAccounts.find(item =>
            item.provisioningKey === provisioningKey && item.provisioningToken === token
        );
        if (!account) return false;
        account.provisioningStatus = 'failed';
        account.provisioningFailure = message;
        account.provisioningFailureCode = code || null;
        account.provisioningFailureDisposition = disposition || null;
        account.active = false;
        account.assigned = false;
        delete account.provisioningToken;
        return true;
    }
}

const userFixture = overrides => ({
    _id: 'user-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '+2348012345678',
    virtualAccounts: [],
    ...overrides
});

const activePaystackAccount = overrides => ({
    bankName: 'Wema Bank',
    bankCode: '20',
    bankSlug: 'wema-bank',
    accountName: 'ZANTARA / ADA LOVELACE',
    accountNumber: '0123456789',
    currency: 'NGN',
    provider: 'paystack',
    gatewayId: 'gateway-paystack',
    accountReference: 'PAYSTACK_DVA_991',
    providerAccountId: '991',
    providerCustomerId: '81',
    providerCustomerCode: 'CUS_ada',
    provisioningKey: 'paystack:gateway-paystack',
    provisioningStatus: 'active',
    active: true,
    assigned: true,
    ...overrides
});

const activeMonnifyAccount = overrides => ({
    bankName: 'Moniepoint',
    accountName: 'Ada Lovelace',
    accountNumber: '9988776655',
    currency: 'NGN',
    provider: 'monnify',
    gatewayId: 'gateway-monnify',
    accountReference: 'VIRTUAL_user-1',
    provisioningKey: 'monnify:gateway-monnify',
    provisioningStatus: 'active',
    active: true,
    assigned: true,
    ...overrides
});

const paystackCustomer = overrides => ({
    providerCustomerId: '81',
    providerCustomerCode: 'CUS_ada',
    email: 'ada@example.com',
    dedicatedAccount: null,
    ...overrides
});

const paystackDvaResult = overrides => ({
    success: true,
    status: 'active',
    account: {
        providerAccountId: '991',
        accountName: 'ZANTARA / ADA LOVELACE',
        accountNumber: '0123456789',
        bankName: 'Wema Bank',
        bankCode: '20',
        bankSlug: 'wema-bank',
        currency: 'NGN',
        active: true,
        assigned: true,
        providerCustomerId: '81',
        providerCustomerCode: 'CUS_ada'
    },
    ...overrides
});

const makeGatewayService = ({
    paystackAdapter,
    monnifyAdapter,
    paystackEnvironment = 'live',
    monnifyStatus = 'active'
}) => {
    if (paystackAdapter && !paystackAdapter.getVirtualAccountCustomer) {
        paystackAdapter.getVirtualAccountCustomer = user => {
            const email = String(user?.email || '').trim().toLowerCase();
            const phone = String(user?.phone || '').trim();
            const names = String(user?.name || '').trim().split(/\s+/).filter(Boolean);
            if (!/^\S+@\S+\.\S+$/.test(email)) {
                const error = new Error('invalid email');
                error.code = 'PAYSTACK_CUSTOMER_EMAIL_INVALID';
                throw error;
            }
            if (phone.length < 7) {
                const error = new Error('invalid phone');
                error.code = 'PAYSTACK_CUSTOMER_PHONE_INVALID';
                throw error;
            }
            if (names.length < 2) {
                const error = new Error('incomplete name');
                error.code = 'PAYSTACK_CUSTOMER_NAME_INCOMPLETE';
                throw error;
            }
            return { email, phone, firstName: names[0], lastName: names.slice(1).join(' ') };
        };
    }
    if (monnifyAdapter && !monnifyAdapter.assertVirtualAccountCustomer) {
        monnifyAdapter.assertVirtualAccountCustomer = user => {
            if (!user?.email && !user?.phone) {
                const error = new Error('Email or phone is required for Monnify virtual-account provisioning');
                error.code = 'MONNIFY_CUSTOMER_DATA_INVALID';
                throw error;
            }
        };
    }
    const gateways = {
        paystack: {
            _id: 'gateway-paystack',
            code: 'paystack',
            adapterType: 'paystack',
            name: 'Paystack',
            status: 'active',
            environment: paystackEnvironment,
            secretKey: 'sk_test_fake'
        },
        monnify: {
            _id: 'gateway-monnify',
            code: 'monnify',
            adapterType: 'monnify',
            name: 'Monnify',
            status: monnifyStatus,
            secretKey: 'monnify-test'
        }
    };
    return {
        async getGateway(code) { return gateways[code] || null; },
        _isCustomerFundingEligible() { return true; },
        getAdapterInstance(gateway) {
            return gateway.adapterType === 'paystack' ? paystackAdapter : monnifyAdapter;
        },
        _snapshotGatewayConfig(gateway) { return { code: gateway.code, adapterType: gateway.adapterType }; }
    };
};

test('Paystack adapter constructs customer and DVA requests without a live API call', async () => {
    const originalPost = axios.post;
    const calls = [];
    axios.post = async (url, body, options) => {
        calls.push({ url, body, options });
        if (url.endsWith('/customer')) {
            return {
                data: {
                    status: true,
                    data: { id: 81, customer_code: 'CUS_ada', email: body.email, first_name: body.first_name, last_name: body.last_name, phone: body.phone }
                }
            };
        }
        return {
            data: {
                status: true,
                message: 'NUBAN successfully created',
                data: {
                    id: 991,
                    account_name: 'ZANTARA / ADA LOVELACE',
                    account_number: '0123456789',
                    currency: 'NGN',
                    active: true,
                    assigned: true,
                    bank: { id: 20, name: 'Wema Bank', slug: 'wema-bank' },
                    customer: { id: 81, customer_code: 'CUS_ada' }
                }
            }
        };
    };

    try {
        const adapter = new PaystackAdapter({ baseUrl: 'https://api.paystack.test', secretKey: 'sk_test_fake' });
        const customer = await adapter.createCustomer({
            email: 'ada@example.com',
            firstName: 'Ada',
            lastName: 'Lovelace',
            phone: '+2348012345678'
        });
        const dva = await adapter.createDedicatedVirtualAccount({
            customer: customer.providerCustomerCode,
            preferredBank: 'wema-bank',
            firstName: 'Ada',
            lastName: 'Lovelace',
            phone: '+2348012345678'
        });

        assert.deepEqual(calls[0].body, {
            email: 'ada@example.com',
            first_name: 'Ada',
            last_name: 'Lovelace',
            phone: '+2348012345678'
        });
        assert.deepEqual(calls[1].body, {
            customer: 'CUS_ada',
            preferred_bank: 'wema-bank',
            first_name: 'Ada',
            last_name: 'Lovelace',
            phone: '+2348012345678'
        });
        assert.equal(calls[1].options.headers.Authorization, 'Bearer sk_test_fake');
        assert.equal(dva.status, 'active');
        assert.equal(dva.account.providerAccountId, '991');
    } finally {
        axios.post = originalPost;
    }
});

test('User virtual-account schema exposes the minimum Paystack identity and provisioning fields', () => {
    const virtualAccountSchema = User.schema.path('virtualAccounts').schema;
    for (const field of [
        'providerAccountId',
        'providerCustomerId',
        'providerCustomerCode',
        'bankSlug',
        'provisioningKey',
        'provisioningStatus',
        'provisioningGatewayContext',
        'provisioningDispatchState',
        'provisioningAttemptCount',
        'provisioningLastDispatchAt',
        'provisioningExpiresAt',
        'provisioningExpectedAccountCount',
        'provisioningFailureCode',
        'provisioningFailureDisposition',
        'consentGrantedAt'
    ]) {
        assert.ok(virtualAccountSchema.path(field), `virtualAccounts.${field} must exist`);
    }
    assert.deepEqual(
        virtualAccountSchema.path('provisioningStatus').enumValues,
        ['pending', 'active', 'failed']
    );
    assert.deepEqual(
        virtualAccountSchema.path('provisioningDispatchState').enumValues,
        ['not_started', 'customer_creating', 'customer_ready', 'dispatching', 'awaiting_assignment', 'reconciling', 'retryable', 'rejected', 'complete']
    );
});

test('Paystack provisioning creates a customer only when no reusable customer exists', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let fetchCalls = 0;
    let createCustomerCalls = 0;
    let createDvaCalls = 0;
    const adapter = {
        async fetchCustomer(identifier) {
            fetchCalls++;
            assert.equal(identifier, 'ada@example.com');
            return null;
        },
        async createCustomer(data) {
            createCustomerCalls++;
            assert.deepEqual(data, { email: 'ada@example.com', phone: '+2348012345678', firstName: 'Ada', lastName: 'Lovelace' });
            return paystackCustomer();
        },
        async createDedicatedVirtualAccount(request) {
            createDvaCalls++;
            assert.equal(request.customer, 'CUS_ada');
            assert.equal(request.preferredBank, 'wema-bank');
            return paystackDvaResult();
        }
    };
    const service = new VirtualAccountService({
        repository,
        gatewayService: makeGatewayService({ paystackAdapter: adapter })
    });

    const result = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });

    assert.equal(result.status, 'active');
    assert.equal(fetchCalls, 1);
    assert.equal(createCustomerCalls, 1);
    assert.equal(createDvaCalls, 1);
    assert.equal(repository.user.virtualAccounts.length, 1);
    assert.equal(repository.user.virtualAccounts[0].providerCustomerCode, 'CUS_ada');
});

test('Paystack provisioning reuses an existing customer and does not recreate it', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let createCustomerCalls = 0;
    const adapter = {
        async fetchCustomer(identifier) {
            assert.equal(identifier, 'ada@example.com');
            return paystackCustomer();
        },
        async createCustomer() { createCustomerCalls++; return paystackCustomer(); },
        async createDedicatedVirtualAccount() { return paystackDvaResult(); }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });
    assert.equal(createCustomerCalls, 0);
});

test('aliased gateway codes remain usable for payments but cannot provision virtual accounts', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let adapterCalls = 0;
    const paystackAdapter = {
        getVirtualAccountCustomer() { adapterCalls++; },
        async fetchCustomer() { adapterCalls++; return paystackCustomer(); },
        async createDedicatedVirtualAccount() { adapterCalls++; return paystackDvaResult(); }
    };
    const gatewayService = makeGatewayService({ paystackAdapter });
    gatewayService.getGateway = async code => code === 'paystack_secondary' ? {
        _id: 'gateway-paystack-secondary',
        code: 'paystack_secondary',
        adapterType: 'paystack',
        name: 'Paystack Secondary',
        status: 'active',
        environment: 'live',
        secretKey: 'sk_test_alias'
    } : null;
    const service = new VirtualAccountService({ repository, gatewayService });

    await assert.rejects(
        service.provision({
            userId: 'user-1',
            providerCode: 'paystack_secondary',
            preferredBank: 'wema-bank',
            consent: true
        }),
        error => error.code === 'VIRTUAL_ACCOUNT_GATEWAY_ALIAS_UNSUPPORTED' && error.httpStatus === 409
    );
    assert.equal(adapterCalls, 0);
    assert.deepEqual(repository.user.virtualAccounts, []);
});

test('legacy account already bound to an alias remains retrievable without new provisioning', async () => {
    const existing = activePaystackAccount({
        gatewayId: 'gateway-paystack-secondary',
        provisioningKey: 'paystack:gateway-paystack-secondary'
    });
    const repository = new FakeVirtualAccountRepository(userFixture({ virtualAccounts: [existing] }));
    let adapterCalls = 0;
    const gatewayService = makeGatewayService({ paystackAdapter: {} });
    gatewayService.getGateway = async code => code === 'paystack_secondary' ? {
        _id: 'gateway-paystack-secondary',
        code: 'paystack_secondary',
        adapterType: 'paystack',
        name: 'Paystack Secondary',
        status: 'inactive',
        environment: 'live',
        secretKey: 'sk_test_alias'
    } : null;
    gatewayService.getAdapterInstance = () => {
        adapterCalls++;
        return {};
    };
    const service = new VirtualAccountService({ repository, gatewayService });

    const result = await service.provision({
        userId: 'user-1',
        providerCode: 'paystack_secondary',
        preferredBank: 'wema-bank',
        consent: true
    });

    assert.equal(result.status, 'active');
    assert.equal(result.existing, true);
    assert.equal(adapterCalls, 0);
    assert.equal(result.accounts[0].accountNumber, existing.accountNumber);
});

test('adding Paystack preserves every existing Monnify account', async () => {
    const monnifyAccounts = [
        activeMonnifyAccount(),
        activeMonnifyAccount({ bankName: 'Wema Bank', accountNumber: '1122334455' })
    ];
    const repository = new FakeVirtualAccountRepository(userFixture({ virtualAccounts: monnifyAccounts }));
    const paystackAdapter = {
        async fetchCustomer() { return paystackCustomer(); },
        async createCustomer() { throw new Error('must reuse customer'); },
        async createDedicatedVirtualAccount() { return paystackDvaResult(); }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter }) });

    await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });

    const retained = repository.user.virtualAccounts.filter(account => account.provider === 'monnify');
    assert.deepEqual(retained, monnifyAccounts);
    assert.equal(repository.user.virtualAccounts.filter(account => account.provider === 'paystack').length, 1);
});

test('adding Monnify preserves an existing Paystack DVA', async () => {
    const paystackAccount = activePaystackAccount();
    const repository = new FakeVirtualAccountRepository(userFixture({ virtualAccounts: [paystackAccount] }));
    const monnifyAdapter = {
        async createReservedAccount() {
            return {
                status: true,
                accountReference: 'VIRTUAL_user-1',
                accounts: [{ bankName: 'Moniepoint', bankCode: '50515', accountName: 'Ada Lovelace', accountNumber: '9988776655' }]
            };
        }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ monnifyAdapter }) });

    await service.provision({ userId: 'user-1', providerCode: 'monnify', consent: true });

    assert.deepEqual(repository.user.virtualAccounts.find(account => account.provider === 'paystack'), paystackAccount);
    assert.equal(repository.user.virtualAccounts.filter(account => account.provider === 'monnify').length, 1);
});

test('Monnify multi-bank completion remains all-or-nothing and recovers after persistence failure', async () => {
    const paystackAccount = activePaystackAccount();
    const repository = new FakeVirtualAccountRepository(userFixture({ virtualAccounts: [paystackAccount] }));
    repository.failNextCompletion = true;
    const providerResult = {
        status: true,
        accountReference: 'VIRTUAL_user-1',
        accounts: [
            { bankName: 'Moniepoint', bankCode: '50515', accountName: 'Ada Lovelace', accountNumber: '9988776655' },
            { bankName: 'Wema Bank', bankCode: '035', accountName: 'Ada Lovelace', accountNumber: '1122334455' }
        ]
    };
    let createCalls = 0;
    let recoveryReads = 0;
    const monnifyAdapter = {
        async createReservedAccount() {
            createCalls++;
            return providerResult;
        },
        async getReservedAccount(reference) {
            recoveryReads++;
            assert.equal(reference, 'VIRTUAL_user-1');
            if (recoveryReads === 1) {
                const error = new Error('Reserved account not found');
                error.response = { status: 404 };
                throw error;
            }
            return providerResult;
        }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ monnifyAdapter }) });

    await assert.rejects(
        service.provision({ userId: 'user-1', providerCode: 'monnify', consent: true }),
        /simulated atomic completion failure/
    );
    assert.equal(repository.user.virtualAccounts.filter(account => account.provider === 'monnify' && account.provisioningStatus === 'active').length, 0);
    assert.deepEqual(repository.user.virtualAccounts.find(account => account.provider === 'paystack'), paystackAccount);

    const recovered = await service.provision({ userId: 'user-1', providerCode: 'monnify', consent: true });
    assert.equal(recovered.status, 'active');
    assert.equal(createCalls, 1);
    assert.equal(recoveryReads, 2);
    assert.deepEqual(
        repository.user.virtualAccounts
            .filter(account => account.provider === 'monnify')
            .map(account => account.accountNumber)
            .sort(),
        ['1122334455', '9988776655']
    );
    assert.ok(repository.user.virtualAccounts
        .filter(account => account.provider === 'monnify')
        .every(account => account.provisioningExpectedAccountCount === 2));
    assert.deepEqual(repository.user.virtualAccounts.find(account => account.provider === 'paystack'), paystackAccount);
});

test('Mongo completion replaces the entire provider operation in one atomic update pipeline', async () => {
    const calls = [];
    const UserModel = {
        async findOneAndUpdate(...args) {
            calls.push(args);
            return { _id: 'user-1' };
        }
    };
    const repository = new MongoVirtualAccountRepository(UserModel);
    repository.listScope = async () => [];

    await repository.completeProvisioning({
        userId: 'user-1',
        provider: 'monnify',
        gatewayId: 'gateway-monnify',
        provisioningKey: 'monnify:gateway-monnify',
        token: 'claim-token',
        accounts: [
            { bankName: 'Moniepoint', accountNumber: '9988776655', active: true, assigned: true },
            { bankName: 'Wema Bank', accountNumber: '1122334455', active: true, assigned: true }
        ],
        snapshotKey: 'VIRTUAL_user-1',
        snapshot: { gatewayId: 'gateway-monnify', code: 'monnify', adapterType: 'monnify' }
    });

    assert.equal(calls.length, 1);
    const [filter, update] = calls[0];
    assert.equal(filter.virtualAccounts.$elemMatch.provisioningToken, 'claim-token');
    assert.equal(Array.isArray(update), true);
    const replacement = update[0].$set.virtualAccounts.$concatArrays[1].$literal;
    assert.equal(replacement.length, 2);
    assert.ok(replacement.every(account => account.provisioningExpectedAccountCount === 2));
    assert.ok(replacement.every(account => account.provisioningStatus === 'active'));
});

test('Monnify detects and atomically repairs an incomplete persisted multi-bank set', async () => {
    const paystackAccount = activePaystackAccount();
    const partialMonnify = activeMonnifyAccount({ provisioningExpectedAccountCount: 2 });
    const repository = new FakeVirtualAccountRepository(userFixture({
        virtualAccounts: [paystackAccount, partialMonnify]
    }));
    const providerResult = {
        status: true,
        accountReference: 'VIRTUAL_user-1',
        accounts: [
            { bankName: 'Moniepoint', bankCode: '50515', accountName: 'Ada Lovelace', accountNumber: '9988776655' },
            { bankName: 'Wema Bank', bankCode: '035', accountName: 'Ada Lovelace', accountNumber: '1122334455' }
        ]
    };
    const monnifyAdapter = {
        async createReservedAccount() { throw new Error('Account reference already exists for same reference'); },
        async getReservedAccount() { return providerResult; }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ monnifyAdapter }) });

    const recovered = await service.provision({ userId: 'user-1', providerCode: 'monnify', consent: true });

    assert.equal(recovered.status, 'active');
    assert.equal(repository.user.virtualAccounts.filter(account => account.provider === 'monnify').length, 2);
    assert.deepEqual(repository.user.virtualAccounts.find(account => account.provider === 'paystack'), paystackAccount);
});

test('malformed Monnify creation evidence is reconciled without repeating the mutation', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let createCalls = 0;
    const monnifyAdapter = {
        async getReservedAccount() {
            const error = new Error('Reserved account not found');
            error.response = { status: 404 };
            throw error;
        },
        async createReservedAccount() {
            createCalls++;
            return {
                status: true,
                accountReference: 'VIRTUAL_user-1',
                accounts: [{ bankName: 'Moniepoint', bankCode: '50515', accountNumber: '' }]
            };
        }
    };
    const service = new VirtualAccountService({
        repository,
        gatewayService: makeGatewayService({ monnifyAdapter })
    });

    const result = await service.provision({
        userId: 'user-1',
        providerCode: 'monnify',
        consent: true
    });

    assert.equal(result.status, 'pending');
    assert.equal(result.state, 'reconciliation_required');
    assert.equal(createCalls, 1);
    assert.equal(repository.user.virtualAccounts[0].provisioningStatus, 'pending');
    assert.equal(repository.user.virtualAccounts[0].provisioningDispatchState, 'reconciling');
    assert.equal(repository.user.virtualAccounts[0].provisioningFailureDisposition, 'ambiguous_mutation');
});

test('Monnify duplicate-reference rejection reconciles by exact reference before classification', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    const providerResult = {
        status: true,
        accountReference: 'VIRTUAL_user-1',
        accounts: [{
            bankName: 'Moniepoint',
            bankCode: '50515',
            accountName: 'Ada Lovelace',
            accountNumber: '9988776655'
        }]
    };
    let reads = 0;
    let creates = 0;
    const notFound = () => {
        const error = new Error('not found');
        error.response = { status: 404 };
        return error;
    };
    const monnifyAdapter = {
        async getReservedAccount() {
            reads += 1;
            if (reads === 1) throw notFound();
            return providerResult;
        },
        async createReservedAccount() {
            creates += 1;
            const error = new Error('Account reference already used');
            error.response = { status: 400 };
            error.requestDispatched = true;
            throw error;
        }
    };
    const service = new VirtualAccountService({
        repository,
        gatewayService: makeGatewayService({ monnifyAdapter })
    });

    const result = await service.provision({ userId: 'user-1', providerCode: 'monnify', consent: true });

    assert.equal(result.status, 'active');
    assert.equal(reads, 2);
    assert.equal(creates, 1);
    assert.equal(repository.user.virtualAccounts[0].provisioningAttemptCount, 1);
    assert.equal(repository.user.virtualAccounts[0].provisioningDispatchState, 'complete');
});

test('Monnify duplicate-reference ambiguity never blindly repeats account creation', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let reads = 0;
    let creates = 0;
    const monnifyAdapter = {
        async getReservedAccount() {
            reads += 1;
            const error = new Error('not found');
            error.response = { status: 404 };
            throw error;
        },
        async createReservedAccount() {
            creates += 1;
            const error = new Error('Account reference already exists');
            error.response = { status: 400 };
            error.requestDispatched = true;
            throw error;
        }
    };
    const service = new VirtualAccountService({
        repository,
        gatewayService: makeGatewayService({ monnifyAdapter })
    });

    const first = await service.provision({ userId: 'user-1', providerCode: 'monnify', consent: true });
    repository.user.virtualAccounts[0].provisioningExpiresAt = new Date(Date.now() - 1000);
    const second = await service.provision({ userId: 'user-1', providerCode: 'monnify', consent: true });

    assert.equal(first.state, 'reconciliation_required');
    assert.equal(second.state, 'reconciliation_required');
    assert.equal(creates, 1);
    assert.equal(reads, 3);
});

test('repeated Paystack provisioning returns the provider-scoped account without another provider call', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let dvaCalls = 0;
    const adapter = {
        async fetchCustomer() { return paystackCustomer(); },
        async createCustomer() { throw new Error('must reuse customer'); },
        async createDedicatedVirtualAccount() { dvaCalls++; return paystackDvaResult(); }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    const first = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });
    const second = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });

    assert.equal(first.existing, false);
    assert.equal(second.existing, true);
    assert.equal(dvaCalls, 1);
    assert.equal(repository.user.virtualAccounts.length, 1);
});

test('Paystack failure marks only its provisioning record and never deletes Monnify', async () => {
    const monnify = activeMonnifyAccount();
    const repository = new FakeVirtualAccountRepository(userFixture({ virtualAccounts: [monnify] }));
    const adapter = {
        async fetchCustomer() { return paystackCustomer(); },
        async createCustomer() { throw new Error('must reuse customer'); },
        async createDedicatedVirtualAccount() {
            const error = new Error('provider rejected request');
            error.response = { status: 400 };
            throw error;
        }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    await assert.rejects(
        service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true }),
        /provider rejected request/
    );

    assert.deepEqual(repository.user.virtualAccounts.find(account => account.provider === 'monnify'), monnify);
    const failed = repository.user.virtualAccounts.find(account => account.provider === 'paystack');
    assert.equal(failed.provisioningStatus, 'failed');
    assert.equal(failed.provisioningDispatchState, 'retryable');
    assert.equal(failed.accountNumber, undefined);
});

test('definitive Paystack assignment rejection is safely retryable without duplicating the account', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let dvaCalls = 0;
    const adapter = {
        async fetchCustomer() { return paystackCustomer(); },
        async createCustomer() { throw new Error('must reuse customer'); },
        async createDedicatedVirtualAccount() {
            dvaCalls++;
            if (dvaCalls === 1) {
                const error = new Error('provider rejected request before assignment');
                error.response = { status: 400 };
                throw error;
            }
            return paystackDvaResult();
        }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    await assert.rejects(
        service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true }),
        /provider rejected request before assignment/
    );
    assert.equal(repository.user.virtualAccounts[0].provisioningDispatchState, 'retryable');

    const recovered = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });
    assert.equal(recovered.status, 'active');
    assert.equal(dvaCalls, 2);
    assert.equal(repository.user.virtualAccounts.filter(account => account.provider === 'paystack').length, 1);
});

test('classified definitive Paystack rejection is persisted and not automatically retried', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let dvaCalls = 0;
    const adapter = {
        async fetchCustomer() { return paystackCustomer(); },
        async createCustomer() { throw new Error('must reuse customer'); },
        async createDedicatedVirtualAccount() {
            dvaCalls++;
            if (dvaCalls === 1) {
                throw normalizePaystackDvaError({
                    response: {
                        status: 403,
                        data: { message: 'Dedicated accounts are not enabled for this business' }
                    }
                }, { operation: 'create_dedicated_account', mutation: true });
            }
            return paystackDvaResult();
        }
    };
    const service = new VirtualAccountService({
        repository,
        gatewayService: makeGatewayService({ paystackAdapter: adapter })
    });

    await assert.rejects(
        service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true }),
        error => error.code === 'PAYSTACK_DVA_MERCHANT_RESTRICTED'
            && error.paystackDvaDisposition === 'definitive_rejection'
    );
    const failed = repository.user.virtualAccounts[0];
    assert.equal(failed.provisioningStatus, 'failed');
    assert.equal(failed.provisioningDispatchState, 'rejected');
    assert.equal(failed.provisioningFailureCode, 'PAYSTACK_DVA_MERCHANT_RESTRICTED');
    assert.equal(failed.provisioningFailureDisposition, 'definitive_rejection');

    const repeated = await service.provision({
        userId: 'user-1',
        providerCode: 'paystack',
        preferredBank: 'wema-bank',
        consent: true
    });
    assert.equal(repeated.status, 'failed');
    assert.equal(repeated.code, 'PAYSTACK_DVA_MERCHANT_RESTRICTED');
    assert.equal(repeated.existing, true);
    assert.equal(dvaCalls, 1);

    const explicitlyRetried = await service.provision({
        userId: 'user-1',
        providerCode: 'paystack',
        preferredBank: 'wema-bank',
        consent: true,
        retryRejected: true
    });
    assert.equal(explicitlyRetried.status, 'active');
    assert.equal(dvaCalls, 2);
});

test('explicit pre-dispatch customer rejection can be safely retried', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let customerCreates = 0;
    let dvaCalls = 0;
    const adapter = {
        async fetchCustomer() { return null; },
        async createCustomer() {
            customerCreates++;
            if (customerCreates === 1) {
                const error = new Error('customer request rejected');
                error.response = { status: 400 };
                throw error;
            }
            return paystackCustomer();
        },
        async createDedicatedVirtualAccount() { dvaCalls++; return paystackDvaResult(); }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    await assert.rejects(
        service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true }),
        /customer request rejected/
    );
    assert.equal(repository.user.virtualAccounts[0].provisioningStatus, 'failed');
    assert.equal(repository.user.virtualAccounts[0].provisioningDispatchState, 'retryable');

    const recovered = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });
    assert.equal(recovered.status, 'active');
    assert.equal(customerCreates, 2);
    assert.equal(dvaCalls, 1);
});

test('expired Paystack lease is atomically reclaimed and resumes the original operation', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture({
        virtualAccounts: [{
            provider: 'paystack',
            gatewayId: 'gateway-paystack',
            provisioningKey: 'paystack:gateway-paystack',
            provisioningStatus: 'pending',
            provisioningDispatchState: 'not_started',
            provisioningToken: 'expired-token',
            provisioningExpiresAt: new Date(Date.now() - 1000),
            preferredBank: 'wema-bank',
            active: false,
            assigned: false
        }]
    }));
    let dvaCalls = 0;
    const adapter = {
        async fetchCustomer() { return paystackCustomer(); },
        async createCustomer() { throw new Error('customer must be reused'); },
        async createDedicatedVirtualAccount() { dvaCalls++; return paystackDvaResult(); }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    const result = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });

    assert.equal(result.status, 'active');
    assert.equal(dvaCalls, 1);
    assert.equal(repository.user.virtualAccounts.length, 1);
    assert.equal(repository.user.virtualAccounts[0].provisioningDispatchState, 'complete');
});

test('application restart reconciles an interrupted DVA dispatch without creating another DVA', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture({
        virtualAccounts: [{
            provider: 'paystack',
            gatewayId: 'gateway-paystack',
            provisioningKey: 'paystack:gateway-paystack',
            provisioningStatus: 'pending',
            provisioningDispatchState: 'dispatching',
            provisioningToken: 'crashed-worker',
            provisioningExpiresAt: new Date(Date.now() - 1000),
            providerCustomerId: '81',
            providerCustomerCode: 'CUS_ada',
            preferredBank: 'wema-bank',
            active: false,
            assigned: false
        }]
    }));
    let dvaCalls = 0;
    const adapter = {
        async fetchCustomer(identifier) {
            assert.equal(identifier, 'CUS_ada');
            return paystackCustomer({ dedicatedAccount: paystackDvaResult().account });
        },
        async createCustomer() { throw new Error('must not recreate customer'); },
        async createDedicatedVirtualAccount() { dvaCalls++; return paystackDvaResult(); }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    const result = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });

    assert.equal(result.status, 'active');
    assert.equal(dvaCalls, 0);
    assert.equal(repository.user.virtualAccounts[0].accountNumber, '0123456789');
});

test('recovery uses the persisted provider account ID when customer lookup omits the DVA', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture({
        virtualAccounts: [{
            provider: 'paystack',
            gatewayId: 'gateway-paystack',
            provisioningKey: 'paystack:gateway-paystack',
            provisioningStatus: 'pending',
            provisioningDispatchState: 'awaiting_assignment',
            provisioningAttemptCount: 1,
            provisioningToken: 'expired-token',
            provisioningExpiresAt: new Date(Date.now() - 1000),
            providerCustomerId: '81',
            providerCustomerCode: 'CUS_ada',
            providerAccountId: '991',
            preferredBank: 'wema-bank',
            active: false,
            assigned: false
        }]
    }));
    let accountReads = 0;
    let dvaCalls = 0;
    const adapter = {
        async fetchCustomer() { return paystackCustomer(); },
        async fetchDedicatedVirtualAccount(id) {
            accountReads++;
            assert.equal(id, '991');
            return paystackDvaResult().account;
        },
        async createCustomer() { throw new Error('must reuse customer'); },
        async createDedicatedVirtualAccount() { dvaCalls++; return paystackDvaResult(); }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    const result = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });

    assert.equal(result.status, 'active');
    assert.equal(accountReads, 1);
    assert.equal(dvaCalls, 0);
});

test('retry after a confirmed failed assignment safely issues one replacement DVA request', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture({
        virtualAccounts: [{
            provider: 'paystack',
            gatewayId: 'gateway-paystack',
            provisioningKey: 'paystack:gateway-paystack',
            provisioningStatus: 'failed',
            provisioningDispatchState: 'retryable',
            providerCustomerId: '81',
            providerCustomerCode: 'CUS_ada',
            preferredBank: 'wema-bank',
            provisioningFailure: 'Unable to assign dedicated account',
            active: false,
            assigned: false
        }]
    }));
    let dvaCalls = 0;
    const adapter = {
        async fetchCustomer(identifier) { assert.equal(identifier, 'CUS_ada'); return paystackCustomer(); },
        async createCustomer() { throw new Error('must reuse customer'); },
        async createDedicatedVirtualAccount() { dvaCalls++; return paystackDvaResult(); }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    const result = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });

    assert.equal(result.status, 'active');
    assert.equal(dvaCalls, 1);
    assert.equal(repository.user.virtualAccounts.length, 1);
    assert.equal(repository.user.virtualAccounts[0].provisioningDispatchState, 'complete');
});

test('timeout recovery reconciles provider state and never repeats the mutating DVA request', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let customerReads = 0;
    let dvaCalls = 0;
    const adapter = {
        async fetchCustomer() {
            customerReads++;
            return customerReads === 1
                ? paystackCustomer()
                : paystackCustomer({ dedicatedAccount: paystackDvaResult().account });
        },
        async createCustomer() { throw new Error('must reuse customer'); },
        async createDedicatedVirtualAccount() {
            dvaCalls++;
            const error = new Error('request timed out after dispatch');
            error.code = 'ECONNABORTED';
            throw error;
        }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    const first = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });
    assert.equal(first.status, 'pending');
    assert.equal(first.accounts[0].provisioningToken, undefined);
    assert.equal(first.accounts[0].provisioningGatewayContext, undefined);
    assert.equal(first.accounts[0].provisioningDispatchState, undefined);
    assert.equal(repository.user.virtualAccounts[0].provisioningDispatchState, 'awaiting_assignment');
    const inFlightRetry = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });
    assert.equal(inFlightRetry.status, 'pending');
    assert.equal(dvaCalls, 1);
    repository.user.virtualAccounts[0].provisioningExpiresAt = new Date(Date.now() - 1000);

    const recovered = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });

    assert.equal(recovered.status, 'active');
    assert.equal(dvaCalls, 1);
    assert.equal(repository.user.virtualAccounts.length, 1);
});

test('duplicate concurrent retries of an expired pre-dispatch operation produce one Paystack request', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture({
        virtualAccounts: [{
            provider: 'paystack',
            gatewayId: 'gateway-paystack',
            provisioningKey: 'paystack:gateway-paystack',
            provisioningStatus: 'pending',
            provisioningDispatchState: 'not_started',
            provisioningToken: 'expired-token',
            provisioningExpiresAt: new Date(Date.now() - 1000),
            providerCustomerId: '81',
            providerCustomerCode: 'CUS_ada',
            preferredBank: 'wema-bank',
            active: false,
            assigned: false
        }]
    }));
    let dvaCalls = 0;
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const adapter = {
        async fetchCustomer() { return paystackCustomer(); },
        async createCustomer() { throw new Error('must reuse customer'); },
        async createDedicatedVirtualAccount() { dvaCalls++; await wait; return paystackDvaResult(); }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    const first = service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });
    await new Promise(resolve => setImmediate(resolve));
    const second = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });
    release();
    const completed = await first;

    assert.equal(second.status, 'pending');
    assert.equal(completed.status, 'active');
    assert.equal(dvaCalls, 1);
    assert.equal(repository.user.virtualAccounts.length, 1);
});

test('already-provisioned Paystack account is returned without customer lookup or replacement', async () => {
    const original = activePaystackAccount();
    const repository = new FakeVirtualAccountRepository(userFixture({ virtualAccounts: [original] }));
    let providerCalls = 0;
    const adapter = {
        async fetchCustomer() { providerCalls++; return null; },
        async createCustomer() { providerCalls++; return null; },
        async createDedicatedVirtualAccount() { providerCalls++; return null; }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    const result = await service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });

    assert.equal(result.status, 'active');
    assert.equal(result.existing, true);
    assert.equal(providerCalls, 0);
    assert.deepEqual(repository.user.virtualAccounts[0], original);
});

test('concurrent Paystack provisioning obtains one claim and makes one DVA request', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let dvaCalls = 0;
    let release;
    const providerWait = new Promise(resolve => { release = resolve; });
    const adapter = {
        async fetchCustomer() { return paystackCustomer(); },
        async createCustomer() { throw new Error('must reuse customer'); },
        async createDedicatedVirtualAccount() {
            dvaCalls++;
            await providerWait;
            return paystackDvaResult();
        }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    const first = service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });
    await new Promise(resolve => setImmediate(resolve));
    const second = service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true });
    const secondResult = await second;
    release();
    const firstResult = await first;

    assert.equal(secondResult.status, 'pending');
    assert.equal(firstResult.status, 'active');
    assert.equal(dvaCalls, 1);
    assert.equal(repository.user.virtualAccounts.filter(account => account.provider === 'paystack').length, 1);
});

test('concurrent Paystack requests with different banks preserve the winning claim preference', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let dvaCalls = 0;
    let release;
    const providerWait = new Promise(resolve => { release = resolve; });
    const adapter = {
        async fetchCustomer() { return paystackCustomer(); },
        async createCustomer() { throw new Error('must reuse customer'); },
        async createDedicatedVirtualAccount(request) {
            dvaCalls++;
            assert.equal(request.preferredBank, 'wema-bank');
            await providerWait;
            return paystackDvaResult();
        }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    const winner = service.provision({
        userId: 'user-1',
        providerCode: 'paystack',
        preferredBank: 'wema-bank',
        consent: true
    });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(
        service.provision({
            userId: 'user-1',
            providerCode: 'paystack',
            preferredBank: 'titan-paystack',
            consent: true
        }),
        error => error.code === 'PAYSTACK_DVA_RECOVERY_BANK_MISMATCH' && error.httpStatus === 409
    );
    release();
    await winner;

    assert.equal(dvaCalls, 1);
    assert.equal(repository.user.virtualAccountPreferences.paystack.preferredBank, 'wema-bank');
    assert.equal(repository.user.virtualAccounts[0].preferredBank, 'wema-bank');
});

test('inactive Monnify gateway returns existing accounts without provider access', async () => {
    const existing = activeMonnifyAccount();
    const repository = new FakeVirtualAccountRepository(userFixture({ virtualAccounts: [existing] }));
    let providerCalls = 0;
    const monnifyAdapter = {
        assertVirtualAccountCustomer() { providerCalls++; },
        async createReservedAccount() { providerCalls++; return null; }
    };
    const service = new VirtualAccountService({
        repository,
        gatewayService: makeGatewayService({ monnifyAdapter, monnifyStatus: 'maintenance' })
    });

    const result = await service.provision({ userId: 'user-1', providerCode: 'monnify' });

    assert.equal(result.status, 'active');
    assert.equal(result.existing, true);
    assert.equal(providerCalls, 0);
    assert.deepEqual(repository.user.virtualAccounts[0], existing);
});

test('inactive Monnify gateway still blocks new provisioning', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let providerCalls = 0;
    const monnifyAdapter = {
        assertVirtualAccountCustomer() { providerCalls++; },
        async createReservedAccount() { providerCalls++; return null; }
    };
    const service = new VirtualAccountService({
        repository,
        gatewayService: makeGatewayService({ monnifyAdapter, monnifyStatus: 'inactive' })
    });

    await assert.rejects(
        service.provision({ userId: 'user-1', providerCode: 'monnify' }),
        error => error.code === 'VIRTUAL_ACCOUNT_GATEWAY_INACTIVE' && error.httpStatus === 503
    );
    assert.equal(providerCalls, 0);
    assert.equal(repository.user.virtualAccounts.length, 0);
});

test('invalid or incomplete Paystack customer data fails before provider access', async t => {
    const cases = [
        ['missing email', { email: '' }, 'PAYSTACK_CUSTOMER_EMAIL_INVALID'],
        ['single name', { name: 'Ada' }, 'PAYSTACK_CUSTOMER_NAME_INCOMPLETE'],
        ['missing phone', { phone: '' }, 'PAYSTACK_CUSTOMER_PHONE_INVALID']
    ];
    for (const [name, override, code] of cases) {
        await t.test(name, async () => {
            const repository = new FakeVirtualAccountRepository(userFixture(override));
            let adapterAccessed = false;
            const adapter = {
                async fetchCustomer() { adapterAccessed = true; return null; },
                async createCustomer() { adapterAccessed = true; return null; },
                async createDedicatedVirtualAccount() { adapterAccessed = true; return null; }
            };
            const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });
            await assert.rejects(
                service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank', consent: true }),
                error => error.code === code
            );
            assert.equal(adapterAccessed, false);
            assert.equal(repository.user.virtualAccounts.length, 0);
        });
    }
});

test('Paystack provisioning requires explicit consent before claiming or calling the provider', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    let adapterAccessed = false;
    const adapter = {
        async fetchCustomer() { adapterAccessed = true; return null; }
    };
    const service = new VirtualAccountService({ repository, gatewayService: makeGatewayService({ paystackAdapter: adapter }) });

    await assert.rejects(
        service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank: 'wema-bank' }),
        error => error.code === 'PAYSTACK_DVA_CONSENT_REQUIRED'
    );
    assert.equal(adapterAccessed, false);
    assert.equal(repository.user.virtualAccounts.length, 0);
});

test('Paystack preferred-bank validation is isolated by gateway environment', async t => {
    const cases = [
        ['live rejects test-bank', 'live', 'test-bank'],
        ['test rejects live bank', 'test', 'wema-bank']
    ];

    for (const [name, environment, preferredBank] of cases) {
        await t.test(name, async () => {
            const repository = new FakeVirtualAccountRepository(userFixture());
            let adapterAccessed = false;
            const adapter = {
                async fetchCustomer() { adapterAccessed = true; return paystackCustomer(); },
                async createCustomer() { adapterAccessed = true; return paystackCustomer(); },
                async createDedicatedVirtualAccount() { adapterAccessed = true; return paystackDvaResult(); }
            };
            const service = new VirtualAccountService({
                repository,
                gatewayService: makeGatewayService({ paystackAdapter: adapter, paystackEnvironment: environment })
            });

            await assert.rejects(
                service.provision({ userId: 'user-1', providerCode: 'paystack', preferredBank, consent: true }),
                error => error.code === 'PAYSTACK_DVA_BANK_INVALID'
            );
            assert.equal(adapterAccessed, false);
            assert.equal(repository.user.virtualAccounts.length, 0);
        });
    }
});

const lifecyclePaystackAdapter = overrides => ({
    async fetchCustomer() { return paystackCustomer(); },
    async createCustomer() { return paystackCustomer(); },
    async createDedicatedVirtualAccount() { return paystackDvaResult(); },
    ...(overrides || {})
});

const lifecycleMonnifyAdapter = overrides => ({
    assertVirtualAccountCustomer(user) {
        if (!user?.email && !user?.phone) {
            const error = new Error('missing Monnify customer data');
            error.code = 'MONNIFY_CUSTOMER_DATA_INVALID';
            throw error;
        }
    },
    async createReservedAccount({ user, accountReference }) {
        return {
            status: true,
            accountReference,
            accounts: [{
                bankName: 'Moniepoint',
                bankCode: '50515',
                accountName: user.name,
                accountNumber: '9988776655'
            }]
        };
    },
    ...(overrides || {})
});

test('automatic lifecycle provisions Paystack and Monnify independently when both are eligible', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture());
    const service = new VirtualAccountService({
        repository,
        gatewayService: makeGatewayService({
            paystackAdapter: lifecyclePaystackAdapter(),
            monnifyAdapter: lifecycleMonnifyAdapter()
        })
    });

    const result = await service.provisionEligible({
        userId: 'user-1',
        paystackConsent: true,
        paystackPreferredBank: 'wema-bank',
        monnifyConsent: true
    });

    assert.equal(result.paystack.status, 'active');
    assert.equal(result.monnify.status, 'active');
    assert.equal(repository.user.virtualAccounts.filter(account => account.provider === 'paystack').length, 1);
    assert.equal(repository.user.virtualAccounts.filter(account => account.provider === 'monnify').length, 1);
    assert.ok(repository.user.virtualAccountPreferences.paystack.consentGrantedAt);
});

test('automatic lifecycle skips only the provider whose requirements are incomplete', async t => {
    await t.test('Paystack incomplete does not block Monnify', async () => {
        const repository = new FakeVirtualAccountRepository(userFixture({ name: 'Ada' }));
        const service = new VirtualAccountService({
            repository,
            gatewayService: makeGatewayService({
                paystackAdapter: lifecyclePaystackAdapter(),
                monnifyAdapter: lifecycleMonnifyAdapter()
            })
        });
        const result = await service.provisionEligible({
            userId: 'user-1',
            paystackConsent: true,
            paystackPreferredBank: 'wema-bank',
            monnifyConsent: true
        });
        assert.equal(result.paystack.status, 'skipped');
        assert.equal(result.paystack.code, 'PAYSTACK_CUSTOMER_NAME_INCOMPLETE');
        assert.equal(result.monnify.status, 'active');
    });

    await t.test('Monnify incomplete does not block Paystack', async () => {
        const monnifyAdapter = lifecycleMonnifyAdapter({
            assertVirtualAccountCustomer() {
                const error = new Error('Monnify profile incomplete');
                error.code = 'MONNIFY_CUSTOMER_DATA_INVALID';
                throw error;
            }
        });
        const repository = new FakeVirtualAccountRepository(userFixture());
        const service = new VirtualAccountService({
            repository,
            gatewayService: makeGatewayService({ paystackAdapter: lifecyclePaystackAdapter(), monnifyAdapter })
        });
        const result = await service.provisionEligible({
            userId: 'user-1',
            paystackConsent: true,
            paystackPreferredBank: 'wema-bank',
            monnifyConsent: true
        });
        assert.equal(result.paystack.status, 'active');
        assert.equal(result.monnify.status, 'skipped');
        assert.equal(result.monnify.code, 'MONNIFY_CUSTOMER_DATA_INVALID');
    });

    await t.test('both incomplete performs no provider mutation', async () => {
        const repository = new FakeVirtualAccountRepository(userFixture({ email: '', phone: '' }));
        const service = new VirtualAccountService({
            repository,
            gatewayService: makeGatewayService({
                paystackAdapter: lifecyclePaystackAdapter(),
                monnifyAdapter: lifecycleMonnifyAdapter()
            })
        });
        const result = await service.provisionEligible({ userId: 'user-1' });
        assert.equal(result.paystack.status, 'skipped');
        assert.equal(result.monnify.status, 'skipped');
        assert.equal(repository.user.virtualAccounts.length, 0);
    });
});

test('automatic lifecycle contains Paystack failure and Monnify ambiguous mutation independently', async () => {
    const paystackAdapter = lifecyclePaystackAdapter({
        async createDedicatedVirtualAccount() {
            const error = new Error('Paystack unavailable');
            error.response = { status: 400 };
            throw error;
        }
    });
    const monnifyAdapter = lifecycleMonnifyAdapter({
        async createReservedAccount() { throw new Error('Monnify unavailable'); }
    });
    const repository = new FakeVirtualAccountRepository(userFixture());
    const service = new VirtualAccountService({
        repository,
        gatewayService: makeGatewayService({ paystackAdapter, monnifyAdapter })
    });

    const result = await service.provisionEligible({
        userId: 'user-1',
        paystackConsent: true,
        paystackPreferredBank: 'wema-bank',
        monnifyConsent: true
    });

    assert.equal(result.paystack.status, 'failed');
    assert.equal(result.monnify.status, 'pending');
    assert.equal(result.monnify.state, 'reconciliation_required');
    assert.equal(repository.user.virtualAccounts.filter(account => account.provisioningStatus === 'failed').length, 1);
});

test('persisted Paystack consent allows a later lifecycle refresh after profile eligibility changes', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture({ name: 'Ada' }));
    const service = new VirtualAccountService({
        repository,
        gatewayService: makeGatewayService({
            paystackAdapter: lifecyclePaystackAdapter(),
            monnifyAdapter: lifecycleMonnifyAdapter()
        })
    });

    const first = await service.provisionEligible({
        userId: 'user-1',
        paystackConsent: true,
        paystackPreferredBank: 'wema-bank'
    });
    assert.equal(first.paystack.status, 'skipped');
    assert.ok(repository.user.virtualAccountPreferences.paystack.consentGrantedAt);

    repository.user.name = 'Ada Lovelace';
    const second = await service.provisionEligible({ userId: 'user-1' });
    assert.equal(second.paystack.status, 'active');
    assert.equal(repository.user.virtualAccounts.filter(account => account.provider === 'paystack').length, 1);
});

test('persisted Monnify consent allows a later lifecycle refresh after profile eligibility changes', async () => {
    const repository = new FakeVirtualAccountRepository(userFixture({ email: '', phone: '' }));
    const service = new VirtualAccountService({
        repository,
        gatewayService: makeGatewayService({ monnifyAdapter: lifecycleMonnifyAdapter() })
    });

    const first = await service.provisionEligible({
        userId: 'user-1',
        monnifyConsent: true
    });
    assert.equal(first.monnify.status, 'skipped');
    assert.equal(first.monnify.code, 'MONNIFY_CUSTOMER_DATA_INVALID');
    assert.equal(repository.user.virtualAccountPreferences.monnify.consentVersion, VIRTUAL_ACCOUNT_CONSENT_VERSION);

    repository.user.email = 'ada@example.com';
    const second = await service.provisionEligible({ userId: 'user-1' });
    assert.equal(second.monnify.status, 'active');
    assert.equal(repository.user.virtualAccounts.filter(account => account.provider === 'monnify').length, 1);
});

test('automatic and explicit Paystack requests share one atomic provisioning claim', async () => {
    let dvaCalls = 0;
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const paystackAdapter = lifecyclePaystackAdapter({
        async createDedicatedVirtualAccount() {
            dvaCalls++;
            await wait;
            return paystackDvaResult();
        }
    });
    const repository = new FakeVirtualAccountRepository(userFixture({
        virtualAccountPreferences: {
            paystack: {
                preferredBank: 'wema-bank',
                consentGrantedAt: new Date(),
                consentVersion: VIRTUAL_ACCOUNT_CONSENT_VERSION,
                consentChannel: 'provider_specific_api'
            }
        }
    }));
    const service = new VirtualAccountService({
        repository,
        gatewayService: makeGatewayService({
            paystackAdapter,
            monnifyAdapter: lifecycleMonnifyAdapter()
        })
    });

    const automatic = service.provisionEligible({ userId: 'user-1' });
    await new Promise(resolve => setImmediate(resolve));
    const explicit = await service.provision({
        userId: 'user-1',
        providerCode: 'paystack',
        preferredBank: 'wema-bank',
        consent: true
    });
    release();
    const automaticResult = await automatic;

    assert.equal(explicit.status, 'pending');
    assert.equal(automaticResult.paystack.status, 'active');
    assert.equal(dvaCalls, 1);
    assert.equal(repository.user.virtualAccounts.filter(account => account.provider === 'paystack').length, 1);
});

test('automatic lifecycle preserves existing provider accounts and fills only missing providers', async t => {
    const cases = [
        ['existing Paystack', [activePaystackAccount()], 'monnify'],
        ['existing Monnify', [activeMonnifyAccount()], 'paystack'],
        ['both existing', [activePaystackAccount(), activeMonnifyAccount()], null]
    ];
    for (const [name, accounts, addedProvider] of cases) {
        await t.test(name, async () => {
            let paystackMutations = 0;
            let monnifyMutations = 0;
            const repository = new FakeVirtualAccountRepository(userFixture({
                virtualAccounts: accounts,
                virtualAccountPreferences: {
                    paystack: {
                        preferredBank: 'wema-bank',
                        consentGrantedAt: new Date(),
                        consentVersion: VIRTUAL_ACCOUNT_CONSENT_VERSION,
                        consentChannel: 'provider_specific_api'
                    },
                    monnify: {
                        consentGrantedAt: new Date(),
                        consentVersion: VIRTUAL_ACCOUNT_CONSENT_VERSION,
                        consentChannel: 'provider_specific_api'
                    }
                }
            }));
            const service = new VirtualAccountService({
                repository,
                gatewayService: makeGatewayService({
                    paystackAdapter: lifecyclePaystackAdapter({
                        async createDedicatedVirtualAccount() { paystackMutations++; return paystackDvaResult(); }
                    }),
                    monnifyAdapter: lifecycleMonnifyAdapter({
                        async createReservedAccount(request) {
                            monnifyMutations++;
                            return lifecycleMonnifyAdapter().createReservedAccount(request);
                        }
                    })
                })
            });
            const before = clone(accounts);
            const result = await service.provisionEligible({ userId: 'user-1' });
            for (const original of before) {
                const retained = repository.user.virtualAccounts.find(account =>
                    account.accountNumber === original.accountNumber
                );
                assert.deepEqual(retained, original);
            }
            assert.equal(paystackMutations, addedProvider === 'paystack' ? 1 : 0);
            assert.equal(monnifyMutations, addedProvider === 'monnify' ? 1 : 0);
            assert.equal(result.paystack.status, 'active');
            assert.equal(result.monnify.status, 'active');
        });
    }
});

test('legacy provider-less account is quarantined unchanged without duplication', async () => {
    const legacy = {
        bankName: 'Legacy Bank',
        accountName: 'Ada Lovelace',
        accountNumber: '1010101010',
        accountReference: 'VIRTUAL_user-1',
        active: true
    };
    let monnifyCalls = 0;
    const repository = new FakeVirtualAccountRepository(userFixture({ virtualAccounts: [legacy] }));
    const service = new VirtualAccountService({
        repository,
        gatewayService: makeGatewayService({
            paystackAdapter: lifecyclePaystackAdapter(),
            monnifyAdapter: lifecycleMonnifyAdapter({
                async createReservedAccount() { monnifyCalls++; throw new Error('must not provision'); }
            })
        })
    });

    const result = await service.provisionEligible({ userId: 'user-1' });
    assert.equal(result.monnify.status, 'skipped');
    assert.equal(result.monnify.code, 'LEGACY_VIRTUAL_ACCOUNT_REVIEW_REQUIRED');
    assert.equal(monnifyCalls, 0);
    assert.deepEqual(repository.user.virtualAccounts, [legacy]);
});
