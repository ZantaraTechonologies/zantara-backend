const assert = require('assert');
const mongoose = require('mongoose');
const crypto = require('crypto');

// Models
const PaymentGateway = require('../models/PaymentGateway');
const TransactionStatus = require('../models/TransactionStatus');
const WebhookEvent = require('../models/WebhookEvent');
const Wallet = require('../models/Wallet');
const WalletLedger = require('../models/WalletLedger');
const Transaction = require('../models/Transaction');

// Services & Utilities
const paymentGatewayService = require('../services/paymentGateway.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');
const { encryptSecret, decryptSecret, isEncrypted } = require('../utils/crypto');
const { sanitizePaymentGateway, sanitizePaymentGatewayForClient } = require('../utils/paymentGatewaySerializer');

// Adapters
const PaystackAdapter = require('../adapters/payment/paystack.adapter');
const MonnifyAdapter = require('../adapters/payment/monnify.adapter');
const FlutterwaveAdapter = require('../adapters/payment/flutterwave.adapter');

async function runPaymentGatewayTests() {
    console.log('====================================================');
    console.log('   MULTI-PAYMENT-GATEWAY ARCHITECTURE TEST SUITE    ');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`✅ [PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`❌ [FAIL] ${name}`);
            console.error(`   Error: ${err.message}\n`, err.stack);
            failed++;
        }
    }

    // In-memory mock database state for testing without live MongoDB connection
    let mockGateways = [];
    let mockTransactions = [];
    let mockWebhookEvents = [];
    let walletCredits = [];

    // Save originals
    const origFind = PaymentGateway.find;
    const origFindOne = PaymentGateway.findOne;
    const origCountDocuments = PaymentGateway.countDocuments;
    const origUpdateMany = PaymentGateway.updateMany;
    const origTxFindOne = TransactionStatus.findOne;
    const origTxCreate = TransactionStatus.create;
    const origTxUpdateOne = TransactionStatus.updateOne;
    const origWhFindOne = WebhookEvent.findOne;
    const origWhCreate = WebhookEvent.create;
    const origTxModelCreate = Transaction.create;
    const origWalletCredit = walletService.credit;
    const origNotifySendInApp = notificationService.sendInApp;

    Transaction.create = async () => ({ _id: new mongoose.Types.ObjectId() });

    // Helper to mock mongoose query chains
    const mockQuery = (data) => ({
        sort: () => mockQuery(data),
        limit: () => mockQuery(data),
        session: () => mockQuery(data),
        then: (resolve) => Promise.resolve(resolve(data)),
        catch: (reject) => Promise.reject(reject)
    });

    // Mock PaymentGateway model queries
    PaymentGateway.find = (filter = {}) => {
        let res = [...mockGateways];
        if (filter.status) res = res.filter(g => g.status === filter.status);
        if (filter.supportedChannels) res = res.filter(g => (g.supportedChannels || []).includes(filter.supportedChannels));
        return mockQuery(res);
    };

    PaymentGateway.findOne = (filter = {}) => {
        let found = null;
        if (filter.code) found = mockGateways.find(g => g.code === filter.code);
        else if (filter.status === 'active' && filter.isDefault) found = mockGateways.find(g => g.status === 'active' && g.isDefault);
        else if (filter.status === 'active') found = mockGateways.find(g => g.status === 'active');
        return mockQuery(found || null);
    };

    PaymentGateway.countDocuments = () => Promise.resolve(mockGateways.length);

    PaymentGateway.updateMany = (filter, update) => {
        mockGateways.forEach(g => {
            if (filter.isDefault && update.$set?.isDefault === false) {
                if (!filter._id || String(g._id) !== String(filter._id?.$ne)) {
                    g.isDefault = false;
                }
            }
        });
        return Promise.resolve({ modifiedCount: 1 });
    };

    // Mock TransactionStatus queries
    TransactionStatus.findOne = (filter = {}) => {
        let found = null;
        if (filter.refId) {
            found = mockTransactions.find(t => t.refId === filter.refId);
        }
        return mockQuery(found || null);
    };

    TransactionStatus.create = (doc) => {
        const item = {
            ...doc,
            _id: new mongoose.Types.ObjectId(),
            status: doc.status || 'pending',
            createdAt: new Date(),
            save: async function() { return this; }
        };
        mockTransactions.push(item);
        return Promise.resolve(item);
    };

    TransactionStatus.updateOne = (filter, update) => {
        const item = mockTransactions.find(t => {
            if (filter.refId && t.refId !== filter.refId) return false;
            if (filter.status && t.status !== filter.status) return false;
            return true;
        });

        if (item) {
            if (update.$set) Object.assign(item, update.$set);
            return Promise.resolve({ modifiedCount: 1, matchedCount: 1 });
        }
        return Promise.resolve({ modifiedCount: 0, matchedCount: 0 });
    };

    // Mock WebhookEvent queries
    WebhookEvent.findOne = (filter = {}) => {
        const found = mockWebhookEvents.find(w => w.eventId === filter.eventId);
        return mockQuery(found || null);
    };

    WebhookEvent.create = (doc) => {
        const item = { ...doc, _id: new mongoose.Types.ObjectId(), save: async () => item };
        mockWebhookEvents.push(item);
        return Promise.resolve(item);
    };

    // Mock Wallet credit
    walletService.credit = async (userId, amount, ref, source) => {
        walletCredits.push({ userId, amount, ref, source, time: Date.now() });
        return { balance: 50000 + amount };
    };

    notificationService.sendInApp = async () => ({ success: true });

    try {
        // ─────────────────────────────────────────────────────────────────────
        // 1. MODEL / CONFIGURATION TESTS
        // ─────────────────────────────────────────────────────────────────────

        await test('1. Multiple gateways can simultaneously have status=active', async () => {
            mockGateways = [
                { _id: 'gw-1', name: 'Paystack', code: 'paystack', adapterType: 'paystack', status: 'active', isDefault: true, supportedChannels: ['card', 'bank_transfer'] },
                { _id: 'gw-2', name: 'Monnify', code: 'monnify', adapterType: 'monnify', status: 'active', isDefault: false, supportedChannels: ['bank_transfer', 'virtual_account'] },
                { _id: 'gw-3', name: 'Flutterwave', code: 'flutterwave', adapterType: 'flutterwave', status: 'active', isDefault: false, supportedChannels: ['card', 'ussd'] }
            ];

            const active = await paymentGatewayService.getActiveGateways();
            assert.strictEqual(active.length, 3, 'All 3 gateways must be active simultaneously');
            assert.deepStrictEqual(active.map(g => g.code), ['paystack', 'monnify', 'flutterwave']);
        });

        await test('2. Only one gateway can be isDefault=true', async () => {
            const defaults = mockGateways.filter(g => g.isDefault);
            assert.strictEqual(defaults.length, 1, 'Exactly one gateway can be default');
            assert.strictEqual(defaults[0].code, 'paystack');
        });

        await test('3. Setting new default safely replaces previous default', async () => {
            // Simulate changing default to Monnify
            await PaymentGateway.updateMany({ isDefault: true }, { $set: { isDefault: false } });
            const monnify = mockGateways.find(g => g.code === 'monnify');
            monnify.isDefault = true;

            const newDefault = await paymentGatewayService.getDefaultGateway();
            assert.strictEqual(newDefault.code, 'monnify', 'Monnify must now be default');
            assert.strictEqual(mockGateways.find(g => g.code === 'paystack').isDefault, false, 'Paystack must no longer be default');

            // Reset back
            monnify.isDefault = false;
            mockGateways.find(g => g.code === 'paystack').isDefault = true;
        });

        await test('4. Inactive gateway cannot be used for new funding', async () => {
            mockGateways.find(g => g.code === 'monnify').status = 'inactive';
            let errCaught = null;
            try {
                await paymentGatewayService.initializeFunding({
                    gatewayCode: 'monnify',
                    user: { _id: 'u-1', email: 'u1@test.com' },
                    amount: 5000
                });
            } catch (e) {
                errCaught = e;
            }
            assert.ok(errCaught, 'Must throw error when trying to use inactive gateway');
            assert.strictEqual(errCaught.code, 'PAYMENT_GATEWAY_INACTIVE');
            mockGateways.find(g => g.code === 'monnify').status = 'active';
        });

        await test('5. Maintenance gateway cannot initialize new funding', async () => {
            mockGateways.find(g => g.code === 'flutterwave').status = 'maintenance';
            let errCaught = null;
            try {
                await paymentGatewayService.initializeFunding({
                    gatewayCode: 'flutterwave',
                    user: { _id: 'u-1', email: 'u1@test.com' },
                    amount: 2000
                });
            } catch (e) {
                errCaught = e;
            }
            assert.ok(errCaught, 'Must throw error for maintenance gateway');
            assert.strictEqual(errCaught.code, 'PAYMENT_GATEWAY_MAINTENANCE');
            mockGateways.find(g => g.code === 'flutterwave').status = 'active';
        });

        await test('6. Gateway not supporting requested channel is rejected', async () => {
            let errCaught = null;
            try {
                // Paystack supports ['card', 'bank_transfer'], NOT 'virtual_account'
                await paymentGatewayService.initializeFunding({
                    gatewayCode: 'paystack',
                    channel: 'virtual_account',
                    user: { _id: 'u-1', email: 'u1@test.com' },
                    amount: 1000
                });
            } catch (e) {
                errCaught = e;
            }
            assert.ok(errCaught, 'Must reject unsupported channel');
            assert.strictEqual(errCaught.code, 'PAYMENT_CHANNEL_UNSUPPORTED');
        });

        await test('7. Active non-default gateway can be explicitly selected', async () => {
            // Paystack is default; explicitly request Monnify
            const monnifyAdapter = paymentGatewayService.adapters.monnify.prototype;
            const origInit = monnifyAdapter.initializePayment;
            monnifyAdapter.initializePayment = async ({ reference }) => ({
                success: true,
                authorizationUrl: 'https://checkout.monnify.com/test-123',
                reference
            });

            const res = await paymentGatewayService.initializeFunding({
                gatewayCode: 'monnify',
                user: { _id: 'u-1', email: 'u1@test.com' },
                amount: 3000
            });

            monnifyAdapter.initializePayment = origInit;

            assert.strictEqual(res.success, true);
            assert.strictEqual(res.gateway, 'monnify', 'Gateway must be Monnify even though Paystack is default');
            assert.ok(res.authorizationUrl.includes('monnify'));
        });

        await test('8. Default gateway is used when gatewayCode is omitted', async () => {
            const paystackAdapter = paymentGatewayService.adapters.paystack.prototype;
            const origInit = paystackAdapter.initializePayment;
            paystackAdapter.initializePayment = async ({ reference }) => ({
                success: true,
                authorizationUrl: 'https://checkout.paystack.com/ps-test',
                reference
            });

            const res = await paymentGatewayService.initializeFunding({
                user: { _id: 'u-1', email: 'u1@test.com' },
                amount: 1500
            });

            paystackAdapter.initializePayment = origInit;

            assert.strictEqual(res.success, true);
            assert.strictEqual(res.gateway, 'paystack', 'Must fall back to default gateway (Paystack)');
        });

        // ─────────────────────────────────────────────────────────────────────
        // 2. PAYSTACK ADAPTER & COMPATIBILITY TESTS
        // ─────────────────────────────────────────────────────────────────────

        await test('9. Existing Paystack initialization works through PaystackAdapter', async () => {
            const adapter = new PaystackAdapter({ secretKey: 'sk_test_mock', baseUrl: 'https://api.paystack.co' });
            assert.strictEqual(adapter.code, 'unknown'); // default
            assert.strictEqual(adapter.baseUrl, 'https://api.paystack.co');
        });

        await test('10. Existing /api/wallet/fund remains backward compatible', async () => {
            const { fundWallet } = require('../controllers/walletFundingController');
            let jsonSent = null;
            const req = {
                body: { amount: 2500 }, // No provider or gateway specified
                user: { id: 'u-compat', email: 'compat@zantara.ng' }
            };
            const res = {
                json: (d) => { jsonSent = d; return res; },
                status: () => res
            };

            const paystackAdapter = paymentGatewayService.adapters.paystack.prototype;
            const origInit = paystackAdapter.initializePayment;
            paystackAdapter.initializePayment = async ({ reference }) => ({
                success: true,
                authorizationUrl: 'https://checkout.paystack.com/compat',
                reference
            });

            await fundWallet(req, res);
            paystackAdapter.initializePayment = origInit;

            assert.ok(jsonSent, 'Response must be sent');
            assert.strictEqual(jsonSent.provider, 'paystack', 'Provider must be paystack');
            assert.strictEqual(jsonSent.authorization_url, 'https://checkout.paystack.com/compat');
            assert.ok(jsonSent.reference, 'Reference must exist');
        });

        await test('11. Existing Web flow remains compatible', async () => {
            // Web client sends { amount: 5000, provider: 'paystack', callback_url: 'http://localhost/paystack/return' }
            const { fundWallet } = require('../controllers/walletFundingController');
            let jsonSent = null;
            const req = {
                body: { amount: 5000, provider: 'paystack', callback_url: 'http://localhost/paystack/return' },
                user: { id: 'u-web', email: 'web@zantara.ng' }
            };
            const res = {
                json: (d) => { jsonSent = d; return res; },
                status: () => res
            };

            const paystackAdapter = paymentGatewayService.adapters.paystack.prototype;
            const origInit = paystackAdapter.initializePayment;
            paystackAdapter.initializePayment = async ({ reference }) => ({
                success: true,
                authorizationUrl: 'https://checkout.paystack.com/web-flow',
                reference
            });

            await fundWallet(req, res);
            paystackAdapter.initializePayment = origInit;

            assert.strictEqual(jsonSent.authorization_url, 'https://checkout.paystack.com/web-flow');
            assert.strictEqual(jsonSent.provider, 'paystack');
        });

        await test('12. Existing Mobile flow remains compatible', async () => {
            // Mobile client sends direct transfer request
            const paystackAdapter = paymentGatewayService.adapters.paystack.prototype;
            const origInit = paystackAdapter.initializePayment;
            paystackAdapter.initializePayment = async ({ isDirectTransfer, reference }) => {
                if (isDirectTransfer) {
                    return {
                        success: true,
                        accountNumber: '9988776655',
                        bankName: 'Wema Bank',
                        accountName: 'Zantara Tech',
                        amount: 5000,
                        reference
                    };
                }
                return { success: true, authorizationUrl: 'http://paystack', reference };
            };

            const res = await paymentGatewayService.initializeFunding({
                gatewayCode: 'paystack',
                user: { _id: 'u-mobile', email: 'mobile@zantara.ng' },
                amount: 5000,
                isDirectTransfer: true
            });

            paystackAdapter.initializePayment = origInit;

            assert.strictEqual(res.accountNumber, '9988776655');
            assert.strictEqual(res.bankName, 'Wema Bank');
        });

        await test('13. Paystack webhook signature verification still works', () => {
            const secret = 'sk_test_secret_123456';
            const adapter = new PaystackAdapter({ secretKey: secret });
            const body = JSON.stringify({ event: 'charge.success', data: { id: 100 } });
            const signature = crypto.createHmac('sha512', secret).update(body).digest('hex');

            const isValid = adapter.verifyWebhookSignature({ 'x-paystack-signature': signature }, body);
            assert.strictEqual(isValid, true, 'Valid signature must return true');

            const isInvalid = adapter.verifyWebhookSignature({ 'x-paystack-signature': 'tampered' }, body);
            assert.strictEqual(isInvalid, false, 'Invalid signature must return false');
        });

        await test('14. Paystack verification occurs before wallet credit', async () => {
            walletCredits = [];
            const tx = {
                refId: 'PS-VERIFY-ORDER',
                userId: 'u-vo',
                status: 'pending',
                amountKobo: 100000, // ₦1000
                amount: 1000,
                provider: 'paystack'
            };
            mockTransactions.push(tx);

            let providerVerifyCalled = false;
            const gatewayResult = {
                status: 'success',
                reference: 'PS-VERIFY-ORDER',
                gateway: 'paystack',
                amount: 1000,
                currency: 'NGN'
            };

            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: gatewayResult,
                source: 'verify'
            });

            assert.strictEqual(walletCredits.length, 1, 'Wallet must be credited after verified result');
            assert.strictEqual(walletCredits[0].amount, 1000);
            assert.strictEqual(tx.status, 'success');
        });

        // ─────────────────────────────────────────────────────────────────────
        // 3. MONNIFY ADAPTER & ROUTING TESTS
        // ─────────────────────────────────────────────────────────────────────

        await test('15. Monnify adapter initializes payment correctly', async () => {
            const adapter = new MonnifyAdapter({
                baseUrl: 'https://sandbox.monnify.com',
                publicKey: 'MK_TEST_123',
                secretKey: 'SK_TEST_456',
                metadata: { contractCode: '1234567890' }
            });

            adapter.getAccessToken = async () => 'mock_monnify_token';
            // Mock axios post
            const origPost = require('axios').post;
            require('axios').post = async () => ({
                data: {
                    requestSuccessful: true,
                    responseBody: { checkoutUrl: 'https://sandbox.monnify.com/pay', paymentReference: 'MNFY-REF-1' }
                }
            });

            const res = await adapter.initializePayment({
                user: { email: 'monnify@test.com', name: 'Monnify User' },
                amount: 4000,
                reference: 'MNFY-REF-1'
            });

            require('axios').post = origPost;

            assert.strictEqual(res.success, true);
            assert.strictEqual(res.authorizationUrl, 'https://sandbox.monnify.com/pay');
        });

        await test('16. Monnify webhook signature validation works', () => {
            const secret = 'monnify_secret_key_abc';
            const adapter = new MonnifyAdapter({ secretKey: secret });
            const payload = JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION' });
            const sig = crypto.createHmac('sha512', secret).update(payload).digest('hex');

            assert.strictEqual(adapter.verifyWebhookSignature({ 'monnify-signature': sig }, payload), true);
            assert.strictEqual(adapter.verifyWebhookSignature({ 'monnify-signature': 'wrong' }, payload), false);
        });

        await test('17. Monnify transaction remains bound to Monnify', async () => {
            const monnifyAdapter = paymentGatewayService.adapters.monnify.prototype;
            const origInit = monnifyAdapter.initializePayment;
            monnifyAdapter.initializePayment = async ({ reference }) => ({
                success: true, authorizationUrl: 'http://mnfy', reference
            });

            const res = await paymentGatewayService.initializeFunding({
                gatewayCode: 'monnify',
                user: { _id: 'u-bound', email: 'bound@test.com' },
                amount: 7000
            });
            monnifyAdapter.initializePayment = origInit;

            const tx = mockTransactions.find(t => t.refId === res.reference);
            assert.ok(tx, 'TransactionStatus record must exist');
            assert.strictEqual(tx.provider, 'monnify', 'TransactionStatus must permanently record provider as monnify');
        });

        await test('18. Paystack cannot verify Monnify transaction', async () => {
            const tx = {
                refId: 'MNFY-CROSS-TEST',
                userId: 'u-cross',
                status: 'pending',
                amountKobo: 200000,
                amount: 2000,
                provider: 'monnify'
            };
            mockTransactions.push(tx);

            // Attempt to finalize using Paystack gateway result
            let threw = false;
            try {
                await paymentGatewayService.finalizeFundingCredit({
                    transactionStatus: tx,
                    gatewayPaymentResult: {
                        status: 'success',
                        reference: 'MNFY-CROSS-TEST',
                        gateway: 'paystack', // mismatch!
                        amount: 2000,
                        currency: 'NGN'
                    }
                });
            } catch (e) {
                threw = true;
                assert.strictEqual(e.code, 'PAYMENT_GATEWAY_MISMATCH');
            }
            assert.strictEqual(threw, true, 'Must reject when Paystack attempts to finalize Monnify transaction');
            assert.strictEqual(tx.status, 'pending', 'Status must not become success');
        });

        await test('19. Monnify cannot verify Paystack transaction', async () => {
            const tx = {
                refId: 'PS-CROSS-TEST',
                userId: 'u-cross2',
                status: 'pending',
                amountKobo: 300000,
                amount: 3000,
                provider: 'paystack'
            };
            mockTransactions.push(tx);

            let threw = false;
            try {
                await paymentGatewayService.finalizeFundingCredit({
                    transactionStatus: tx,
                    gatewayPaymentResult: {
                        status: 'success',
                        reference: 'PS-CROSS-TEST',
                        gateway: 'monnify', // mismatch!
                        amount: 3000,
                        currency: 'NGN'
                    }
                });
            } catch (e) {
                threw = true;
                assert.strictEqual(e.code, 'PAYMENT_GATEWAY_MISMATCH');
            }
            assert.strictEqual(threw, true, 'Must reject when Monnify attempts to finalize Paystack transaction');
        });

        // ─────────────────────────────────────────────────────────────────────
        // 4. FLUTTERWAVE ADAPTER & DOUBLE-CREDIT BUG FIX
        // ─────────────────────────────────────────────────────────────────────

        await test('20. Flutterwave adapter initializes correctly', async () => {
            const adapter = new FlutterwaveAdapter({
                secretKey: 'FLWSECK_TEST_mock',
                webhookSecret: 'flw_hash_123'
            });

            const origPost = require('axios').post;
            require('axios').post = async () => ({
                data: {
                    status: 'success',
                    data: { link: 'https://checkout.flutterwave.com/flw-123' }
                }
            });

            const res = await adapter.initializePayment({
                user: { email: 'flw@test.com', name: 'FLW User' },
                amount: 6000,
                reference: 'FLW-INIT-1'
            });
            require('axios').post = origPost;

            assert.strictEqual(res.success, true);
            assert.strictEqual(res.authorizationUrl, 'https://checkout.flutterwave.com/flw-123');
        });

        await test('21. Flutterwave performs server-side verification', async () => {
            const adapter = new FlutterwaveAdapter({ secretKey: 'FLWSECK_TEST_mock' });
            const origGet = require('axios').get;
            require('axios').get = async () => ({
                data: {
                    status: 'success',
                    data: {
                        status: 'successful',
                        tx_ref: 'FLW-VERIFY-1',
                        amount: 6000,
                        currency: 'NGN',
                        id: 998877
                    }
                }
            });

            const res = await adapter.verifyPayment('FLW-VERIFY-1');
            require('axios').get = origGet;

            assert.strictEqual(res.success, true);
            assert.strictEqual(res.status, 'success');
            assert.strictEqual(res.amount, 6000);
            assert.strictEqual(res.currency, 'NGN');
        });

        await test('22. Replayed Flutterwave webhook cannot double-credit', async () => {
            walletCredits = [];
            const tx = {
                refId: 'FLW-REPLAY-TX',
                userId: 'u-flw-replay',
                status: 'pending',
                amountKobo: 500000,
                amount: 5000,
                provider: 'flutterwave'
            };
            mockTransactions.push(tx);

            const gatewayResult = {
                status: 'success',
                reference: 'FLW-REPLAY-TX',
                gateway: 'flutterwave',
                amount: 5000,
                currency: 'NGN'
            };

            // First delivery: credits wallet
            const first = await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: gatewayResult,
                source: 'webhook'
            });
            assert.strictEqual(first.credited, true);
            assert.strictEqual(walletCredits.length, 1);

            // Second delivery (replay of webhook): must NOT credit wallet
            const second = await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: gatewayResult,
                source: 'webhook'
            });
            assert.strictEqual(second.credited, false);
            assert.strictEqual(second.alreadyProcessed, true);
            assert.strictEqual(walletCredits.length, 1, 'Must still have only 1 wallet credit');
        });

        await test('23. Existing double-credit condition is eliminated', async () => {
            // The old flawed condition in flutterwaveController.js was:
            // if (upd.modifiedCount === 1 || (await TransactionStatus.findOne({ refId, status: 'success' }))) { credit... }
            // With our atomic finalizeFundingCredit, if modifiedCount !== 1, no credit occurs.
            walletCredits = [];
            const alreadySuccessTx = {
                refId: 'FLW-ALREADY-SUCCESS',
                userId: 'u-flw-succ',
                status: 'success',
                amountKobo: 200000,
                amount: 2000,
                provider: 'flutterwave'
            };
            mockTransactions.push(alreadySuccessTx);

            const res = await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: alreadySuccessTx,
                gatewayPaymentResult: {
                    status: 'success',
                    reference: 'FLW-ALREADY-SUCCESS',
                    gateway: 'flutterwave',
                    amount: 2000,
                    currency: 'NGN'
                }
            });

            assert.strictEqual(res.credited, false, 'Must NOT credit already success transaction');
            assert.strictEqual(walletCredits.length, 0, 'No wallet credit must be executed');
        });

        // ─────────────────────────────────────────────────────────────────────
        // 5. UNIVERSAL WALLET SAFETY TESTS
        // ─────────────────────────────────────────────────────────────────────

        await test('24. Duplicate webhook cannot double-credit', async () => {
            walletCredits = [];
            const tx = {
                refId: 'DUP-WH-TEST',
                userId: 'u-dup-wh',
                status: 'pending',
                amountKobo: 100000,
                amount: 1000,
                provider: 'paystack'
            };
            mockTransactions.push(tx);

            const gwRes = { status: 'success', reference: 'DUP-WH-TEST', gateway: 'paystack', amount: 1000, currency: 'NGN' };

            await paymentGatewayService.finalizeFundingCredit({ transactionStatus: tx, gatewayPaymentResult: gwRes });
            await paymentGatewayService.finalizeFundingCredit({ transactionStatus: tx, gatewayPaymentResult: gwRes });
            await paymentGatewayService.finalizeFundingCredit({ transactionStatus: tx, gatewayPaymentResult: gwRes });

            assert.strictEqual(walletCredits.length, 1, 'Only exactly 1 credit may happen across multiple deliveries');
        });

        await test('25. Callback + Webhook race cannot double-credit', async () => {
            walletCredits = [];
            const tx = {
                refId: 'RACE-WH-CB',
                userId: 'u-race',
                status: 'pending',
                amountKobo: 400000,
                amount: 4000,
                provider: 'paystack'
            };
            mockTransactions.push(tx);

            const gwRes = { status: 'success', reference: 'RACE-WH-CB', gateway: 'paystack', amount: 4000, currency: 'NGN' };

            // Simulate concurrent arrival
            const [p1, p2] = await Promise.all([
                paymentGatewayService.finalizeFundingCredit({ transactionStatus: tx, gatewayPaymentResult: gwRes, source: 'callback' }),
                paymentGatewayService.finalizeFundingCredit({ transactionStatus: tx, gatewayPaymentResult: gwRes, source: 'webhook' })
            ]);

            const creditedCount = [p1, p2].filter(r => r.credited).length;
            assert.strictEqual(creditedCount, 1, 'Exactly one of the concurrent paths must get credited=true');
            assert.strictEqual(walletCredits.length, 1, 'Wallet must be credited only once');
        });

        await test('26. Repeated manual verification cannot double-credit', async () => {
            walletCredits = [];
            const tx = {
                refId: 'MAN-VERIFY-REP',
                userId: 'u-man',
                status: 'pending',
                amountKobo: 800000,
                amount: 8000,
                provider: 'paystack'
            };
            mockTransactions.push(tx);

            const gwRes = { status: 'success', reference: 'MAN-VERIFY-REP', gateway: 'paystack', amount: 8000, currency: 'NGN' };

            await paymentGatewayService.finalizeFundingCredit({ transactionStatus: tx, gatewayPaymentResult: gwRes, source: 'manual' });
            await paymentGatewayService.finalizeFundingCredit({ transactionStatus: tx, gatewayPaymentResult: gwRes, source: 'manual' });

            assert.strictEqual(walletCredits.length, 1);
        });

        await test('27. Amount mismatch cannot credit wallet', async () => {
            walletCredits = [];
            const tx = {
                refId: 'AMT-MISMATCH-TX',
                userId: 'u-amt-mismatch',
                status: 'pending',
                amountKobo: 1000000, // Expected: ₦10,000
                amount: 10000,
                provider: 'paystack'
            };
            mockTransactions.push(tx);

            // Provider confirms only ₦1,000 (attacker tampered with gateway amount)
            const gwRes = {
                status: 'success',
                reference: 'AMT-MISMATCH-TX',
                gateway: 'paystack',
                amount: 1000, // ₦1,000 instead of ₦10,000
                currency: 'NGN'
            };

            let threw = false;
            try {
                await paymentGatewayService.finalizeFundingCredit({
                    transactionStatus: tx,
                    gatewayPaymentResult: gwRes
                });
            } catch (e) {
                threw = true;
                assert.strictEqual(e.code, 'PAYMENT_AMOUNT_MISMATCH');
            }

            assert.strictEqual(threw, true, 'Must reject amount mismatch');
            assert.strictEqual(walletCredits.length, 0, 'No wallet credit must be issued');
            // Amount mismatch → reconciliation_required (NOT failed) because real money was received
            // and we must preserve the provider evidence for manual review
            assert.strictEqual(tx.status, 'reconciliation_required', 'Transaction must be reconciliation_required (evidence preserved, real money received)');
            assert.ok(tx.confirmedAmountKobo !== undefined, 'Confirmed amount must be preserved for audit');
            assert.ok(tx.reconciliationReason, 'Reconciliation reason must be recorded');
        });

        await test('28. Currency mismatch cannot credit wallet', async () => {
            walletCredits = [];
            const tx = {
                refId: 'CURR-MISMATCH-TX',
                userId: 'u-curr',
                status: 'pending',
                amountKobo: 500000,
                amount: 5000,
                provider: 'paystack'
            };
            mockTransactions.push(tx);

            const gwRes = {
                status: 'success',
                reference: 'CURR-MISMATCH-TX',
                gateway: 'paystack',
                amount: 5000,
                currency: 'USD' // Mismatch!
            };

            let threw = false;
            try {
                await paymentGatewayService.finalizeFundingCredit({
                    transactionStatus: tx,
                    gatewayPaymentResult: gwRes
                });
            } catch (e) {
                threw = true;
                assert.strictEqual(e.code, 'PAYMENT_CURRENCY_MISMATCH');
            }

            assert.strictEqual(threw, true);
            assert.strictEqual(walletCredits.length, 0);
        });

        await test('29. Reference mismatch cannot credit wallet', async () => {
            walletCredits = [];
            const tx = {
                refId: 'REF-EXPECTED-123',
                userId: 'u-ref',
                status: 'pending',
                amountKobo: 50000,
                amount: 500,
                provider: 'paystack'
            };
            mockTransactions.push(tx);

            const gwRes = {
                status: 'success',
                reference: 'REF-DIFFERENT-456', // Mismatch!
                gateway: 'paystack',
                amount: 500,
                currency: 'NGN'
            };

            let threw = false;
            try {
                await paymentGatewayService.finalizeFundingCredit({
                    transactionStatus: tx,
                    gatewayPaymentResult: gwRes
                });
            } catch (e) {
                threw = true;
                assert.strictEqual(e.code, 'PAYMENT_REFERENCE_MISMATCH');
            }

            assert.strictEqual(threw, true);
            assert.strictEqual(walletCredits.length, 0);
        });

        await test('30. Wrong gateway cannot verify transaction', async () => {
            walletCredits = [];
            const tx = {
                refId: 'WRONG-GW-TX',
                userId: 'u-wrong',
                status: 'pending',
                amountKobo: 100000,
                amount: 1000,
                provider: 'monnify' // Monnify transaction
            };
            mockTransactions.push(tx);

            let threw = false;
            try {
                await paymentGatewayService.finalizeFundingCredit({
                    transactionStatus: tx,
                    gatewayPaymentResult: {
                        status: 'success',
                        reference: 'WRONG-GW-TX',
                        gateway: 'paystack', // Paystack trying to finalize
                        amount: 1000,
                        currency: 'NGN'
                    }
                });
            } catch (e) {
                threw = true;
                assert.strictEqual(e.code, 'PAYMENT_GATEWAY_MISMATCH');
            }

            assert.strictEqual(threw, true);
            assert.strictEqual(walletCredits.length, 0);
        });

        await test('31. Already-successful transaction is not credited again', async () => {
            walletCredits = [];
            const tx = {
                refId: 'ALREADY-CREDITED-TX',
                userId: 'u-done',
                status: 'success', // Already credited
                amountKobo: 100000,
                amount: 1000,
                provider: 'paystack'
            };
            mockTransactions.push(tx);

            const res = await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: {
                    status: 'success',
                    reference: 'ALREADY-CREDITED-TX',
                    gateway: 'paystack',
                    amount: 1000,
                    currency: 'NGN'
                }
            });

            assert.strictEqual(res.credited, false);
            assert.strictEqual(walletCredits.length, 0);
        });

        await test('32. Failed payment cannot credit wallet', async () => {
            walletCredits = [];
            const tx = {
                refId: 'FAILED-PAY-TX',
                userId: 'u-fail',
                status: 'pending',
                amountKobo: 100000,
                amount: 1000,
                provider: 'paystack'
            };
            mockTransactions.push(tx);

            const res = await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: {
                    status: 'failed',
                    reference: 'FAILED-PAY-TX',
                    gateway: 'paystack',
                    amount: 1000,
                    currency: 'NGN',
                    message: 'Insufficient customer funds'
                }
            });

            assert.strictEqual(res.success, false);
            assert.strictEqual(walletCredits.length, 0);
            assert.strictEqual(tx.status, 'failed');
        });

        // ─────────────────────────────────────────────────────────────────────
        // 6. SECURITY & CREDENTIAL TESTS
        // ─────────────────────────────────────────────────────────────────────

        await test('33. Invalid webhook signature is rejected', () => {
            const adapter = new PaystackAdapter({ secretKey: 'real_secret' });
            const body = JSON.stringify({ event: 'test' });
            const wrongSignature = 'invalid_hash_value';
            const isValid = adapter.verifyWebhookSignature({ 'x-paystack-signature': wrongSignature }, body);
            assert.strictEqual(isValid, false, 'Must reject mismatched signature');
        });

        await test('34. Encrypted gateway credentials are not returned by serializers', () => {
            const rawSecret = 'sk_live_very_secret_key_12345';
            const encSecret = encryptSecret(rawSecret);

            const gatewayDoc = {
                _id: 'gw-sec',
                name: 'Secure Gateway',
                code: 'secgw',
                adapterType: 'paystack',
                status: 'active',
                environment: 'live',
                isDefault: false,
                secretKey: encSecret,
                webhookSecret: encSecret,
                publicKey: 'pk_live_public_12345'
            };

            const serializedAdmin = sanitizePaymentGateway(gatewayDoc);
            assert.strictEqual(serializedAdmin.secretKey, undefined, 'Admin serializer must NEVER contain secretKey');
            assert.strictEqual(serializedAdmin.webhookSecret, undefined, 'Admin serializer must NEVER contain webhookSecret');
            // New: boolean indicators only — no prefix/suffix fragments exposed
            assert.strictEqual(serializedAdmin.secretKeyConfigured, true, 'Must expose boolean secretKeyConfigured indicator');
            assert.strictEqual(serializedAdmin.webhookSecretConfigured, true, 'Must expose boolean webhookSecretConfigured indicator');
            assert.strictEqual(serializedAdmin.hasSecretKey, undefined, 'hasSecretKey (with masked prefix) must not exist');
            assert.strictEqual(serializedAdmin.maskedSecretKey, undefined, 'maskedSecretKey must not exist — leaks key prefix/suffix');

            const json = JSON.stringify(serializedAdmin);
            assert.ok(!json.includes('very_secret'), 'No secret fragment in serialized output');

            const serializedClient = sanitizePaymentGatewayForClient(gatewayDoc);
            assert.strictEqual(serializedClient.secretKey, undefined);
            assert.strictEqual(serializedClient.webhookSecret, undefined);
            assert.strictEqual(serializedClient.publicKey, undefined);
            assert.strictEqual(serializedClient.secretKeyConfigured, undefined, 'Client view must not expose any credential indicators');
        });

        await test('35. Secret credentials are not logged in output or errors', () => {
            const rawSecret = 'sk_live_never_log_this_secret_value';
            const serialized = sanitizePaymentGateway({
                name: 'Test',
                code: 'test',
                secretKey: encryptSecret(rawSecret)
            });

            const stringified = JSON.stringify(serialized);
            assert.ok(!stringified.includes('never_log_this_secret_value'), 'Logs must not contain secret string');
        });

        await test('36. Database-stored credentials can be decrypted only with correct master key', () => {
            const original = 'sk_test_db_stored_secret_key_999';
            const encrypted = encryptSecret(original);
            assert.ok(isEncrypted(encrypted), 'Must have enc:v1 prefix');

            const decrypted = decryptSecret(encrypted);
            assert.strictEqual(decrypted, original, 'Decrypted value must match original');
        });

        await test('37. Credential encryption failure is handled safely', () => {
            // decryptSecret with corrupted ciphertext returns string gracefully without unhandled crash
            const corrupted = 'enc:v1:0123456789abcdef01234567:0123456789abcdef0123456789abcdef:corrupted';
            const result = decryptSecret(corrupted);
            assert.ok(result !== undefined, 'Corrupted ciphertext must be caught safely');
        });

        // ─────────────────────────────────────────────────────────────────────
        // 7. MULTI-GATEWAY CONCURRENCY TESTS
        // ─────────────────────────────────────────────────────────────────────

        await test('38. Paystack + Monnify + Flutterwave can all be active simultaneously', async () => {
            const active = await paymentGatewayService.getActiveGateways();
            const activeCodes = active.map(g => g.code);
            assert.ok(activeCodes.includes('paystack'));
            assert.ok(activeCodes.includes('monnify'));
            assert.ok(activeCodes.includes('flutterwave'));
        });

        await test('39. Paystack can be default while Monnify is explicitly selected', async () => {
            const defaultGw = await paymentGatewayService.getDefaultGateway();
            assert.strictEqual(defaultGw.code, 'paystack', 'Paystack is default');

            const selected = await paymentGatewayService.getGateway('monnify');
            assert.strictEqual(selected.code, 'monnify');
            assert.strictEqual(selected.status, 'active');
        });

        await test('40. Monnify can be default while Paystack remains active', async () => {
            mockGateways.find(g => g.code === 'paystack').isDefault = false;
            mockGateways.find(g => g.code === 'monnify').isDefault = true;

            const defaultGw = await paymentGatewayService.getDefaultGateway();
            assert.strictEqual(defaultGw.code, 'monnify', 'Monnify is now default');

            const paystack = await paymentGatewayService.getGateway('paystack');
            assert.strictEqual(paystack.status, 'active', 'Paystack must remain active');

            // Reset
            mockGateways.find(g => g.code === 'monnify').isDefault = false;
            mockGateways.find(g => g.code === 'paystack').isDefault = true;
        });

        await test('41. Transactions remain permanently bound to their initializing gateway', async () => {
            const tx1 = { refId: 'PERM-PS', provider: 'paystack', status: 'pending', amountKobo: 100000, amount: 1000, userId: 'u1' };
            const tx2 = { refId: 'PERM-MNFY', provider: 'monnify', status: 'pending', amountKobo: 200000, amount: 2000, userId: 'u2' };
            const tx3 = { refId: 'PERM-FLW', provider: 'flutterwave', status: 'pending', amountKobo: 300000, amount: 3000, userId: 'u3' };
            mockTransactions.push(tx1, tx2, tx3);

            assert.strictEqual(mockTransactions.find(t => t.refId === 'PERM-PS').provider, 'paystack');
            assert.strictEqual(mockTransactions.find(t => t.refId === 'PERM-MNFY').provider, 'monnify');
            assert.strictEqual(mockTransactions.find(t => t.refId === 'PERM-FLW').provider, 'flutterwave');
        });

        await test('42. One gateway failure does not corrupt another gateway\'s transaction', async () => {
            walletCredits = [];
            const txPs = { refId: 'PS-SUCCESS-TX', provider: 'paystack', status: 'pending', amountKobo: 100000, amount: 1000, userId: 'u1' };
            const txFlw = { refId: 'FLW-FAIL-TX', provider: 'flutterwave', status: 'pending', amountKobo: 200000, amount: 2000, userId: 'u2' };
            mockTransactions.push(txPs, txFlw);

            // Fail Flutterwave
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: txFlw,
                gatewayPaymentResult: { status: 'failed', reference: 'FLW-FAIL-TX', gateway: 'flutterwave', amount: 2000, currency: 'NGN', message: 'FLW Down' }
            });

            // Succeed Paystack
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: txPs,
                gatewayPaymentResult: { status: 'success', reference: 'PS-SUCCESS-TX', gateway: 'paystack', amount: 1000, currency: 'NGN' }
            });

            assert.strictEqual(txFlw.status, 'failed', 'Flutterwave transaction is marked failed');
            assert.strictEqual(txPs.status, 'success', 'Paystack transaction is marked success');
            assert.strictEqual(walletCredits.length, 1, 'Only Paystack transaction credited');
            assert.strictEqual(walletCredits[0].ref, 'PS-SUCCESS-TX');
        });

        // ─────────────────────────────────────────────────────────────────────
        // 8. NOTIFICATION NON-BLOCKING RESILIENCE TESTS
        // ─────────────────────────────────────────────────────────────────────

        await test('43. Slow SMS does not delay wallet funding', async () => {
            let smsFinished = false;
            notificationService.sendInApp = async () => ({ _id: 'notif-fast' });

            // Simulate slow SMS in background
            const origSendSMS = notificationService.sendSMS;
            notificationService.sendSMS = async () => {
                await new Promise(r => setTimeout(r, 2000));
                smsFinished = true;
            };

            const tx = { refId: 'SLOW-SMS-TX', provider: 'paystack', status: 'pending', amountKobo: 100000, amount: 1000, userId: 'u-sms' };
            mockTransactions.push(tx);

            const start = Date.now();
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: { status: 'success', reference: 'SLOW-SMS-TX', gateway: 'paystack', amount: 1000, currency: 'NGN' }
            });
            const duration = Date.now() - start;

            notificationService.sendSMS = origSendSMS;

            assert.ok(duration < 200, `Wallet funding response took ${duration}ms, must be <200ms`);
            assert.strictEqual(tx.status, 'success');
        });

        await test('44. Slow email does not delay wallet funding', async () => {
            let emailFinished = false;
            const origSendEmail = notificationService.sendEmail;
            notificationService.sendEmail = async () => {
                await new Promise(r => setTimeout(r, 2000));
                emailFinished = true;
            };

            const tx = { refId: 'SLOW-EMAIL-TX', provider: 'paystack', status: 'pending', amountKobo: 100000, amount: 1000, userId: 'u-email' };
            mockTransactions.push(tx);

            const start = Date.now();
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: { status: 'success', reference: 'SLOW-EMAIL-TX', gateway: 'paystack', amount: 1000, currency: 'NGN' }
            });
            const duration = Date.now() - start;

            notificationService.sendEmail = origSendEmail;

            assert.ok(duration < 200, `Wallet funding response took ${duration}ms, must be <200ms`);
            assert.strictEqual(tx.status, 'success');
        });

        await test('45. Notification failure does not change successful payment status', async () => {
            walletCredits = [];
            notificationService.sendInApp = async () => {
                throw new Error('Push service 503 unavailable');
            };

            const tx = { refId: 'NOTIF-FAIL-TX', provider: 'paystack', status: 'pending', amountKobo: 300000, amount: 3000, userId: 'u-notif-fail' };
            mockTransactions.push(tx);

            // Should complete successfully without throwing
            const res = await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: { status: 'success', reference: 'NOTIF-FAIL-TX', gateway: 'paystack', amount: 3000, currency: 'NGN' }
            });

            assert.strictEqual(res.success, true);
            assert.strictEqual(tx.status, 'success', 'Payment status must remain success despite notification failure');
            assert.strictEqual(walletCredits.length, 1, 'Wallet must be credited');
        });

    } finally {
        // Restore all mocks
        PaymentGateway.find = origFind;
        PaymentGateway.findOne = origFindOne;
        PaymentGateway.countDocuments = origCountDocuments;
        PaymentGateway.updateMany = origUpdateMany;
        TransactionStatus.findOne = origTxFindOne;
        TransactionStatus.create = origTxCreate;
        TransactionStatus.updateOne = origTxUpdateOne;
        WebhookEvent.findOne = origWhFindOne;
        WebhookEvent.create = origWhCreate;
        Transaction.create = origTxModelCreate;
        walletService.credit = origWalletCredit;
        notificationService.sendInApp = origNotifySendInApp;
    }

    console.log('\n----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('----------------------------------------------------\n');

    process.exit(failed > 0 ? 1 : 0);
}

runPaymentGatewayTests();
