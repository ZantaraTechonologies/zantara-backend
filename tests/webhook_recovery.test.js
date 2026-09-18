const assert = require('assert');
const mongoose = require('mongoose');
const crypto = require('crypto');
const axios = require('axios');

// Models
const TransactionStatus = require('../models/TransactionStatus');
const WebhookEvent = require('../models/WebhookEvent');
const WalletLedger = require('../models/WalletLedger');
const Transaction = require('../models/Transaction');

// Services & Utilities
const paymentGatewayService = require('../services/paymentGateway.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');

// ───────────────────────────────────────────────────────────────────────────────
//  WEBHOOK FAILED → SUCCESS RECOVERY REGRESSION SUITE
//
//  Purpose: lock in the NARROW, webhook-authenticated recovery path for wallet
//  FUNDING transactions that were marked 'failed' by an early/ambiguous verify.
//  The recovery:
//    - fires ONLY from an authenticated provider webhook whose independent
//      server-to-server verification explicitly re-confirms provider success,
//    - is gated by strict eligibility (type=funding, ref/amount/currency/provider
//      match, no pre-existing ledger credit),
//    - atomically claims failed → processing before reusing the exact same
//      credit + finalize path (true exactly-once credit),
//    - can NEVER be triggered by a client verify / callback / admin path.
//  The suite runs without a live MongoDB connection (in-memory mocks).
// ───────────────────────────────────────────────────────────────────────────────

