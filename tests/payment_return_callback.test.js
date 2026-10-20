const assert = require('assert');

const PaymentGateway = require('../models/PaymentGateway');
const TransactionStatus = require('../models/TransactionStatus');
const paymentGatewayService = require('../services/paymentGateway.service');
const { fundWallet } = require('../controllers/walletFundingController');

// Guarantees the WEB change: when the client sends NO callback_url override,
// the backend derives the gateway-specific return URL (CLIENT_BASE_URL/<gateway>/return)
// for paystack / monnify / flutterwave — identical to the value each adapter uses
// as its redirectUrl. Also verifies the controller exposes callbackUrl + returnHost.
async function runPaymentReturnCallbackTests() {
    console.log('====================================================');
    console.log('   PAYMENT RETURN CALLBACK DERIVATION TEST SUITE     ');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`[PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`[FAIL] ${name}`);
            console.error(`   Error: ${err.message}`);
            failed++;
        }
    }

    const mockGateways = [
        {
            _id: 'g-paystack', code: 'paystack', name: 'Paystack', adapterType: 'paystack',
            status: 'active', isDefault: true, priority: 1, baseUrl: 'https://api.paystack.co',
            supportedChannels: ['card', 'bank_transfer', 'ussd'], publicKey: 'pk', secretKey: 'sk', webhookSecret: '', metadata: {}
        },
        {
            _id: 'g-monnify', code: 'monnify', name: 'Monnify', adapterType: 'monnify',
            status: 'active', environment: 'test', isDefault: false, priority: 2, baseUrl: 'https://sandbox.monnify.com',
            supportedChannels: ['card', 'bank_transfer', 'virtual_account'], publicKey: 'MK', secretKey: 'sk',
            webhookSecret: '', metadata: {
                contractCode: '123456',
                administrativeSandboxOnly: false,
                checkoutValidation: {
                    status: 'verified',
                    reference: 'MNFY_CALLBACK_TEST',
                    gatewayId: 'g-monnify',
                    environment: 'test',
                    configurationVersion: 0,
                    amountKobo: 10000,
                    currency: 'NGN',
                    provider: 'monnify',
                    providerTransactionId: 'MNFY_CALLBACK_PROVIDER_TX'
                },
                customerFundingEligibility: {
                    status: 'eligible',
                    reference: 'MNFY_CALLBACK_TEST',
                    gatewayId: 'g-monnify',
                    environment: 'test',
                    configurationVersion: 0,
                    amountKobo: 10000,
                    currency: 'NGN',
                    provider: 'monnify',
                    providerTransactionId: 'MNFY_CALLBACK_PROVIDER_TX'
                }
            }
        },
        {
            _id: 'g-flw', code: 'flutterwave', name: 'Flutterwave', adapterType: 'flutterwave',
            status: 'active', isDefault: false, priority: 3, baseUrl: 'https://api.flutterwave.com/v3',
            supportedChannels: ['card', 'bank_transfer', 'ussd'], publicKey: 'FLWPUBK', secretKey: 'sk', webhookSecret: 'h', metadata: {}
        }
    ];

    const origFind = PaymentGateway.find;
    const origFindOne = PaymentGateway.findOne;
    const origCount = PaymentGateway.countDocuments;
    const origTxCreate = TransactionStatus.create;
    const origTxFindOne = TransactionStatus.findOne;
    const envKey = 'CLIENT_BASE_URL';
    const origEnv = process.env[envKey];

    const mockQuery = (data) => ({
        sort: (spec = {}) => {
            if (!Array.isArray(data)) return mockQuery(data);
            const sorted = [...data].sort((a, b) => {
                for (const [field, direction] of Object.entries(spec)) {
                    const result = Number(direction) * ((a[field] > b[field]) - (a[field] < b[field]));
                    if (result !== 0) return result;
                }
                return 0;
            });
            return mockQuery(sorted);
        },
        limit: () => mockQuery(data),
        then: (resolve) => Promise.resolve(resolve(data)),
        catch: (reject) => Promise.reject(reject)
    });

    PaymentGateway.find = (filter = {}) => {
        let res = [...mockGateways];
        if (filter.status) res = res.filter(g => g.status === filter.status);
        if (filter.supportedChannels) res = res.filter(g => (g.supportedChannels || []).includes(filter.supportedChannels));
        if (filter['metadata.administrativeSandboxOnly']?.$ne === true) {
            res = res.filter(g => g.metadata?.administrativeSandboxOnly !== true);
        }
        return mockQuery(res);
    };
    PaymentGateway.findOne = (filter = {}) => {
        let found = null;
        if (filter.code) found = mockGateways.find(g => g.code === filter.code);
        else if (filter.isDefault === true) {
            found = mockGateways.find(g => g.isDefault === true && (!filter.status || g.status === filter.status));
        }
        return mockQuery(found || null);
    };
    PaymentGateway.countDocuments = () => Promise.resolve(mockGateways.length);
    TransactionStatus.create = (doc) => ({ ...doc, _id: 'tx', save: async () => this });
    TransactionStatus.findOne = () => Promise.resolve(null);

    const captured = {};
    const stubAdapter = (code) => {
        const proto = paymentGatewayService.adapters[code].prototype;
        const orig = proto.initializePayment;
        proto.initializePayment = async (opts) => {
            captured[code] = opts;
            return { success: true, authorizationUrl: `https://checkout.${code}.test/start`, reference: opts.reference };
        };
        return () => { proto.initializePayment = orig; };
    };

    const withStubbedAdapter = async (code, callback) => {
        const restore = stubAdapter(code);
        try {
            return await callback();
        } finally {
            restore();
        }
    };

    const eligibleMonnifyMetadata = () => ({
        contractCode: '123456',
        administrativeSandboxOnly: false,
        checkoutValidation: {
            status: 'verified',
            reference: 'MNFY_CALLBACK_TEST',
            gatewayId: 'g-monnify',
            environment: 'test',
            configurationVersion: 0,
            amountKobo: 10000,
            currency: 'NGN',
            provider: 'monnify',
            providerTransactionId: 'MNFY_CALLBACK_PROVIDER_TX'
        },
        customerFundingEligibility: {
            status: 'eligible',
            reference: 'MNFY_CALLBACK_TEST',
            gatewayId: 'g-monnify',
            environment: 'test',
            configurationVersion: 0,
            amountKobo: 10000,
            currency: 'NGN',
            provider: 'monnify',
            providerTransactionId: 'MNFY_CALLBACK_PROVIDER_TX'
        }
    });

    process.env[envKey] = 'https://dahavtu.netlify.app';

    await test('1. Paystack funding callback derives /paystack/return (no override)', async () => {
        delete captured.paystack;
        const restore = stubAdapter('paystack');
        const res = await paymentGatewayService.initializeFunding({
            gatewayCode: 'paystack', user: { _id: 'u1', email: 'a@z.ng' }, amount: 1000, channel: 'card'
        });
        restore();
        assert.strictEqual(res.callbackUrl, 'https://dahavtu.netlify.app/paystack/return');
        assert.strictEqual(res.returnHost, undefined);
        assert.strictEqual(captured.paystack.callbackUrl, undefined, 'adapter must apply its own default');
    });

    await test('2. Monnify funding callback derives /monnify/return (no override)', async () => {
        delete captured.monnify;
        const restore = stubAdapter('monnify');
        const res = await paymentGatewayService.initializeFunding({
            gatewayCode: 'monnify', user: { _id: 'u1', email: 'a@z.ng' }, amount: 1000, channel: 'card'
        });
        restore();
        assert.strictEqual(res.callbackUrl, 'https://dahavtu.netlify.app/monnify/return');
        assert.strictEqual(captured.monnify.callbackUrl, undefined, 'adapter must apply its own default');
    });

    await test('3. Flutterwave funding callback derives /flutterwave/return (no override)', async () => {
        delete captured.flutterwave;
        const restore = stubAdapter('flutterwave');
        const res = await paymentGatewayService.initializeFunding({
            gatewayCode: 'flutterwave', user: { _id: 'u1', email: 'a@z.ng' }, amount: 1000, channel: 'card'
        });
        restore();
        assert.strictEqual(res.callbackUrl, 'https://dahavtu.netlify.app/flutterwave/return');
        assert.strictEqual(captured.flutterwave.callbackUrl, undefined, 'adapter must apply its own default');
    });

    await test('4. Explicit client callbackUrl is preserved (never silently overridden)', async () => {
        const restore = stubAdapter('paystack');
        const res = await paymentGatewayService.initializeFunding({
            gatewayCode: 'paystack', user: { _id: 'u1', email: 'a@z.ng' }, amount: 1000,
            callbackUrl: 'https://custom.example/back'
        });
        restore();
        assert.strictEqual(res.callbackUrl, 'https://custom.example/back');
        assert.strictEqual(captured.paystack.callbackUrl, 'https://custom.example/back');
    });

    await test('5. Missing CLIENT_BASE_URL defaults to localhost (must be flagged in prod)', async () => {
        delete process.env[envKey];
        try {
            const res = await withStubbedAdapter('monnify', () =>
                paymentGatewayService.initializeFunding({
                    gatewayCode: 'monnify', user: { _id: 'u1', email: 'a@z.ng' }, amount: 1000, channel: 'card'
                }));
            assert.strictEqual(res.callbackUrl, 'http://localhost:5173/monnify/return');
        } finally {
            process.env[envKey] = 'https://dahavtu.netlify.app';
        }
    });

    await test('6. /wallet/fund ignores provider compatibility input and exposes the default callback', async () => {
        const restore = stubAdapter('paystack');
        let json = null;
        const req = { body: { amount: 1000, channel: 'card', provider: 'monnify' }, user: { id: 'u1', email: 'a@z.ng' } };
        const res = { json: (d) => { json = d; return res; }, status: () => res };
        await fundWallet(req, res);
        restore();

        assert.strictEqual(json.provider, 'paystack');
        assert.strictEqual(json.callbackUrl, 'https://dahavtu.netlify.app/paystack/return');
        assert.strictEqual(json.returnHost, 'dahavtu.netlify.app');
    });

    await test('7. Amount-only funding uses an active customer-eligible Paystack default', async () => {
        mockGateways.forEach(g => { g.isDefault = g.code === 'paystack'; });
        const result = await withStubbedAdapter('paystack', () =>
            paymentGatewayService.initializeFunding({
                user: { _id: 'u1', email: 'a@z.ng' }, amount: 500
            }));
        assert.strictEqual(result.provider, 'paystack');
    });

    await test('8. Amount-only funding uses a normal active Monnify default', async () => {
        const monnify = mockGateways.find(g => g.code === 'monnify');
        mockGateways.forEach(g => { g.isDefault = g.code === 'monnify'; });
        monnify.metadata = eligibleMonnifyMetadata();
        const result = await withStubbedAdapter('monnify', () =>
            paymentGatewayService.initializeFunding({
                user: { _id: 'u1', email: 'a@z.ng' }, amount: 500
            }));
        assert.strictEqual(result.provider, 'monnify');
    });

    await test('9. Administrative Monnify default falls back to eligible Paystack', async () => {
        const monnify = mockGateways.find(g => g.code === 'monnify');
        mockGateways.forEach(g => { g.isDefault = g.code === 'monnify'; });
        monnify.metadata = { contractCode: '123456', administrativeSandboxOnly: true };
        const result = await withStubbedAdapter('paystack', () =>
            paymentGatewayService.initializeFunding({
                user: { _id: 'u1', email: 'a@z.ng' }, amount: 500
            }));
        assert.strictEqual(result.provider, 'paystack');
    });

    await test('10. Switching the eligible default changes amount-only routing', async () => {
        const monnify = mockGateways.find(g => g.code === 'monnify');
        monnify.metadata = eligibleMonnifyMetadata();
        mockGateways.forEach(g => { g.isDefault = g.code === 'paystack'; });
        const before = await withStubbedAdapter('paystack', () =>
            paymentGatewayService.initializeFunding({
                user: { _id: 'u1', email: 'a@z.ng' }, amount: 500
            }));
        mockGateways.forEach(g => { g.isDefault = g.code === 'monnify'; });
        const after = await withStubbedAdapter('monnify', () =>
            paymentGatewayService.initializeFunding({
                user: { _id: 'u1', email: 'a@z.ng' }, amount: 500
            }));
        assert.strictEqual(before.provider, 'paystack');
        assert.strictEqual(after.provider, 'monnify');
    });

    await test('11. Missing eligible default falls back by active gateway priority', async () => {
        const paystack = mockGateways.find(g => g.code === 'paystack');
        const monnify = mockGateways.find(g => g.code === 'monnify');
        const flutterwave = mockGateways.find(g => g.code === 'flutterwave');
        mockGateways.forEach(g => { g.isDefault = false; });
        monnify.metadata = { contractCode: '123456', administrativeSandboxOnly: true };
        paystack.priority = 3;
        flutterwave.priority = 1;
        try {
            const result = await withStubbedAdapter('flutterwave', () =>
                paymentGatewayService.initializeFunding({
                    user: { _id: 'u1', email: 'a@z.ng' }, amount: 500
                }));
            assert.strictEqual(result.provider, 'flutterwave');
        } finally {
            paystack.priority = 1;
            flutterwave.priority = 3;
        }
    });

    await test('12. Channel routing skips higher-priority administrative sandboxes', async () => {
        const paystack = mockGateways.find(g => g.code === 'paystack');
        const monnify = mockGateways.find(g => g.code === 'monnify');
        const originalPaystackPriority = paystack.priority;
        const originalMonnifyPriority = monnify.priority;
        const originalMonnifyMetadata = monnify.metadata;
        paystack.priority = 2;
        monnify.priority = 1;
        monnify.metadata = { contractCode: '123456', administrativeSandboxOnly: true };
        try {
            const result = await withStubbedAdapter('paystack', () =>
                paymentGatewayService.initializeFunding({
                    channel: 'card', user: { _id: 'u1', email: 'a@z.ng' }, amount: 500
                }));
            assert.strictEqual(result.provider, 'paystack');
        } finally {
            paystack.priority = originalPaystackPriority;
            monnify.priority = originalMonnifyPriority;
            monnify.metadata = originalMonnifyMetadata;
        }
    });

    // Restore everything
    PaymentGateway.find = origFind;
    PaymentGateway.findOne = origFindOne;
    PaymentGateway.countDocuments = origCount;
    TransactionStatus.create = origTxCreate;
    TransactionStatus.findOne = origTxFindOne;
    if (origEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = origEnv;

    console.log('\n----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('----------------------------------------------------\n');

    process.exit(failed > 0 ? 1 : 0);
}

runPaymentReturnCallbackTests();
