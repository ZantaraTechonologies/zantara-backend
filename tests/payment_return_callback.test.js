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
            status: 'active', isDefault: false, priority: 2, baseUrl: 'https://sandbox.monnify.com',
            supportedChannels: ['card', 'bank_transfer', 'virtual_account'], publicKey: 'MK', secretKey: 'sk',
            webhookSecret: '', metadata: { contractCode: '123456' }
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
        sort: () => mockQuery(data),
        limit: () => mockQuery(data),
        then: (resolve) => Promise.resolve(resolve(data)),
        catch: (reject) => Promise.reject(reject)
    });

    PaymentGateway.find = (filter = {}) => {
        let res = [...mockGateways];
        if (filter.status) res = res.filter(g => g.status === filter.status);
        if (filter.supportedChannels) res = res.filter(g => (g.supportedChannels || []).includes(filter.supportedChannels));
        return mockQuery(res);
    };
    PaymentGateway.findOne = (filter = {}) => {
        let found = null;
        if (filter.code) found = mockGateways.find(g => g.code === filter.code);
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
        const restore = stubAdapter('monnify');
        const res = await paymentGatewayService.initializeFunding({
            gatewayCode: 'monnify', user: { _id: 'u1', email: 'a@z.ng' }, amount: 1000, channel: 'card'
        });
        restore();
        process.env[envKey] = 'https://dahavtu.netlify.app';
        assert.strictEqual(res.callbackUrl, 'http://localhost:5173/monnify/return');
    });

    await test('6. /wallet/fund exposes callbackUrl + returnHost for the derived gateway', async () => {
        const restore = stubAdapter('monnify');
        let json = null;
        const req = { body: { amount: 1000, channel: 'card', provider: 'monnify' }, user: { id: 'u1', email: 'a@z.ng' } };
        const res = { json: (d) => { json = d; return res; }, status: () => res };
        await fundWallet(req, res);
        restore();

        assert.strictEqual(json.provider, 'monnify');
        assert.strictEqual(json.callbackUrl, 'https://dahavtu.netlify.app/monnify/return');
        assert.strictEqual(json.returnHost, 'dahavtu.netlify.app');
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