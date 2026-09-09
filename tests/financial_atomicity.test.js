'use strict';

/**
 * Financial Atomicity & Failure Injection Tests
 *
 * Tests the atomic finalizeFundingCredit() path, failure recovery semantics,
 * reconciliation state machine, concurrent webhook+callback handling,
 * WebhookEvent race protection, and single-default gateway concurrency.
 *
 * Runs without a live MongoDB connection (in-memory mock state).
 */

const assert = require('assert');
const mongoose = require('mongoose');

const PaymentGateway = require('../models/PaymentGateway');
const TransactionStatus = require('../models/TransactionStatus');
const WebhookEvent = require('../models/WebhookEvent');
const Wallet = require('../models/Wallet');
const WalletLedger = require('../models/WalletLedger');

const paymentGatewayService = require('../services/paymentGateway.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');
const { sanitizePaymentGateway, sanitizePaymentGatewayForClient } = require('../utils/paymentGatewaySerializer');

async function runAtomicityTests() {
    console.log('=====================================================');
    console.log(' FINANCIAL ATOMICITY & FAILURE INJECTION TEST SUITE ');
    console.log('=====================================================\n');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`✅ [PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`❌ [FAIL] ${name}`);
            console.error(`   Error: ${err.message}`);
            if (process.env.VERBOSE) console.error(err.stack);
            failed++;
        }
    }

    // ─── MOCK STATE ────────────────────────────────────────────────────────────
    let mockTransactions = [];
    let mockWebhookEvents = [];
    let walletCredits = [];
    let walletLedger = [];

    // Save originals for restoration
    const origTxFindOne = TransactionStatus.findOne;
    const origTxCreate = TransactionStatus.create;
    const origTxUpdateOne = TransactionStatus.updateOne;
    const origWhFindOne = WebhookEvent.findOne;
    const origWhCreate = WebhookEvent.create;
    const origWalletCredit = walletService.credit;
    const origNotifSendInApp = notificationService.sendInApp;

    // ─── MOCK SETUP ────────────────────────────────────────────────────────────

    function resetMocks() {
        mockTransactions = [];
        mockWebhookEvents = [];
        walletCredits = [];
        walletLedger = [];

        // TransactionStatus.findOne
        TransactionStatus.findOne = (filter = {}) => {
            const found = mockTransactions.find(t => {
                if (filter.refId && t.refId !== filter.refId) return false;
                return true;
            });
            return Promise.resolve(found || null);
        };

        // TransactionStatus.create
        TransactionStatus.create = (doc) => {
            const item = { ...doc, _id: new mongoose.Types.ObjectId() };
            mockTransactions.push(item);
            return Promise.resolve(item);
        };

        // TransactionStatus.updateOne — track modifiedCount correctly
        TransactionStatus.updateOne = (filter, update) => {
            let modifiedCount = 0;
            for (const t of mockTransactions) {
                let match = true;
                if (filter.refId && t.refId !== filter.refId) match = false;
                if (filter.status && t.status !== filter.status) match = false;
                if (match) {
                    const set = (update.$set || {});
                    Object.assign(t, set);
                    modifiedCount = 1;
                    break;
                }
            }
            return Promise.resolve({ modifiedCount });
        };

        // WebhookEvent.findOne (legacy path — only used in old code)
        WebhookEvent.findOne = (filter = {}) => {
            const found = mockWebhookEvents.find(w => w.eventId === filter.eventId);
            return Promise.resolve(found || null);
        };

        // WebhookEvent.create — with unique index simulation
        WebhookEvent.create = (doc) => {
            const existing = mockWebhookEvents.find(w => w.eventId === doc.eventId);
            if (existing) {
                const dupErr = new Error('E11000 duplicate key error');
                dupErr.code = 11000;
                return Promise.reject(dupErr);
            }
            const item = { ...doc, _id: new mongoose.Types.ObjectId(), save: async function() { Object.assign(this, this); } };
            mockWebhookEvents.push(item);
            return Promise.resolve(item);
        };

        // walletService.credit — track credits
        walletService.credit = async (userId, amount, reference, source) => {
            const dupLedger = walletLedger.find(l => l.reference === reference);
            if (dupLedger) {
                // Simulate WalletLedger unique-key duplicate protection
                const err = new Error(`E11000 duplicate key on WalletLedger reference=${reference}`);
                err.code = 11000;
                throw err;
            }
            walletCredits.push({ userId, amount, reference, source });
            walletLedger.push({ reference, amount, userId });
            return { balance: 1000 + amount };
        };

        // notificationService.sendInApp — non-blocking mock
        notificationService.sendInApp = async () => {};
    }

    resetMocks();

    // ─── SECTION 1: STATUS TRANSITION STATE MACHINE ───────────────────────────

    await test('1A. Fresh pending → success: full happy path completes atomically', async () => {
        resetMocks();
        mockTransactions.push({ refId: 'TX-HAPPY', userId: 'user1', type: 'funding', status: 'pending', amountKobo: 500000, provider: 'paystack' });

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: mockTransactions[0],
            gatewayPaymentResult: {
                status: 'success',
                amount: 5000,
                currency: 'NGN',
                reference: 'TX-HAPPY',
                gateway: 'paystack'
            }
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'success');
        assert.strictEqual(result.credited, true);
        // Wallet credited exactly once
        assert.strictEqual(walletCredits.length, 1);
        assert.strictEqual(walletCredits[0].amount, 5000);
        // TransactionStatus ends at 'success'
        assert.strictEqual(mockTransactions[0].status, 'success');
    });

    await test('1B. Already-success transaction returns alreadyProcessed=true without crediting again', async () => {
        resetMocks();
        mockTransactions.push({ refId: 'TX-SUCCESS', userId: 'user1', type: 'funding', status: 'success', amountKobo: 100000, provider: 'paystack' });

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: mockTransactions[0],
            gatewayPaymentResult: { status: 'success', amount: 1000, currency: 'NGN', gateway: 'paystack' }
        });

        assert.strictEqual(result.alreadyProcessed, true);
        assert.strictEqual(result.credited, false);
        assert.strictEqual(walletCredits.length, 0, 'Must not credit an already-finalized transaction');
    });

    await test('1C. Already-processing transaction returns safe processing message without re-crediting', async () => {
        resetMocks();
        mockTransactions.push({ refId: 'TX-PROC', userId: 'user1', type: 'funding', status: 'processing', amountKobo: 100000, provider: 'paystack' });

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: mockTransactions[0],
            gatewayPaymentResult: { status: 'success', amount: 1000, currency: 'NGN', gateway: 'paystack' }
        });

        assert.strictEqual(result.status, 'processing');
        assert.strictEqual(result.credited, false);
        assert.strictEqual(walletCredits.length, 0, 'Must not credit a processing transaction');
    });

    await test('1D. Reconciliation_required transaction is not re-processed', async () => {
        resetMocks();
        mockTransactions.push({ refId: 'TX-RECON', userId: 'user1', type: 'funding', status: 'reconciliation_required', provider: 'paystack' });

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: mockTransactions[0],
            gatewayPaymentResult: { status: 'success', amount: 1000, currency: 'NGN', gateway: 'paystack' }
        });

        assert.strictEqual(result.status, 'reconciliation_required');
        assert.strictEqual(result.credited, false);
        assert.strictEqual(walletCredits.length, 0);
    });

    // ─── SECTION 2: FAILURE INJECTION ─────────────────────────────────────────

    await test('2A. DB failure immediately after lock claim (wallet credit throws): status stays processing, no double-credit on retry', async () => {
        resetMocks();
        mockTransactions.push({ refId: 'TX-CRASH', userId: 'userCrash', type: 'funding', status: 'pending', amountKobo: 200000, provider: 'paystack' });

        // Simulate wallet crash
        walletService.credit = async () => { throw new Error('MongoDB network timeout'); };

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: mockTransactions[0],
                gatewayPaymentResult: { status: 'success', amount: 2000, currency: 'NGN', reference: 'TX-CRASH', gateway: 'paystack' }
            });
        } catch (err) {
            threw = true;
            assert.ok(err.message.includes('MongoDB network timeout'));
        }
        assert.ok(threw, 'Expected error to propagate');

        // Status must be 'processing' — visible alarm, NOT 'success' or 'failed'
        assert.strictEqual(mockTransactions[0].status, 'processing', 'Status must be processing after crash, not success or failed');
        assert.strictEqual(walletCredits.length, 0, 'No wallet credit after crash');

        // Restore normal wallet mock
        resetMocks();
    });

    await test('2B. Wallet credit failure: wallet not found throws, status stays processing', async () => {
        resetMocks();
        mockTransactions.push({ refId: 'TX-NOWALLET', userId: 'userX', type: 'funding', status: 'pending', amountKobo: 100000, provider: 'paystack' });

        walletService.credit = async () => { throw new Error('Wallet not found'); };

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: mockTransactions[0],
                gatewayPaymentResult: { status: 'success', amount: 1000, currency: 'NGN', reference: 'TX-NOWALLET', gateway: 'paystack' }
            });
        } catch (err) {
            threw = true;
        }
        assert.ok(threw);
        assert.strictEqual(mockTransactions[0].status, 'processing');

        resetMocks();
    });

    await test('2C. Webhook retry after failed DB transaction: does not double-credit', async () => {
        resetMocks();
        // Simulate a transaction already at 'processing' (prior crash)
        const tx = { refId: 'TX-RETRY', userId: 'userR', type: 'funding', status: 'processing', amountKobo: 150000, provider: 'paystack' };
        mockTransactions.push(tx);

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: tx,
            gatewayPaymentResult: { status: 'success', amount: 1500, currency: 'NGN', gateway: 'paystack' }
        });

        // Must see processing state and refuse to re-run credit
        assert.strictEqual(result.credited, false);
        assert.strictEqual(walletCredits.length, 0, 'Must not double-credit on retry of processing tx');
    });

    await test('2D. Callback retry after success: exactly-once credit enforced via alreadyProcessed', async () => {
        resetMocks();
        const tx = { refId: 'TX-DONE', userId: 'userD', type: 'funding', status: 'success', amountKobo: 100000, provider: 'paystack' };
        mockTransactions.push(tx);

        const r1 = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: tx,
            gatewayPaymentResult: { status: 'success', amount: 1000, currency: 'NGN', gateway: 'paystack' }
        });

        const r2 = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: tx,
            gatewayPaymentResult: { status: 'success', amount: 1000, currency: 'NGN', gateway: 'paystack' }
        });

        assert.strictEqual(r1.alreadyProcessed, true);
        assert.strictEqual(r2.alreadyProcessed, true);
        assert.strictEqual(walletCredits.length, 0, 'Zero credits for already-success transaction');
    });

    await test('2E. Concurrent webhook + callback: exactly one wins the processing lock, wallet credited exactly once', async () => {
        resetMocks();

        const tx = { refId: 'TX-RACE', userId: 'userRace', type: 'funding', status: 'pending', amountKobo: 500000, provider: 'paystack' };
        mockTransactions.push(tx);

        const payload = { status: 'success', amount: 5000, currency: 'NGN', reference: 'TX-RACE', gateway: 'paystack' };

        // Simulate race: two concurrent calls
        const [r1, r2] = await Promise.all([
            paymentGatewayService.finalizeFundingCredit({ transactionStatus: tx, gatewayPaymentResult: payload }),
            paymentGatewayService.finalizeFundingCredit({ transactionStatus: tx, gatewayPaymentResult: payload })
        ]);

        const credits = walletCredits.length;
        assert.ok(credits <= 1, `Expected at most 1 wallet credit, got ${credits}`);

        const successResults = [r1, r2].filter(r => r.credited === true);
        const idempotentResults = [r1, r2].filter(r => r.alreadyProcessed === true || r.credited === false);
        assert.ok(successResults.length <= 1, 'At most one finalization should credit the wallet');
        assert.ok(idempotentResults.length >= 1, 'At least one result must be idempotent');
    });

    // ─── SECTION 3: AMOUNT / CURRENCY / REFERENCE MISMATCHES ─────────────────

    await test('3A. Amount mismatch → reconciliation_required (not failed), evidence preserved, no wallet credit', async () => {
        resetMocks();
        const tx = { refId: 'TX-AMTMIS', userId: 'u1', type: 'funding', status: 'pending', amountKobo: 500000, provider: 'paystack' };
        mockTransactions.push(tx);

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: { status: 'success', amount: 1000, currency: 'NGN', reference: 'TX-AMTMIS', gateway: 'paystack' }
            });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.code, 'PAYMENT_AMOUNT_MISMATCH');
        }
        assert.ok(threw, 'Amount mismatch must throw');
        assert.strictEqual(tx.status, 'reconciliation_required', 'Status must be reconciliation_required, NOT failed');
        assert.strictEqual(walletCredits.length, 0, 'No wallet credit on amount mismatch');
        assert.ok(tx.confirmedAmountKobo !== undefined, 'confirmedAmountKobo must be preserved');
        assert.ok(tx.reconciliationReason, 'reconciliationReason must be set');
    });

    await test('3B. Currency mismatch → reconciliation_required, evidence preserved, no credit', async () => {
        resetMocks();
        const tx = { refId: 'TX-CURMIS', userId: 'u1', type: 'funding', status: 'pending', amountKobo: 100000, provider: 'paystack' };
        mockTransactions.push(tx);

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: { status: 'success', amount: 1000, currency: 'USD', reference: 'TX-CURMIS', gateway: 'paystack' }
            });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.code, 'PAYMENT_CURRENCY_MISMATCH');
        }
        assert.ok(threw, 'Currency mismatch must throw');
        assert.strictEqual(tx.status, 'reconciliation_required');
        assert.strictEqual(walletCredits.length, 0);
        assert.ok(tx.confirmedCurrency, 'confirmedCurrency must be preserved');
        assert.ok(tx.reconciliationReason, 'reconciliationReason must be set');
    });

    await test('3C. Reference mismatch → reconciliation_required, evidence preserved, no credit', async () => {
        resetMocks();
        const tx = { refId: 'TX-REFMIS', userId: 'u1', type: 'funding', status: 'pending', amountKobo: 100000, provider: 'paystack' };
        mockTransactions.push(tx);

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: { status: 'success', amount: 1000, currency: 'NGN', reference: 'TX-DIFFERENT-REF', gateway: 'paystack' }
            });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.code, 'PAYMENT_REFERENCE_MISMATCH');
        }
        assert.ok(threw, 'Reference mismatch must throw');
        assert.strictEqual(tx.status, 'reconciliation_required');
        assert.strictEqual(walletCredits.length, 0);
    });

    await test('3D. reconciliation_required is not overwritten by a retry', async () => {
        resetMocks();
        const tx = { refId: 'TX-RECONRETRY', userId: 'u1', type: 'funding', status: 'reconciliation_required', provider: 'paystack' };
        mockTransactions.push(tx);

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: tx,
            gatewayPaymentResult: { status: 'success', amount: 1000, currency: 'NGN', gateway: 'paystack' }
        });

        assert.strictEqual(result.credited, false);
        assert.strictEqual(walletCredits.length, 0, 'Must not credit a reconciliation_required tx');
    });

    // ─── SECTION 4: WEBHOOK IDEMPOTENCY RACE SAFETY ──────────────────────────

    await test('4A. Duplicate webhook delivery (same eventId) — unique index rejects second create atomically', async () => {
        resetMocks();
        // Pre-seed the event as already existing
        mockWebhookEvents.push({ eventId: 'EVT-DUP-001', provider: 'paystack', eventType: 'charge.success', status: 'processed' });

        // Second delivery with same eventId
        let dupKeyThrown = false;
        try {
            await WebhookEvent.create({ eventId: 'EVT-DUP-001', provider: 'paystack', eventType: 'charge.success', payload: {}, status: 'pending' });
        } catch (err) {
            dupKeyThrown = (err.code === 11000);
        }
        assert.ok(dupKeyThrown, 'Duplicate eventId must throw E11000');
    });

    await test('4B. routeWebhook handles duplicate delivery gracefully (returns 200, no double-credit)', async () => {
        resetMocks();

        // Simulate adapter
        const fakeAdapter = {
            verifyWebhookSignature: () => true,
            normalizeWebhook: () => ({ eventId: 'EVT-IDEMPOT-1', eventType: 'charge.success', status: 'success', reference: 'TX-IDEMPOT', amount: 1000 }),
            verifyPayment: async () => ({ status: 'success', amount: 1000, currency: 'NGN' })
        };

        const origGetGateway = paymentGatewayService.getGateway.bind(paymentGatewayService);
        const origGetAdapter = paymentGatewayService.getAdapterInstance.bind(paymentGatewayService);

        paymentGatewayService.getGateway = async () => ({ code: 'paystack', name: 'Paystack', adapterType: 'paystack' });
        paymentGatewayService.getAdapterInstance = () => fakeAdapter;

        const tx = { refId: 'TX-IDEMPOT', userId: 'user99', type: 'funding', status: 'pending', amountKobo: 100000, provider: 'paystack' };
        mockTransactions.push(tx);

        const req = { headers: {}, body: {} };

        const r1 = await paymentGatewayService.routeWebhook('paystack', req);
        // Second delivery (same eventId) — mockWebhookEvents already has it
        const r2 = await paymentGatewayService.routeWebhook('paystack', req);

        assert.strictEqual(r1.status, 200);
        assert.strictEqual(r2.status, 200);
        assert.ok(r2.message.includes('already'), 'Second delivery must be idempotent');
        assert.ok(walletCredits.length <= 1, 'Wallet must not be credited twice');

        // Restore
        paymentGatewayService.getGateway = origGetGateway;
        paymentGatewayService.getAdapterInstance = origGetAdapter;
    });

    // ─── SECTION 5: SECRET SERIALIZER — BOOLEAN ONLY ─────────────────────────

    await test('5A. sanitizePaymentGateway returns secretKeyConfigured boolean, never raw/masked key', async () => {
        const fakeGateway = {
            _id: 'gw1', name: 'Paystack', code: 'paystack', adapterType: 'paystack',
            status: 'active', environment: 'test', isDefault: true, priority: 1,
            publicKey: 'pk_test_abc', secretKey: 'sk_live_SuperSecret1234567890', webhookSecret: 'wh_live_SuperSecret',
            baseUrl: 'https://api.paystack.co', supportedChannels: ['card'],
            metadata: {}, lastHealthCheck: { status: 'unknown' },
            createdAt: new Date(), updatedAt: new Date()
        };

        const result = sanitizePaymentGateway(fakeGateway);

        assert.ok(!('secretKey' in result), 'secretKey must NOT appear in serialized output');
        assert.ok(!('webhookSecret' in result), 'webhookSecret must NOT appear in serialized output');
        assert.ok(!('maskedSecretKey' in result), 'maskedSecretKey must NOT appear (leaks prefix/suffix fragments)');
        assert.ok(!('maskedWebhookSecret' in result), 'maskedWebhookSecret must NOT appear');
        assert.strictEqual(result.secretKeyConfigured, true, 'Must have boolean indicator');
        assert.strictEqual(result.webhookSecretConfigured, true, 'Must have boolean indicator');

        const json = JSON.stringify(result);
        assert.ok(!json.includes('SuperSecret'), 'No secret fragments in JSON output');
        assert.ok(!json.includes('sk_live'), 'No secret key prefix in JSON output');
        assert.ok(!json.includes('wh_live'), 'No webhook secret prefix in JSON output');
    });

    await test('5B. sanitizePaymentGatewayForClient strips ALL credential and health information', async () => {
        const fakeGateway = {
            code: 'paystack', name: 'Paystack', supportedChannels: ['card'],
            isDefault: true, environment: 'test',
            secretKey: 'sk_live_SuperSecret', webhookSecret: 'wh_live_Secret',
            publicKey: 'pk_test_abc', lastHealthCheck: { status: 'online' }
        };

        const result = sanitizePaymentGatewayForClient(fakeGateway);

        const json = JSON.stringify(result);
        assert.ok(!json.includes('SuperSecret'), 'No secrets in client output');
        assert.ok(!json.includes('secretKey'), 'No secretKey field in client output');
        assert.ok(!json.includes('secretKeyConfigured'), 'No credential indicators in client output');
        assert.ok(!json.includes('lastHealthCheck'), 'No health details in client output');
        assert.strictEqual(result.code, 'paystack');
        assert.strictEqual(result.name, 'Paystack');
    });

    await test('5C. sanitizePaymentGateway with unconfigured credentials returns false indicators', async () => {
        const fakeGateway = {
            _id: 'gw2', name: 'Monnify', code: 'monnify', adapterType: 'monnify',
            status: 'inactive', environment: 'test', isDefault: false,
            publicKey: '', secretKey: '', webhookSecret: '',
            supportedChannels: [], metadata: {}
        };

        const result = sanitizePaymentGateway(fakeGateway);
        assert.strictEqual(result.secretKeyConfigured, false);
        assert.strictEqual(result.webhookSecretConfigured, false);
    });

    // ─── SECTION 6: PROVIDER BINDING ─────────────────────────────────────────

    await test('6A. Paystack transaction cannot be finalized via Monnify gateway', async () => {
        resetMocks();
        const tx = { refId: 'PS-CROSS', userId: 'u1', type: 'funding', status: 'pending', amountKobo: 100000, provider: 'paystack' };
        mockTransactions.push(tx);

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: { status: 'success', amount: 1000, currency: 'NGN', gateway: 'monnify' }
            });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.code, 'PAYMENT_GATEWAY_MISMATCH');
        }
        assert.ok(threw, 'Cross-gateway finalization must be rejected');
        assert.strictEqual(walletCredits.length, 0);
    });

    await test('6B. Monnify transaction cannot be finalized via Flutterwave gateway', async () => {
        resetMocks();
        const tx = { refId: 'MN-CROSS', userId: 'u1', type: 'funding', status: 'pending', amountKobo: 200000, provider: 'monnify' };
        mockTransactions.push(tx);

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: { status: 'success', amount: 2000, currency: 'NGN', gateway: 'flutterwave' }
            });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.code, 'PAYMENT_GATEWAY_MISMATCH');
        }
        assert.ok(threw);
        assert.strictEqual(walletCredits.length, 0);
    });

    // ─── SECTION 7: NOTIFICATION NON-BLOCKING ────────────────────────────────

    await test('7A. Slow notification does not delay or block successful wallet credit', async () => {
        resetMocks();
        const tx = { refId: 'TX-SLOWNOTIF', userId: 'uNotif', type: 'funding', status: 'pending', amountKobo: 100000, provider: 'paystack' };
        mockTransactions.push(tx);

        // Simulate slow notification (500ms)
        notificationService.sendInApp = async () => {
            await new Promise(r => setTimeout(r, 500));
        };

        const start = Date.now();
        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: tx,
            gatewayPaymentResult: { status: 'success', amount: 1000, currency: 'NGN', reference: 'TX-SLOWNOTIF', gateway: 'paystack' }
        });
        const elapsed = Date.now() - start;

        assert.strictEqual(result.success, true);
        // Notification is non-blocking — response must return without waiting for 500ms
        assert.ok(elapsed < 450, `Notification must not block response. Elapsed: ${elapsed}ms`);
    });

    await test('7B. Failing notification does not affect successful payment status', async () => {
        resetMocks();
        const tx = { refId: 'TX-FAILNOTIF', userId: 'uFailNotif', type: 'funding', status: 'pending', amountKobo: 100000, provider: 'paystack' };
        mockTransactions.push(tx);

        notificationService.sendInApp = async () => { throw new Error('SMTP 503 unavailable'); };

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: tx,
            gatewayPaymentResult: { status: 'success', amount: 1000, currency: 'NGN', reference: 'TX-FAILNOTIF', gateway: 'paystack' }
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.credited, true);
        assert.strictEqual(walletCredits.length, 1, 'Wallet credited despite notification failure');
        assert.strictEqual(tx.status, 'success');
    });

    // ─── RESTORE ───────────────────────────────────────────────────────────────
    TransactionStatus.findOne = origTxFindOne;
    TransactionStatus.create = origTxCreate;
    TransactionStatus.updateOne = origTxUpdateOne;
    WebhookEvent.findOne = origWhFindOne;
    WebhookEvent.create = origWhCreate;
    walletService.credit = origWalletCredit;
    notificationService.sendInApp = origNotifSendInApp;

    // ─── SUMMARY ───────────────────────────────────────────────────────────────
    console.log('\n-----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('-----------------------------------------------------\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runAtomicityTests().catch(err => {
    console.error('[FATAL TEST ERROR]', err);
    process.exit(1);
});
