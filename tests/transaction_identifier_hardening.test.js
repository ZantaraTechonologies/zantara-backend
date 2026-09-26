'use strict';

const assert = require('node:assert');
const mongoose = require('mongoose');
const { DateTime } = require('luxon');

const Transaction = require('../models/Transaction');
const TransactionStatus = require('../models/TransactionStatus');
const PaymentGateway = require('../models/PaymentGateway');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const pinService = require('../services/pin.service');
const walletService = require('../services/wallet.service');
const pricingService = require('../services/pricing.service');
const procurementService = require('../services/procurement.service');
const providerService = require('../services/provider.service');
const paymentGatewayService = require('../services/paymentGateway.service');
const purchaseService = require('../services/purchase.service');
const servicesController = require('../controllers/servicesController');
const { serializeCustomerTransaction } = require('../utils/customerTransactionSerializer');
const { buildCredentialSmsBatches } = require('../utils/notificationFormatter');
const {
    ID_ALPHABET,
    generateTransactionId,
    generateReference,
    generateProviderRequestId,
    generateVTPassRequestId,
    generatePaymentReference,
} = require('../utils/generateID');
const { createWithIdentifierRetry } = require('../utils/identifierRetry');

const duplicateError = field => {
    const error = new Error(`E11000 duplicate key index: ${field}_1`);
    error.code = 11000;
    error.keyPattern = { [field]: 1 };
    return error;
};

async function withPurchaseMocks({ adapterType = 'vtpass', create, test }) {
    const originals = {
        verifyPin: pinService.verifyPin,
        userFindById: User.findById,
        walletFindOne: Wallet.findOne,
        debit: walletService.debit,
        resolvePricing: pricingService.resolvePricing,
        selectBestOffer: procurementService.selectBestOffer,
        transactionCreate: Transaction.create,
        transactionFindById: Transaction.findById,
        transactionUpdateOne: Transaction.updateOne,
    };
    const state = {
        creates: 0,
        debits: 0,
        providerCalls: 0,
        createdDocs: [],
        providerRequestIds: [],
    };
    const userId = new mongoose.Types.ObjectId();
    const serviceId = new mongoose.Types.ObjectId();
    const providerId = new mongoose.Types.ObjectId();
    const offerId = new mongoose.Types.ObjectId();
    let storedTransaction = null;

    pinService.verifyPin = async () => true;
    User.findById = async () => ({
        _id: userId,
        name: 'Identifier Test',
        role: 'user',
        accountType: 'user',
        kycLevel: 3,
    });
    Wallet.findOne = async () => ({ balance: 100000 });
    walletService.debit = async () => {
        state.debits++;
        return { balance: 99000 };
    };
    pricingService.resolvePricing = async () => ({
        baseCostPrice: 900,
        salePrice: 1000,
        retailPrice: 1000,
        quantity: 1,
    });
    procurementService.selectBestOffer = async () => ({
        _id: offerId,
        serviceId,
        providerId: {
            _id: providerId,
            name: adapterType === 'vtpass' ? 'VTPass' : 'Neutral Provider',
            adapterType,
            baseUrl: 'https://provider.example',
            apiKey: 'encrypted-api-key',
            secretKey: 'encrypted-secret-key',
            publicKey: 'public-key',
            metadata: { queryUrl: '/query' },
            status: 'active',
        },
        providerCode: 'mtn-airtime',
        providerServiceCode: 'mtn',
        status: true,
    });
    Transaction.create = async doc => {
        state.creates++;
        state.createdDocs.push(doc);
        if (create) {
            const result = await create(doc, state.creates);
            if (result) storedTransaction = result;
            return result;
        }
        storedTransaction = {
            ...doc,
            _id: new mongoose.Types.ObjectId(),
            isLoss: false,
        };
        return storedTransaction;
    };
    Transaction.findById = async () => storedTransaction;
    Transaction.updateOne = async () => ({ matchedCount: 1, modifiedCount: 1 });

    const run = async type => {
        const result = await purchaseService.processPurchase(userId, {
            type,
            serviceId: 'mtn',
            canonicalService: { _id: serviceId, code: 'MTN', name: 'MTN', status: true },
            amount: 1000,
            expectedPrice: 1000,
            pin: '1234',
            details: { phone: '08012345678' },
            providerCall: async requestId => {
                state.providerCalls++;
                state.providerRequestIds.push(requestId);
                return {
                    success: false,
                    status: 'pending',
                    outcome: 'pending',
                    message: 'Pending',
                    raw: {},
                };
            },
        });
        return { result, transaction: storedTransaction };
    };

    try {
        return await test({ run, state });
    } finally {
        pinService.verifyPin = originals.verifyPin;
        User.findById = originals.userFindById;
        Wallet.findOne = originals.walletFindOne;
        walletService.debit = originals.debit;
        pricingService.resolvePricing = originals.resolvePricing;
        procurementService.selectBestOffer = originals.selectBestOffer;
        Transaction.create = originals.transactionCreate;
        Transaction.findById = originals.transactionFindById;
        Transaction.updateOne = originals.transactionUpdateOne;
    }
}

