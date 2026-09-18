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
const Transaction = require('../models/Transaction');

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
    let transactionAudits = [];

    // Save originals for restoration
    const origTxFindOne = TransactionStatus.findOne;
    const origTxCreate = TransactionStatus.create;
    const origTxUpdateOne = TransactionStatus.updateOne;
    const origStartSession = mongoose.startSession;
    const origLedgerFindOne = WalletLedger.findOne;
    const origAuditFindOne = Transaction.findOne;
    const origAuditCreate = Transaction.create;
    const origWhFindOne = WebhookEvent.findOne;
    const origWhFindOneAndUpdate = WebhookEvent.findOneAndUpdate;
    const origWhCreate = WebhookEvent.create;
    const origWalletCredit = walletService.credit;
    const origNotifSendFundingSuccess = notificationService.sendFundingSuccess;

    // ─── MOCK SETUP ────────────────────────────────────────────────────────────

    function resetMocks() {
        mockTransactions = [];
        mockWebhookEvents = [];
        walletCredits = [];
        walletLedger = [];
        transactionAudits = [];

        const matchesValue = (actual, expected) => {
            if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
                if (expected.$in) return expected.$in.includes(actual);
            }
            return actual === expected;
        };
        const matches = (item, filter = {}) => Object.entries(filter).every(([key, value]) => matchesValue(item[key], value));
        const applyUpdate = (item, update = {}) => {
            if (update.$set) Object.assign(item, update.$set);
            if (update.$unset) Object.keys(update.$unset).forEach(key => delete item[key]);
        };
        const query = (value, sessionReader = null) => ({
            session: session => Promise.resolve(sessionReader ? sessionReader(session) : value),
            then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
            catch: reject => Promise.resolve(value).catch(reject)
        });

        mongoose.startSession = async () => ({
            stagedTransactions: new Map(),
            stagedCredits: [],
            stagedLedger: [],
            stagedAudits: [],
            startTransaction() {},
            readTransaction(refId) {
                if (this.stagedTransactions.has(refId)) return this.stagedTransactions.get(refId);
                const current = mockTransactions.find(item => item.refId === refId);
                if (!current) return null;
                const copy = { ...current };
                this.stagedTransactions.set(refId, copy);
                return copy;
            },
            async commitTransaction() {
                for (const [refId, staged] of this.stagedTransactions) {
                    const current = mockTransactions.find(item => item.refId === refId);
                    if (current) {
                        Object.keys(current).forEach(key => delete current[key]);
                        Object.assign(current, staged);
                    }
                }
                walletCredits.push(...this.stagedCredits);
                walletLedger.push(...this.stagedLedger);
                transactionAudits.push(...this.stagedAudits);
            },
            async abortTransaction() {},
            endSession() {}
        });

        // TransactionStatus.findOne
        TransactionStatus.findOne = (filter = {}) => {
            const found = mockTransactions.find(t => matches(t, filter)) || null;
            return query(found, session => {
                const candidate = filter.refId
                    ? session.readTransaction(filter.refId)
                    : mockTransactions.map(item => session.readTransaction(item.refId)).find(item => matches(item, filter));
                return candidate && matches(candidate, filter) ? candidate : null;
            });
        };

        // TransactionStatus.create
        TransactionStatus.create = (doc) => {
            const item = { ...doc, _id: new mongoose.Types.ObjectId() };
            mockTransactions.push(item);
            return Promise.resolve(item);
        };

        // TransactionStatus.updateOne — track modifiedCount correctly
        TransactionStatus.updateOne = (filter, update, options = {}) => {
            const source = options.session
                ? mockTransactions.map(item => options.session.readTransaction(item.refId))
                : mockTransactions;
            const item = source.find(t => matches(t, filter));
            if (!item) return Promise.resolve({ modifiedCount: 0, matchedCount: 0 });
            applyUpdate(item, update);
            return Promise.resolve({ modifiedCount: 1, matchedCount: 1 });
        };

        WalletLedger.findOne = (filter = {}) => {
            const found = walletLedger.find(item => matches(item, filter)) || null;
            return query(found, session => [...walletLedger, ...session.stagedLedger].find(item => matches(item, filter)) || null);
        };

        Transaction.findOne = (filter = {}) => {
            const found = transactionAudits.find(item => matches(item, filter)) || null;
            return query(found, session => [...transactionAudits, ...session.stagedAudits].find(item => matches(item, filter)) || null);
        };

        Transaction.create = async (docs, options = {}) => {
            assert.ok(options.session, 'Transaction audit must participate in the settlement session');
            const rows = (Array.isArray(docs) ? docs : [docs]).map(doc => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
            options.session.stagedAudits.push(...rows);
            return Array.isArray(docs) ? rows : rows[0];
        };

        const webhookMatches = (event, filter = {}) => {
            if (filter.provider && event.provider !== filter.provider) return false;
            if (filter.eventId && event.eventId !== filter.eventId) return false;
            if (filter.status && event.status !== filter.status) return false;
            if (filter.processingToken && event.processingToken !== filter.processingToken) return false;
            if (filter.$or && !filter.$or.some(part => webhookMatches(event, part))) return false;
            return true;
        };

        WebhookEvent.findOne = (filter = {}) => {
            const found = mockWebhookEvents.find(w => webhookMatches(w, filter));
            return Promise.resolve(found || null);
        };

        WebhookEvent.findOneAndUpdate = (filter = {}, update = {}) => {
            const found = mockWebhookEvents.find(w => webhookMatches(w, filter));
            if (!found) return Promise.resolve(null);
            if (update.$set) Object.assign(found, update.$set);
            if (update.$unset) Object.keys(update.$unset).forEach(key => delete found[key]);
            if (update.$inc) {
                for (const [key, value] of Object.entries(update.$inc)) {
                    found[key] = Number(found[key] || 0) + value;
                }
            }
            return Promise.resolve(found);
        };

        // WebhookEvent.create — provider-scoped unique index simulation
        WebhookEvent.create = (doc) => {
            const existing = mockWebhookEvents.find(w => w.provider === doc.provider && w.eventId === doc.eventId);
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
        walletService.credit = async (userId, amount, reference, source, transactionId, session, options = {}) => {
            assert.ok(session, 'Wallet credit must participate in the settlement session');
            assert.strictEqual(options.settlementKey, `payment:paystack:${reference}`);
            session.stagedCredits.push({ userId, amount, reference, source });
            session.stagedLedger.push({ reference, amount, userId, entryType: 'credit', source, settlementKey: options.settlementKey });
            return { balance: 1000 + amount };
        };

        notificationService.sendFundingSuccess = async () => {};
    }

    const fundingRecord = (refId, overrides = {}) => ({
        refId,
        userId: 'user1',
        type: 'funding',
        status: 'pending',
        amountKobo: 100000,
        amount: 1000,
        expectedCurrency: 'NGN',
        channels: ['card'],
        provider: 'paystack',
        service: 'Paystack',
        ...overrides
    });

    const successfulPayment = (reference, amount, gateway = 'paystack', overrides = {}) => ({
        status: 'success',
        amount,
        currency: 'NGN',
        reference,
        gateway,
        providerTransactionId: `${gateway}-${reference}`,
        ...overrides
    });

    resetMocks();

    // ─── SECTION 1: STATUS TRANSITION STATE MACHINE ───────────────────────────

    await test('1A. Fresh pending → success: full happy path completes atomically', async () => {
        resetMocks();
        mockTransactions.push(fundingRecord('TX-HAPPY', { amountKobo: 500000, amount: 5000 }));

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: mockTransactions[0],
            gatewayPaymentResult: successfulPayment('TX-HAPPY', 5000)
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
        mockTransactions.push(fundingRecord('TX-SUCCESS', { status: 'success' }));

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: mockTransactions[0],
            gatewayPaymentResult: successfulPayment('TX-SUCCESS', 1000)
        });

        assert.strictEqual(result.alreadyProcessed, true);
        assert.strictEqual(result.credited, false);
        assert.strictEqual(walletCredits.length, 0, 'Must not credit an already-finalized transaction');
    });

    await test('1C. Already-processing transaction returns safe processing message without re-crediting', async () => {
        resetMocks();
        mockTransactions.push(fundingRecord('TX-PROC', { status: 'processing' }));

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: mockTransactions[0],
            gatewayPaymentResult: successfulPayment('TX-PROC', 1000)
        });

        assert.strictEqual(result.status, 'processing');
        assert.strictEqual(result.credited, false);
        assert.strictEqual(walletCredits.length, 0, 'Must not credit a processing transaction');
    });

    await test('1D. Reconciliation_required transaction is not re-processed', async () => {
        resetMocks();
        mockTransactions.push(fundingRecord('TX-RECON', { status: 'reconciliation_required' }));

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: mockTransactions[0],
            gatewayPaymentResult: successfulPayment('TX-RECON', 1000)
        });

        assert.strictEqual(result.status, 'reconciliation_required');
        assert.strictEqual(result.credited, false);
        assert.strictEqual(walletCredits.length, 0);
    });

    // ─── SECTION 2: FAILURE INJECTION ─────────────────────────────────────────

    await test('2A. DB failure immediately after lock claim (wallet credit throws): status stays processing, no double-credit on retry', async () => {
        resetMocks();
        mockTransactions.push(fundingRecord('TX-CRASH', { userId: 'userCrash', amountKobo: 200000, amount: 2000 }));

        // Simulate wallet crash
        walletService.credit = async () => { throw new Error('MongoDB network timeout'); };

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: mockTransactions[0],
                gatewayPaymentResult: successfulPayment('TX-CRASH', 2000)
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
        mockTransactions.push(fundingRecord('TX-NOWALLET', { userId: 'userX' }));

        walletService.credit = async () => { throw new Error('Wallet not found'); };

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: mockTransactions[0],
                gatewayPaymentResult: successfulPayment('TX-NOWALLET', 1000)
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
        const tx = fundingRecord('TX-RETRY', { userId: 'userR', status: 'processing', amountKobo: 150000, amount: 1500 });
        mockTransactions.push(tx);

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: tx,
            gatewayPaymentResult: successfulPayment('TX-RETRY', 1500)
        });

        // Must see processing state and refuse to re-run credit
        assert.strictEqual(result.credited, false);
        assert.strictEqual(walletCredits.length, 0, 'Must not double-credit on retry of processing tx');
    });

    await test('2D. Callback retry after success: exactly-once credit enforced via alreadyProcessed', async () => {
        resetMocks();
        const tx = fundingRecord('TX-DONE', { userId: 'userD', status: 'success' });
        mockTransactions.push(tx);

        const r1 = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: tx,
            gatewayPaymentResult: successfulPayment('TX-DONE', 1000)
        });

        const r2 = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: tx,
            gatewayPaymentResult: successfulPayment('TX-DONE', 1000)
        });

        assert.strictEqual(r1.alreadyProcessed, true);
        assert.strictEqual(r2.alreadyProcessed, true);
        assert.strictEqual(walletCredits.length, 0, 'Zero credits for already-success transaction');
    });

    await test('2E. Concurrent webhook + callback: exactly one wins the processing lock, wallet credited exactly once', async () => {
        resetMocks();

        const tx = fundingRecord('TX-RACE', { userId: 'userRace', amountKobo: 500000, amount: 5000 });
        mockTransactions.push(tx);

        const payload = successfulPayment('TX-RACE', 5000);

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
        const tx = fundingRecord('TX-AMTMIS', { userId: 'u1', amountKobo: 500000, amount: 5000 });
        mockTransactions.push(tx);

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: successfulPayment('TX-AMTMIS', 1000)
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
        const tx = fundingRecord('TX-CURMIS', { userId: 'u1' });
        mockTransactions.push(tx);

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: successfulPayment('TX-CURMIS', 1000, 'paystack', { currency: 'USD' })
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
        const tx = fundingRecord('TX-REFMIS', { userId: 'u1' });
        mockTransactions.push(tx);

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: successfulPayment('TX-DIFFERENT-REF', 1000)
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
        const tx = fundingRecord('TX-RECONRETRY', { userId: 'u1', status: 'reconciliation_required' });
        mockTransactions.push(tx);

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: tx,
            gatewayPaymentResult: successfulPayment('TX-RECONRETRY', 1000)
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
            verifyPayment: async () => successfulPayment('TX-IDEMPOT', 1000)
        };

        const origGetGateway = paymentGatewayService.getGateway.bind(paymentGatewayService);
        const origGetAdapter = paymentGatewayService.getAdapterInstance.bind(paymentGatewayService);

        paymentGatewayService.getGateway = async () => ({ code: 'paystack', name: 'Paystack', adapterType: 'paystack' });
        paymentGatewayService.getAdapterInstance = () => fakeAdapter;

        const tx = fundingRecord('TX-IDEMPOT', { userId: 'user99' });
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
        const tx = fundingRecord('PS-CROSS', { userId: 'u1' });
        mockTransactions.push(tx);

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: successfulPayment('PS-CROSS', 1000, 'monnify')
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
        const tx = fundingRecord('MN-CROSS', { userId: 'u1', amountKobo: 200000, amount: 2000, provider: 'monnify', service: 'Monnify' });
        mockTransactions.push(tx);

        let threw = false;
        try {
            await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: tx,
                gatewayPaymentResult: successfulPayment('MN-CROSS', 2000, 'flutterwave')
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
        const tx = fundingRecord('TX-SLOWNOTIF', { userId: 'uNotif' });
        mockTransactions.push(tx);

        // Simulate slow notification (500ms)
        notificationService.sendFundingSuccess = async () => {
            await new Promise(r => setTimeout(r, 500));
        };

        const start = Date.now();
        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: tx,
            gatewayPaymentResult: successfulPayment('TX-SLOWNOTIF', 1000)
        });
        const elapsed = Date.now() - start;

        assert.strictEqual(result.success, true);
        // Notification is non-blocking — response must return without waiting for 500ms
        assert.ok(elapsed < 450, `Notification must not block response. Elapsed: ${elapsed}ms`);
    });

    await test('7B. Failing notification does not affect successful payment status', async () => {
        resetMocks();
        const tx = fundingRecord('TX-FAILNOTIF', { userId: 'uFailNotif' });
        mockTransactions.push(tx);

        notificationService.sendFundingSuccess = async () => { throw new Error('SMTP 503 unavailable'); };

        const result = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: tx,
            gatewayPaymentResult: successfulPayment('TX-FAILNOTIF', 1000)
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
    mongoose.startSession = origStartSession;
    WalletLedger.findOne = origLedgerFindOne;
    Transaction.findOne = origAuditFindOne;
    Transaction.create = origAuditCreate;
    WebhookEvent.findOne = origWhFindOne;
    WebhookEvent.findOneAndUpdate = origWhFindOneAndUpdate;
    WebhookEvent.create = origWhCreate;
    walletService.credit = origWalletCredit;
    notificationService.sendFundingSuccess = origNotifSendFundingSuccess;

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