async function runWebhookRecoveryTests() {
    console.log('====================================================');
    console.log('      WEBHOOK RECOVERY (FAILED → SUCCESS) SUITE      ');
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
            console.error(`   Error: ${err.message}\n`, err.stack);
            failed++;
        }
    }

    // In-memory mock database state for tests without a live MongoDB connection
    let mockTransactions = [];
    let mockWebhookEvents = [];
    let mockLedgerRows = [];
    let walletCredits = [];
    let mockAudits = [];
    let axiosVerifyCount = 0;

    // Save originals
    const origAxiosGet = axios.get;
    const origTxFindOne = TransactionStatus.findOne;
    const origTxCreate = TransactionStatus.create;
    const origTxUpdateOne = TransactionStatus.updateOne;
    const origStartSession = mongoose.startSession;
    const origWhCreate = WebhookEvent.create;
    const origWhFindOne = WebhookEvent.findOne;
    const origWhFindOneAndUpdate = WebhookEvent.findOneAndUpdate;
    const origLedgerFindOne = WalletLedger.findOne;
    const origTxModelFindOne = Transaction.findOne;
    const origTxModelCreate = Transaction.create;
    const origGetGateway = paymentGatewayService.getGateway;
    const origWalletCredit = walletService.credit;
    const origNotifySendInApp = notificationService.sendInApp;
    const origNotifyFundingSuccess = notificationService.sendFundingSuccess;

    const matchesValue = (actual, expected) => {
        if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
            if (expected.$in) return expected.$in.includes(actual);
        }
        return actual === expected;
    };
    const transactionMatches = (item, filter = {}) => Object.entries(filter).every(([key, value]) => matchesValue(item[key], value));
    const applyUpdate = (item, update = {}) => {
        if (update.$set) Object.assign(item, update.$set);
        if (update.$unset) Object.keys(update.$unset).forEach(key => delete item[key]);
    };

    // Helper to mock mongoose query chains
    const mockQuery = (data, sessionReader = null) => ({
        sort: () => mockQuery(data),
        limit: () => mockQuery(data),
        session: session => Promise.resolve(sessionReader ? sessionReader(session) : data),
        then: (resolve) => Promise.resolve(resolve(data)),
        catch: (reject) => Promise.reject(reject)
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
            mockLedgerRows.push(...this.stagedLedger);
            mockAudits.push(...this.stagedAudits);
        },
        async abortTransaction() {},
        endSession() {}
    });

    const resetState = () => {
        mockTransactions = [];
        mockWebhookEvents = [];
        mockLedgerRows = [];
        walletCredits = [];
        mockAudits = [];
        axiosVerifyCount = 0;
        paymentGatewayService.getGateway = origGetGateway;
    };

    const seedFunding = (refId, overrides = {}) => {
        const tx = {
            refId,
            userId: 'u-test',
            type: 'funding',
            status: 'pending',
            amountKobo: 500000,
            amount: 5000,
            expectedCurrency: 'NGN',
            channels: ['card'],
            provider: 'paystack',
            service: 'Paystack',
            ...overrides
        };
        mockTransactions.push(tx);
        return tx;
    };

    const storeGatewayMock = () => {
        paymentGatewayService.getGateway = async (code) => ({
            _id: 'gw-paystack',
            name: 'Paystack',
            code,
            adapterType: 'paystack',
            status: 'active',
            environment: 'test',
            isDefault: true,
            publicKey: 'pk_test_abc',
            secretKey: 'sk_test_abc',
            baseUrl: 'https://api.paystack.co',
            supportedChannels: ['card', 'bank_transfer', 'ussd']
        });
    };

    // Paystack verify() response factories
    const paystackVerified = (refId, { amount = 500000, currency = 'NGN' } = {}) => ({
        status: true,
        message: 'Verification successful',
        data: {
            status: 'success',
            amount,
            currency,
            reference: refId,
            id: 987654321,
            gateway_response: 'Approved',
            metadata: { refId, userId: 'u-test' }
        }
    });

    const paystackVerdict = (refId, status) => ({
        status: true,
        message: 'Verification successful',
        data: {
            status,
            amount: 500000,
            currency: 'NGN',
            reference: refId,
            id: 987654322,
            gateway_response: status,
            metadata: { refId, userId: 'u-test' }
        }
    });

    const paystackNotCompleted = {
        status: false,
        message: 'The transaction was not completed'
    };

    // Mock models
    TransactionStatus.findOne = (filter = {}) => {
        const found = mockTransactions.find(t => transactionMatches(t, filter)) || null;
        return mockQuery(found, session => {
            const candidate = filter.refId
                ? session.readTransaction(filter.refId)
                : mockTransactions.map(item => session.readTransaction(item.refId)).find(item => transactionMatches(item, filter));
            return candidate && transactionMatches(candidate, filter) ? candidate : null;
        });
    };

    TransactionStatus.create = (doc) => {
        const item = {
            ...doc,
            _id: new mongoose.Types.ObjectId(),
            status: doc.status || 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
            save: async function () { return this; }
        };
        mockTransactions.push(item);
        return Promise.resolve(item);
    };

    TransactionStatus.updateOne = (filter, update, options = {}) => {
        const source = options.session
            ? mockTransactions.map(item => options.session.readTransaction(item.refId))
            : mockTransactions;
        const item = source.find(t => transactionMatches(t, filter));
        if (item) {
            applyUpdate(item, update);
            item.updatedAt = new Date();
            return Promise.resolve({ modifiedCount: 1, matchedCount: 1 });
        }
        return Promise.resolve({ modifiedCount: 0, matchedCount: 0 });
    };

    WalletLedger.findOne = (filter = {}) => {
        const found = mockLedgerRows.find(item => transactionMatches(item, filter)) || null;
        return mockQuery(found, session => [...mockLedgerRows, ...session.stagedLedger].find(item => transactionMatches(item, filter)) || null);
    };

    Transaction.findOne = (filter = {}) => {
        const found = mockAudits.find(item => transactionMatches(item, filter)) || null;
        return mockQuery(found, session => [...mockAudits, ...session.stagedAudits].find(item => transactionMatches(item, filter)) || null);
    };

    Transaction.create = async (docs, options = {}) => {
        assert.ok(options.session, 'Transaction audit must participate in the settlement session');
        const rows = (Array.isArray(docs) ? docs : [docs]).map(doc => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
        options.session.stagedAudits.push(...rows);
        return Array.isArray(docs) ? rows : rows[0];
    };

    WebhookEvent.create = (doc) => {
        const existing = mockWebhookEvents.find(w => w.provider === doc.provider && w.eventId === doc.eventId);
        if (existing) {
            const err = new Error('E11000 duplicate key error');
            err.code = 11000;
            return Promise.reject(err);
        }
        const item = {
            ...doc,
            _id: new mongoose.Types.ObjectId(),
            status: 'pending',
            save: async function () { return this; }
        };
        mockWebhookEvents.push(item);
        return Promise.resolve(item);
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
        return mockQuery(mockWebhookEvents.find(event => webhookMatches(event, filter)) || null);
    };

    WebhookEvent.findOneAndUpdate = (filter = {}, update = {}) => {
        const event = mockWebhookEvents.find(item => webhookMatches(item, filter));
        if (!event) return Promise.resolve(null);
        if (update.$set) Object.assign(event, update.$set);
        if (update.$unset) Object.keys(update.$unset).forEach(key => delete event[key]);
        if (update.$inc) {
            for (const [key, value] of Object.entries(update.$inc)) {
                event[key] = Number(event[key] || 0) + value;
            }
        }
        return Promise.resolve(event);
    };

    walletService.credit = async (userId, amount, reference, source, transactionId, session, options = {}) => {
        assert.ok(session, 'Wallet credit must participate in the settlement session');
        assert.strictEqual(options.settlementKey, `payment:paystack:${reference}`);
        session.stagedCredits.push({ userId, amount, reference, source, time: Date.now() });
        session.stagedLedger.push({ userId, amount, reference, source, entryType: 'credit', settlementKey: options.settlementKey });
        return { balance: 50000 + amount };
    };

    notificationService.sendInApp = async () => ({ success: true });
    notificationService.sendFundingSuccess = async () => ({ success: true });

    const makeWebhookRequest = (refId, eventId, { signature = null } = {}) => {
        const payload = {
            event: 'charge.success',
            data: {
                id: eventId,
                reference: refId,
                status: 'success',
                amount: 500000,
                currency: 'NGN',
                metadata: { refId, userId: 'u-test' }
            }
        };
        const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
        const sig = signature !== null
            ? signature
            : crypto.createHmac('sha512', 'sk_test_abc').update(rawBody).digest('hex');
        return {
            headers: { 'x-paystack-signature': sig },
            body: rawBody
        };
    };

    try {
        // ─────────────────────────────────────────────────────────
        // SECTION 3: WEBHOOK FAILED → SUCCESS RECOVERY
        // ─────────────────────────────────────────────────────────

        await test('19. Authenticated webhook recovers failed+uncredited funding exactly once', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-R1', { status: 'failed', errorMessage: 'The transaction was not completed' });
            axios.get = async () => { axiosVerifyCount++; return { data: paystackVerified('REF-R1') }; };

            const result = await paymentGatewayService.routeWebhook('paystack', makeWebhookRequest('REF-R1', 111000011));
            assert.strictEqual(result.status, 200);
            assert.strictEqual(walletCredits.length, 1, 'Recovery credit must happen exactly once');
            assert.strictEqual(walletCredits[0].reference, 'REF-R1');
            assert.strictEqual(mockTransactions[0].status, 'success', 'Recovered record must be success');
            assert.ok(String(mockTransactions[0].reconciliationReason).includes('Authenticated webhook recovery'), 'Must record recovery reason');
            assert.strictEqual(mockTransactions[0].confirmedAmountKobo, 500000);
            assert.strictEqual(mockTransactions[0].confirmedCurrency, 'NGN');
            assert.strictEqual(String(mockTransactions[0].confirmedProviderRef), '987654321');
        });

        await test('20. Duplicate webhook deliveries after recovery cannot double-credit', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-R2', { status: 'failed', errorMessage: 'The transaction was not completed' });
            axios.get = async () => { axiosVerifyCount++; return { data: paystackVerified('REF-R2') }; };

            const first = await paymentGatewayService.routeWebhook('paystack', makeWebhookRequest('REF-R2', 111000021));
            assert.strictEqual(first.status, 200);
            assert.strictEqual(walletCredits.length, 1);

            // Same eventId re-delivery → idempotent 'already processed'
            const dup = await paymentGatewayService.routeWebhook('paystack', makeWebhookRequest('REF-R2', 111000021));
            assert.strictEqual(dup.status, 200);
            assert.ok(dup.message.includes('already processed'));
            assert.strictEqual(walletCredits.length, 1, 'Same-event duplicate must not re-credit');

            // NEW eventId for the already-success reference → accepted but no credit
            const again = await paymentGatewayService.routeWebhook('paystack', makeWebhookRequest('REF-R2', 111000022));
            assert.strictEqual(again.status, 200);
            assert.strictEqual(walletCredits.length, 1, 'Second distinct event on success record must not re-credit');
            assert.strictEqual(mockTransactions[0].status, 'success');
        });

        await test('21. Client verify CANNOT resurrect a failed transaction (no recovery, no credit)', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-R3', { status: 'failed', errorMessage: 'The transaction was not completed' });
            // Even if the gateway now reports success, the client path must NOT credit.
            axios.get = async () => { axiosVerifyCount++; return { data: paystackVerified('REF-R3') }; };

            // (a) verifyFunding short-circuits on 'failed' WITHOUT calling the adapter.
            const shortCircuit = await paymentGatewayService.verifyFunding('REF-R3');
            assert.strictEqual(shortCircuit.status, 'failed');
            assert.strictEqual(axiosVerifyCount, 0, 'Failed record must short-circuit before any provider call');
            assert.strictEqual(walletCredits.length, 0);
            assert.strictEqual(mockTransactions[0].status, 'failed');

            // (b) Direct finalize with source='client_verify' + success verdict → ineligible.
            const direct = await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: mockTransactions[0],
                gatewayPaymentResult: { success: true, status: 'success', gateway: 'paystack', reference: 'REF-R3', amount: 5000, currency: 'NGN', providerTransactionId: '987654321' },
                source: 'client_verify'
            });
            assert.strictEqual(direct.status, 'failed');
            assert.strictEqual(direct.credited, false);
            assert.strictEqual(walletCredits.length, 0, 'Client path must never recover a failed record');
            assert.strictEqual(mockTransactions[0].status, 'failed');
        });

        await test('22. Invalid webhook signature → no recovery, no WebhookEvent, stays failed', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-R4', { status: 'failed', errorMessage: 'The transaction was not completed' });
            axios.get = async () => { axiosVerifyCount++; return { data: paystackVerified('REF-R4') }; };

            const result = await paymentGatewayService.routeWebhook(
                'paystack',
                makeWebhookRequest('REF-R4', 111000041, { signature: 'tampered-signature' })
            );
            assert.strictEqual(result.status, 401);
            assert.strictEqual(result.message, 'Invalid webhook signature');
            assert.strictEqual(mockWebhookEvents.length, 0, 'Unauthenticated event must not be persisted');
            assert.strictEqual(walletCredits.length, 0);
            assert.strictEqual(mockTransactions[0].status, 'failed');
        });

        await test('23. Amount mismatch → no recovery (stays failed, uncredited)', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-R5', { status: 'failed', errorMessage: 'The transaction was not completed' });
            // Expected ₦5000; provider confirms ₦1000 (amountKobo 100000).
            axios.get = async () => { axiosVerifyCount++; return { data: paystackVerified('REF-R5', { amount: 100000 }) }; };

            const result = await paymentGatewayService.routeWebhook('paystack', makeWebhookRequest('REF-R5', 111000051));
            assert.strictEqual(result.status, 200);
            assert.strictEqual(walletCredits.length, 0, 'Amount mismatch must never credit');
            assert.strictEqual(mockTransactions[0].status, 'failed', 'Must remain failed (not recovered)');
            assert.ok(!mockTransactions[0].reconciliationReason, 'No recovery reason recorded');
        });

        await test('24. Currency mismatch → no recovery (stays failed, uncredited)', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-R5B', { status: 'failed', errorMessage: 'The transaction was not completed' });
            axios.get = async () => { axiosVerifyCount++; return { data: paystackVerified('REF-R5B', { currency: 'USD' }) }; };

            const result = await paymentGatewayService.routeWebhook('paystack', makeWebhookRequest('REF-R5B', 111000052));
            assert.strictEqual(result.status, 200);
            assert.strictEqual(walletCredits.length, 0, 'Currency mismatch must never credit');
            assert.strictEqual(mockTransactions[0].status, 'failed');
        });

        await test('25. Provider mismatch → no recovery (stays failed, uncredited)', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-R6', { status: 'failed', provider: 'paystack', errorMessage: 'The transaction was not completed' });
            // Webhook path for a DIFFERENT gateway must never recover a paystack-bound tx.
            const direct = await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: mockTransactions[0],
                gatewayPaymentResult: { success: true, status: 'success', gateway: 'monnify', reference: 'REF-R6', amount: 5000, currency: 'NGN', providerTransactionId: 'MNFY-REF-R6' },
                source: 'webhook'
            });
            assert.strictEqual(direct.status, 'failed');
            assert.strictEqual(walletCredits.length, 0, 'Cross-gateway recovery must never credit');
            assert.strictEqual(mockTransactions[0].status, 'failed');
        });

        await test('26. Pre-existing wallet ledger credit → no second credit', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-R8', { status: 'failed', errorMessage: 'The transaction was not completed' });
            // Simulates a prior admin/manual credit already recorded for this reference.
            mockLedgerRows.push({
                userId: 'u-test',
                reference: 'REF-R8',
                entryType: 'credit',
                source: 'funding',
                amount: 5000,
                balanceBefore: 45000,
                balanceAfter: 50000
            });
            axios.get = async () => { axiosVerifyCount++; return { data: paystackVerified('REF-R8') }; };

            const result = await paymentGatewayService.routeWebhook('paystack', makeWebhookRequest('REF-R8', 111000081));
            assert.strictEqual(result.status, 200);
            assert.strictEqual(walletCredits.length, 0, 'Existing ledger credit must block recovery');
            assert.strictEqual(mockTransactions[0].status, 'failed');
        });

        await test('27. Inconclusive webhook verification is retryable and does not recover yet', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-R9', { status: 'failed', errorMessage: 'The transaction was not completed' });
            axios.get = async () => { axiosVerifyCount++; return { data: paystackNotCompleted }; };

            const result = await paymentGatewayService.routeWebhook('paystack', makeWebhookRequest('REF-R9', 111000091));
            assert.strictEqual(result.status, 503);
            assert.ok(result.message.includes('inconclusive'));
            assert.strictEqual(walletCredits.length, 0, 'Unconfirmed webhook must not credit');
            assert.strictEqual(mockTransactions[0].status, 'failed');
            assert.strictEqual(mockWebhookEvents[0].status, 'retryable', 'Event remains eligible for authenticated redelivery');
        });

        await test('28. Regression: normal pending → success path unchanged', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-R10', { status: 'pending' });
            axios.get = async () => { axiosVerifyCount++; return { data: paystackVerified('REF-R10') }; };

            const result = await paymentGatewayService.routeWebhook('paystack', makeWebhookRequest('REF-R10', 111000101));
            assert.strictEqual(result.status, 200);
            assert.strictEqual(walletCredits.length, 1, 'Normal webhook must credit once');
            assert.strictEqual(mockTransactions[0].status, 'success');
            assert.ok(!String(mockTransactions[0].reconciliationReason || '').includes('Authenticated webhook recovery'), 'Normal path must not be labeled a recovery');
        });

        await test('29. Regression: genuinely failed (verify still failed) stays failed, uncredited, un-resurrectable', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-R11', { status: 'failed', errorMessage: 'Payment failed at gateway' });
            const verifyCalls = { n: 0 };
            axios.get = async () => { verifyCalls.n++; return { data: paystackVerdict('REF-R11', 'failed') }; };

            const result = await paymentGatewayService.routeWebhook('paystack', makeWebhookRequest('REF-R11', 111000111));
            assert.strictEqual(result.status, 200);
            assert.ok(result.message.includes('confirmed payment failure'));
            assert.strictEqual(walletCredits.length, 0, 'Genuinely failed verify must not credit');
            assert.strictEqual(mockTransactions[0].status, 'failed', 'Must remain failed, no recovery');

            // Client path offers no resurrection either (short-circuit skips provider call).
            const before = verifyCalls.n;
            const client = await paymentGatewayService.verifyFunding('REF-R11');
            assert.strictEqual(client.status, 'failed');
            assert.strictEqual(verifyCalls.n, before, 'Client verify must short-circuit on failed');
            assert.strictEqual(walletCredits.length, 0);
        });
    } finally {
        // Restore all mocks
        axios.get = origAxiosGet;
        mongoose.startSession = origStartSession;
        TransactionStatus.findOne = origTxFindOne;
        TransactionStatus.create = origTxCreate;
        TransactionStatus.updateOne = origTxUpdateOne;
        WebhookEvent.create = origWhCreate;
        WebhookEvent.findOne = origWhFindOne;
        WebhookEvent.findOneAndUpdate = origWhFindOneAndUpdate;
        WalletLedger.findOne = origLedgerFindOne;
        Transaction.findOne = origTxModelFindOne;
        Transaction.create = origTxModelCreate;
        paymentGatewayService.getGateway = origGetGateway;
        walletService.credit = origWalletCredit;
        notificationService.sendInApp = origNotifySendInApp;
        notificationService.sendFundingSuccess = origNotifyFundingSuccess;
    }

    console.log('\n----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('----------------------------------------------------\n');

    if (failed > 0) process.exit(1);
    process.exit(0);
}

runWebhookRecoveryTests();