async function main() {
    let passed = 0;
    let failed = 0;
    const test = async (name, fn) => {
        try {
            await fn();
            console.log(`[PASS] ${name}`);
            passed++;
        } catch (error) {
            console.error(`[FAIL] ${name}: ${error.message}`);
            if (process.env.VERBOSE) console.error(error.stack);
            failed++;
        }
    };

    await test('transactionId uses the required 12-character alphabet', async () => {
        const values = Array.from({ length: 5000 }, generateTransactionId);
        assert.ok(values.every(value => /^ZNT-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/.test(value)));
        assert.strictEqual(new Set(values).size, values.length);
        assert.strictEqual(ID_ALPHABET.length, 32);
    });

    await test('internal refId uses 16 cryptographic alphabet characters', async () => {
        const values = Array.from({ length: 5000 }, generateReference);
        assert.ok(values.every(value => /^ZNT-R-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/.test(value)));
        assert.strictEqual(new Set(values).size, values.length);
    });

    await test('payment references are high-entropy gateway references', async () => {
        const paystack = generatePaymentReference('paystack');
        const monnify = generatePaymentReference('monnify');
        const flutterwave = generatePaymentReference('flutterwave');
        assert.match(paystack, /^PAYSTACK-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/);
        assert.match(monnify, /^MONNIFY-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/);
        assert.match(flutterwave, /^FLUTTERWAVE-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/);
    });

    await test('environment-only Monnify and Flutterwave configurations remain recoverable', async () => {
        const originalCount = PaymentGateway.countDocuments;
        const previous = {
            MONNIFY_API_KEY: process.env.MONNIFY_API_KEY,
            MONNIFY_SECRET_KEY: process.env.MONNIFY_SECRET_KEY,
            FLUTTERWAVE_SECRET_KEY: process.env.FLUTTERWAVE_SECRET_KEY,
        };
        try {
            PaymentGateway.countDocuments = async () => 0;
            process.env.MONNIFY_API_KEY = 'monnify-public';
            process.env.MONNIFY_SECRET_KEY = 'monnify-secret';
            process.env.FLUTTERWAVE_SECRET_KEY = 'flutterwave-secret';
            const monnify = await paymentGatewayService.getGateway('monnify');
            const flutterwave = await paymentGatewayService.getGateway('flutterwave');
            assert.strictEqual(monnify.adapterType, 'monnify');
            assert.strictEqual(monnify.publicKey, 'monnify-public');
            assert.strictEqual(flutterwave.adapterType, 'flutterwave');
            assert.strictEqual(flutterwave.secretKey, 'flutterwave-secret');
        } finally {
            PaymentGateway.countDocuments = originalCount;
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    for (const gateway of ['paystack', 'monnify', 'flutterwave']) {
        await test(`${gateway} legacy route delegates to the configured unified gateway`, async () => {
            const controllerPath = require.resolve(`../controllers/${gateway}Controller`);
            const originalInitialize = paymentGatewayService.initializeFunding;
            let initialization;
            try {
                paymentGatewayService.initializeFunding = async options => {
                    initialization = options;
                    return {
                        authorizationUrl: 'https://pay.example/checkout',
                        reference: `${gateway.toUpperCase()}-23456789ABCDEFGH`,
                    };
                };
                delete require.cache[controllerPath];
                const controller = require(controllerPath);
                const res = {
                    statusCode: 200,
                    status(code) { this.statusCode = code; return this; },
                    json(body) { this.body = body; return body; },
                };
                await controller.payment({
                    body: { amount: 1000, reference: 'CALLER-CONTROLLED-REFERENCE' },
                    user: { id: 'user-1', email: 'user@example.com' },
                }, res);

                assert.strictEqual(res.statusCode, 200);
                assert.strictEqual(initialization.gatewayCode, gateway);
                assert.strictEqual(initialization.amount, 1000);
                assert.strictEqual(initialization.user._id, 'user-1');
                assert.strictEqual(initialization.reference, undefined);
                assert.strictEqual(res.body.authorization_url, 'https://pay.example/checkout');
                assert.match(res.body.reference, new RegExp(`^${gateway.toUpperCase()}-`));
            } finally {
                paymentGatewayService.initializeFunding = originalInitialize;
                delete require.cache[controllerPath];
            }
        });
    }

    await test('payment refId collision retries before one gateway initialization', async () => {
        const originalGetGateway = paymentGatewayService.getGateway;
        const originalGetAdapter = paymentGatewayService.getAdapterInstance;
        const originalCreate = TransactionStatus.create;
        let creates = 0;
        let initializes = 0;
        const records = [];
        try {
            paymentGatewayService.getGateway = async () => ({
                code: 'monnify', name: 'Monnify', status: 'active', supportedChannels: ['card'],
            });
            paymentGatewayService.getAdapterInstance = () => ({
                initializePayment: async ({ reference }) => {
                    initializes++;
                    return { authorizationUrl: 'https://pay.example/checkout', reference };
                },
            });
            TransactionStatus.create = async document => {
                creates++;
                if (creates === 1) throw duplicateError('refId');
                records.push(document);
                return document;
            };
            const result = await paymentGatewayService.initializeFunding({
                gatewayCode: 'monnify',
                user: { _id: new mongoose.Types.ObjectId(), email: 'user@example.com' },
                amount: 1000,
            });
            assert.strictEqual(creates, 2);
            assert.strictEqual(initializes, 1);
            assert.strictEqual(records.length, 1);
            assert.strictEqual(records[0].refId, result.reference);
            assert.strictEqual(records[0].amountKobo, 100000);
        } finally {
            paymentGatewayService.getGateway = originalGetGateway;
            paymentGatewayService.getAdapterInstance = originalGetAdapter;
            TransactionStatus.create = originalCreate;
        }
    });

    await test('payment collision exhaustion never initializes the gateway', async () => {
        const originalGetGateway = paymentGatewayService.getGateway;
        const originalGetAdapter = paymentGatewayService.getAdapterInstance;
        const originalCreate = TransactionStatus.create;
        let creates = 0;
        let initializes = 0;
        try {
            paymentGatewayService.getGateway = async () => ({
                code: 'monnify', name: 'Monnify', status: 'active', supportedChannels: ['card'],
            });
            paymentGatewayService.getAdapterInstance = () => ({
                initializePayment: async () => { initializes++; },
            });
            TransactionStatus.create = async () => {
                creates++;
                throw duplicateError('refId');
            };
            await assert.rejects(paymentGatewayService.initializeFunding({
                gatewayCode: 'monnify',
                user: { _id: new mongoose.Types.ObjectId(), email: 'user@example.com' },
                amount: 1000,
            }), error => error.code === 'IDENTIFIER_GENERATION_EXHAUSTED');
            assert.strictEqual(creates, 3);
            assert.strictEqual(initializes, 0);
        } finally {
            paymentGatewayService.getGateway = originalGetGateway;
            paymentGatewayService.getAdapterInstance = originalGetAdapter;
            TransactionStatus.create = originalCreate;
        }
    });

    await test('VTPass request ID has Lagos minute prefix and safe random suffix', async () => {
        const before = DateTime.now().setZone('Africa/Lagos').toFormat('yyyyLLddHHmm');
        const requestId = generateVTPassRequestId();
        const after = DateTime.now().setZone('Africa/Lagos').toFormat('yyyyLLddHHmm');
        assert.strictEqual(requestId.length, 20);
        assert.ok(requestId.startsWith(before) || requestId.startsWith(after));
        assert.match(requestId.slice(12), /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
        assert.match(generateProviderRequestId('vtpass'), /^\d{12}[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
        assert.match(generateProviderRequestId('universal'), /^ZNT-P-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/);
    });

    await test('retry helper regenerates transactionId and refId duplicates', async () => {
        for (const field of ['transactionId', 'refId']) {
            let generated = 0;
            let creates = 0;
            const result = await createWithIdentifierRetry({
                label: 'Test',
                fields: [field],
                generate: () => ({ value: ++generated }),
                create: async identifiers => {
                    creates++;
                    if (creates === 1) throw duplicateError(field);
                    return identifiers;
                },
            });
            assert.strictEqual(result.value, 2);
            assert.strictEqual(creates, 2);
        }
    });

    await test('retry helper stops after three duplicate attempts', async () => {
        let creates = 0;
        await assert.rejects(
            createWithIdentifierRetry({
                label: 'Test',
                fields: ['refId'],
                generate: () => ({ refId: generateReference() }),
                create: async () => {
                    creates++;
                    throw duplicateError('refId');
                },
            }),
            error => error.code === 'IDENTIFIER_GENERATION_EXHAUSTED'
        );
        assert.strictEqual(creates, 3);
    });

    await test('retry helper does not retry unrelated database errors', async () => {
        let creates = 0;
        const unrelated = new Error('database unavailable');
        await assert.rejects(createWithIdentifierRetry({
            label: 'Test',
            fields: ['refId'],
            generate: () => ({ refId: generateReference() }),
            create: async () => {
                creates++;
                throw unrelated;
            },
        }), error => error === unrelated);
        assert.strictEqual(creates, 1);
    });

    await test('purchase duplicate retry happens before one wallet debit and provider call', async () => {
        await withPurchaseMocks({
            adapterType: 'vtpass',
            create: async (doc, attempt) => {
                if (attempt === 1) throw duplicateError('transactionId');
                return { ...doc, _id: new mongoose.Types.ObjectId(), isLoss: false };
            },
            test: async ({ run, state }) => {
                const { transaction } = await run('airtime');
                assert.strictEqual(state.creates, 2);
                assert.strictEqual(state.debits, 1);
                assert.strictEqual(state.providerCalls, 1);
                assert.notStrictEqual(state.createdDocs[0].transactionId, state.createdDocs[1].transactionId);
                assert.strictEqual(state.providerRequestIds[0], transaction.providerRequestId);
                assert.strictEqual(transaction.details.request_id, transaction.providerRequestId);
                assert.notStrictEqual(transaction.refId, transaction.providerRequestId);
                assert.deepStrictEqual(transaction.providerConfigSnapshot, {
                    baseUrl: 'https://provider.example',
                    publicKey: 'public-key',
                    metadata: { queryUrl: '/query' },
                });
                assert.deepStrictEqual(transaction.providerCredentialSnapshot, {
                    apiKey: 'encrypted-api-key',
                    secretKey: 'encrypted-secret-key',
                });
            },
        });
    });

    await test('purchase refId duplicate regenerates without duplicate financial side effects', async () => {
        await withPurchaseMocks({
            adapterType: 'universal',
            create: async (doc, attempt) => {
                if (attempt === 1) throw duplicateError('refId');
                return { ...doc, _id: new mongoose.Types.ObjectId(), isLoss: false };
            },
            test: async ({ run, state }) => {
                await run('data');
                assert.strictEqual(state.creates, 2);
                assert.strictEqual(state.debits, 1);
                assert.strictEqual(state.providerCalls, 1);
                assert.notStrictEqual(state.createdDocs[0].refId, state.createdDocs[1].refId);
                assert.match(state.providerRequestIds[0], /^ZNT-P-/);
            },
        });
    });

    await test('three purchase collisions produce no debit or provider purchase', async () => {
        await withPurchaseMocks({
            create: async () => { throw duplicateError('refId'); },
            test: async ({ run, state }) => {
                await assert.rejects(run('airtime'), error => error.code === 'IDENTIFIER_GENERATION_EXHAUSTED');
                assert.strictEqual(state.creates, 3);
                assert.strictEqual(state.debits, 0);
                assert.strictEqual(state.providerCalls, 0);
            },
        });
    });

    await test('unrelated purchase insert error is not retried or dispatched', async () => {
        await withPurchaseMocks({
            create: async () => { throw new Error('database unavailable'); },
            test: async ({ run, state }) => {
                await assert.rejects(run('airtime'), /database unavailable/);
                assert.strictEqual(state.creates, 1);
                assert.strictEqual(state.debits, 0);
                assert.strictEqual(state.providerCalls, 0);
            },
        });
    });

    await test('all VTPass purchase categories receive a VTPass providerRequestId', async () => {
        for (const type of ['airtime', 'data', 'electricity', 'cable', 'pin']) {
            await withPurchaseMocks({
                adapterType: 'vtpass',
                test: async ({ run, state }) => {
                    const { transaction } = await run(type);
                    assert.match(state.providerRequestIds[0], /^\d{12}[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
                    assert.strictEqual(state.providerRequestIds[0], transaction.providerRequestId);
                    assert.notStrictEqual(state.providerRequestIds[0], transaction.refId);
                },
            });
        }
    });

    await test('requery uses persisted providerRequestId and historical refId fallback', async () => {
        const originalFindOne = Transaction.findOne;
        const originalQuery = providerService.queryTransaction;
        const originalResolve = purchaseService.resolveExistingTransaction;
        const seen = [];
        try {
            providerService.queryTransaction = async (reference, provider, identity) => {
                seen.push({ reference, provider, identity });
                return { success: false, status: 'pending', outcome: 'pending', raw: {} };
            };
            purchaseService.resolveExistingTransaction = async tx => ({
                success: false,
                status: 'pending',
                data: { status: 'pending', transactionId: tx },
            });
            const records = [
                { _id: 'new-id', refId: 'ZNT-R-23456789ABCDEFGH', providerRequestId: '20260926120023456789', provider: 'VTPass', providerId: 'provider-id', providerAdapterType: 'vtpass', providerConfigSnapshot: { baseUrl: 'https://provider.example', metadata: { queryUrl: '/query' } }, providerCredentialSnapshot: { apiKey: 'encrypted-api-key', secretKey: 'encrypted-secret-key' }, status: 'pending' },
                { _id: 'old-id', refId: 'ZNT-123-ABC', provider: 'VTPass', status: 'pending' },
            ];
            let position = 0;
            Transaction.findOne = async () => records[position++];
            const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return value; } });
            await servicesController.checkTransaction({ body: { refId: 'new' }, user: { id: 'user-1' } }, response());
            await servicesController.checkTransaction({ body: { refId: 'old' }, user: { id: 'user-1' } }, response());
            assert.deepStrictEqual(seen, [
                {
                    reference: '20260926120023456789',
                    provider: 'VTPass',
                    identity: {
                        providerId: 'provider-id',
                        adapterType: 'vtpass',
                        configSnapshot: { baseUrl: 'https://provider.example', metadata: { queryUrl: '/query' } },
                        credentialSnapshot: { apiKey: 'encrypted-api-key', secretKey: 'encrypted-secret-key' },
                    },
                },
                {
                    reference: 'ZNT-123-ABC',
                    provider: 'VTPass',
                    identity: { providerId: undefined, adapterType: undefined, configSnapshot: undefined, credentialSnapshot: undefined },
                },
            ]);
        } finally {
            Transaction.findOne = originalFindOne;
            providerService.queryTransaction = originalQuery;
            purchaseService.resolveExistingTransaction = originalResolve;
        }
    });

    await test('historical FT transaction IDs and old refs remain unchanged in DTOs', async () => {
        const dto = serializeCustomerTransaction({
            _id: 'historical-id',
            transactionId: 'FT123456789',
            refId: 'ZNT-123-ABC',
            type: 'airtime',
            status: 'success',
            amount: 100,
        });
        assert.strictEqual(dto.transactionId, 'FT123456789');
        assert.strictEqual(dto.refId, 'ZNT-123-ABC');
    });

    await test('new customer transaction ID fits credential SMS batches', async () => {
        const messages = buildCredentialSmsBatches({
            type: 'pin',
            serviceId: 'waec',
            reference: generateTransactionId(),
            details: { quantity: 3 },
            fulfillment: {
                complete: true,
                items: [
                    { code: '123456789012' },
                    { code: '234567890123' },
                    { code: '345678901234' },
                ],
            },
            brand: { siteName: 'Zantara' },
            maxLength: 150,
        });
        assert.ok(messages.length > 0);
        assert.ok(messages.every(message => message.length <= 150));
    });

    console.log(`\nIdentifier hardening tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
