const assert = require('assert');
const mongoose = require('mongoose');
const crypto = require('crypto');
const axios = require('axios');

// Models
const TransactionStatus = require('../models/TransactionStatus');
const WebhookEvent = require('../models/WebhookEvent');
const Transaction = require('../models/Transaction');

// Services & Utilities
const paymentGatewayService = require('../services/paymentGateway.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');

// Adapters
const PaystackAdapter = require('../adapters/payment/paystack.adapter');

// ───────────────────────────────────────────────────────────────────────────────
//  VERIFICATION + RECOVERY REGRESSION SUITE
//
//  Purpose: lock in the wallet-funding verification classification so that a
//  verify which fires too early (mobile WebView allowlist-exit) can NEVER
//  permanently mark a transaction 'failed'. Only an explicit terminal Paystack
//  verdict may do that; ambiguous / not-yet-complete / processing / transport
//  results stay 'pending' so a later verify or webhook can recover and credit.
//  The suite runs without a live MongoDB connection (in-memory mocks).
// ───────────────────────────────────────────────────────────────────────────────

async function runVerificationRecoveryTests() {
    console.log('====================================================');
    console.log('   PAYMENT VERIFICATION & RECOVERY REGRESSION SUITE  ');
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
    let walletCredits = [];

    // Paystack verify() transport stub — each test restores/overrides per use-case.
    const origAxiosGet = axios.get;

    // Save originals
    const origTxFindOne = TransactionStatus.findOne;
    const origTxCreate = TransactionStatus.create;
    const origTxUpdateOne = TransactionStatus.updateOne;
    const origWhCreate = WebhookEvent.create;
    const origTxModelCreate = Transaction.create;
    const origGetGateway = paymentGatewayService.getGateway;
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

    const resetState = () => {
        mockTransactions = [];
        mockWebhookEvents = [];
        walletCredits = [];
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
    const paystackVerified = (refId) => ({
        status: true,
        message: 'Verification successful',
        data: {
            status: 'success',
            amount: 500000,
            currency: 'NGN',
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
            updatedAt: new Date(),
            save: async function () { return this; }
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
            if (update.$set) item.updatedAt = new Date();
            return Promise.resolve({ modifiedCount: 1, matchedCount: 1 });
        }
        return Promise.resolve({ modifiedCount: 0, matchedCount: 0 });
    };

    WebhookEvent.create = (doc) => {
        const existing = mockWebhookEvents.find(w => w.eventId === doc.eventId);
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

    walletService.credit = async (userId, amount, reference, source) => {
        walletCredits.push({ userId, amount, reference, source, time: Date.now() });
        return { balance: 50000 + amount };
    };

    notificationService.sendInApp = async () => ({ success: true });

    const makeWebhookRequest = (refId, eventId) => {
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
        const signature = crypto.createHmac('sha512', 'sk_test_abc').update(rawBody).digest('hex');
        return {
            headers: { 'x-paystack-signature': signature },
            body: rawBody
        };
    };

    try {
        // ─────────────────────────────────────────────────────────────
        // SECTION 1: ADAPTER-LEVEL STATUS CLASSIFICATION
        // ─────────────────────────────────────────────────────────────

        await test('1. Paystack explicit success → status "success"', async () => {
            const adapter = new PaystackAdapter({ code: 'paystack', secretKey: 'sk_test_abc' });
            axios.get = async () => ({ data: paystackVerified('REF-S1') });
            const res = await adapter.verifyPayment('REF-S1');
            assert.strictEqual(res.status, 'success');
            assert.strictEqual(res.success, true);
            assert.strictEqual(res.amount, 5000);
        });

        await test('2. Paystack explicit "abandoned" → terminal "failed"', async () => {
            const adapter = new PaystackAdapter({ code: 'paystack', secretKey: 'sk_test_abc' });
            axios.get = async () => ({ data: paystackVerdict('REF-S2', 'abandoned') });
            const res = await adapter.verifyPayment('REF-S2');
            assert.strictEqual(res.status, 'failed');
            assert.strictEqual(res.success, false);
        });

        await test('3. Paystack explicit "failed" → terminal "failed"', async () => {
            const adapter = new PaystackAdapter({ code: 'paystack', secretKey: 'sk_test_abc' });
            axios.get = async () => ({ data: paystackVerdict('REF-S3', 'failed') });
            const res = await adapter.verifyPayment('REF-S3');
            assert.strictEqual(res.status, 'failed');
            assert.strictEqual(res.success, false);
        });

        await test('4. Paystack explicit "declined" → terminal "failed"', async () => {
            const adapter = new PaystackAdapter({ code: 'paystack', secretKey: 'sk_test_abc' });
            axios.get = async () => ({ data: paystackVerdict('REF-S4', 'declined') });
            const res = await adapter.verifyPayment('REF-S4');
            assert.strictEqual(res.status, 'failed');
            assert.strictEqual(res.success, false);
        });

        await test('5. Paystack explicit "cancelled" → terminal "failed"', async () => {
            const adapter = new PaystackAdapter({ code: 'paystack', secretKey: 'sk_test_abc' });
            axios.get = async () => ({ data: paystackVerdict('REF-S5', 'cancelled') });
            const res = await adapter.verifyPayment('REF-S5');
            assert.strictEqual(res.status, 'failed');
            assert.strictEqual(res.success, false);
        });

        await test('6. "The transaction was not completed" (ambiguous) → "pending" NOT failed', async () => {
            const adapter = new PaystackAdapter({ code: 'paystack', secretKey: 'sk_test_abc' });
            axios.get = async () => ({ data: paystackNotCompleted });
            const res = await adapter.verifyPayment('REF-S6');
            assert.strictEqual(res.status, 'pending');
            assert.strictEqual(res.success, false);
        });

        await test('7. Paystack "processing" (ongoing) → "pending"', async () => {
            const adapter = new PaystackAdapter({ code: 'paystack', secretKey: 'sk_test_abc' });
            axios.get = async () => ({ data: paystackVerdict('REF-S7', 'processing') });
            const res = await adapter.verifyPayment('REF-S7');
            assert.strictEqual(res.status, 'pending');
            assert.strictEqual(res.success, false);
        });

        await test('8. Paystack "pending" (ongoing) → "pending"', async () => {
            const adapter = new PaystackAdapter({ code: 'paystack', secretKey: 'sk_test_abc' });
            axios.get = async () => ({ data: paystackVerdict('REF-S8', 'pending') });
            const res = await adapter.verifyPayment('REF-S8');
            assert.strictEqual(res.status, 'pending');
            assert.strictEqual(res.success, false);
        });

        await test('9. Transport timeout → "pending" (recoverable, never failed)', async () => {
            const adapter = new PaystackAdapter({ code: 'paystack', secretKey: 'sk_test_abc' });
            axios.get = async () => { throw new Error('timeout of 20000ms exceeded'); };
            const res = await adapter.verifyPayment('REF-S9');
            assert.strictEqual(res.status, 'pending');
            assert.strictEqual(res.success, false);
            assert.ok(res.message.includes('Paystack verify error'));
        });

        await test('10. Provider 5xx → "pending" (recoverable, never failed)', async () => {
            const adapter = new PaystackAdapter({ code: 'paystack', secretKey: 'sk_test_abc' });
            axios.get = async () => {
                const err = new Error('Request failed with status code 500');
                err.response = { data: { message: 'Server Error' } };
                throw err;
            };
            const res = await adapter.verifyPayment('REF-S10');
            assert.strictEqual(res.status, 'pending');
            assert.strictEqual(res.success, false);
        });

        // ─────────────────────────────────────────────────────────────
        // SECTION 2: SERVICE-LEVEL finalizeFundingCredit / verifyFunding
        // ─────────────────────────────────────────────────────────────

        await test('11. VerifyFunding success credits once and stays idempotent', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-F1');
            axios.get = async () => ({ data: paystackVerified('REF-F1') });

            const first = await paymentGatewayService.verifyFunding('REF-F1');
            assert.strictEqual(first.status, 'success');
            assert.strictEqual(walletCredits.length, 1);
            assert.strictEqual(walletCredits[0].reference, 'REF-F1');
            assert.strictEqual(mockTransactions[0].status, 'success');

            // Repeated verify must NOT double-credit
            const second = await paymentGatewayService.verifyFunding('REF-F1');
            assert.strictEqual(second.status, 'success');
            assert.strictEqual(walletCredits.length, 1, 'No double credit on repeated success');
        });

        await test('12. Explicit terminal failure marks record failed (no credit)', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-F2');
            axios.get = async () => ({ data: paystackVerdict('REF-F2', 'failed') });

            const res = await paymentGatewayService.verifyFunding('REF-F2');
            assert.strictEqual(res.status, 'failed');
            assert.strictEqual(walletCredits.length, 0);
            assert.strictEqual(mockTransactions[0].status, 'failed');
            assert.ok(mockTransactions[0].errorMessage, 'errorMessage should be recorded');
        });

        await test('13. "The transaction was not completed" verify stays pending, no credit, no failed mark', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-F3');
            axios.get = async () => ({ data: paystackNotCompleted });

            const res = await paymentGatewayService.verifyFunding('REF-F3');
            assert.strictEqual(res.status, 'pending');
            assert.strictEqual(walletCredits.length, 0, 'Ambiguous verify must NOT credit');
            assert.strictEqual(mockTransactions[0].status, 'pending', 'Record must remain pending/recoverable');
        });

        await test('14. Processing verdict verify stays pending, no credit, no failed mark', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-F4');
            axios.get = async () => ({ data: paystackVerdict('REF-F4', 'processing') });

            const res = await paymentGatewayService.verifyFunding('REF-F4');
            assert.strictEqual(res.status, 'pending');
            assert.strictEqual(walletCredits.length, 0);
            assert.strictEqual(mockTransactions[0].status, 'pending');
        });

        await test('15. Transport timeout verify is recoverable and never marks failed', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-F5');
            axios.get = async () => { throw new Error('timeout of 20000ms exceeded'); };

            const res = await paymentGatewayService.verifyFunding('REF-F5');
            assert.strictEqual(res.status, 'pending');
            assert.strictEqual(walletCredits.length, 0, 'Transport error must NOT credit');
            assert.strictEqual(mockTransactions[0].status, 'pending', 'Must remain recoverable, never failed');
        });

        await test('16. Provider 5xx verify is recoverable and never marks failed', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-F6');
            axios.get = async () => {
                const err = new Error('Request failed with status code 502');
                err.response = { data: { message: 'Bad Gateway' } };
                throw err;
            };

            const res = await paymentGatewayService.verifyFunding('REF-F6');
            assert.strictEqual(res.status, 'pending');
            assert.strictEqual(walletCredits.length, 0);
            assert.strictEqual(mockTransactions[0].status, 'pending');
        });

        await test('17. Later success after prior pending verify credits exactly once (recovery)', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-F7');

            // Stage 1: early verify returns "transaction not completed" → pending
            axios.get = async () => ({ data: paystackNotCompleted });
            const early = await paymentGatewayService.verifyFunding('REF-F7');
            assert.strictEqual(early.status, 'pending');
            assert.strictEqual(walletCredits.length, 0);
            assert.strictEqual(mockTransactions[0].status, 'pending');

            // Stage 2: payment completes; later verify/requery succeeds → credit once
            axios.get = async () => ({ data: paystackVerified('REF-F7') });
            const later = await paymentGatewayService.verifyFunding('REF-F7');
            assert.strictEqual(later.status, 'success');
            assert.strictEqual(walletCredits.length, 1, 'Recovery credit must happen exactly once');
            assert.strictEqual(mockTransactions[0].status, 'success');

            // Stage 3: repeated success must not re-credit
            const again = await paymentGatewayService.verifyFunding('REF-F7');
            assert.strictEqual(again.status, 'success');
            assert.strictEqual(walletCredits.length, 1, 'Repeated success must not double-credit');
        });

        await test('18. Webhook success after prior pending verify credits exactly once', async () => {
            resetState();
            storeGatewayMock();
            seedFunding('REF-F8');

            // Stage 1: early client verify returns pending → record stays pending
            axios.get = async () => ({ data: paystackNotCompleted });
            const early = await paymentGatewayService.verifyFunding('REF-F8');
            assert.strictEqual(early.status, 'pending');
            assert.strictEqual(mockTransactions[0].status, 'pending');

            // Stage 2: webhook arrives while Gateway now confirms success
            axios.get = async () => ({ data: paystackVerified('REF-F8') });
            const req = makeWebhookRequest('REF-F8', 777000111);
            const result = await paymentGatewayService.routeWebhook('paystack', req);
            assert.strictEqual(result.status, 200);
            assert.strictEqual(walletCredits.length, 1, 'Webhook must credit once after pending verify');
            assert.strictEqual(mockTransactions[0].status, 'success');

            // Stage 3: duplicate webhook delivery is idempotent — no extra credit
            const dupResult = await paymentGatewayService.routeWebhook('paystack', makeWebhookRequest('REF-F8', 777000111));
            assert.strictEqual(dupResult.status, 200);
            assert.ok(dupResult.message.includes('already processed'));
            assert.strictEqual(walletCredits.length, 1, 'Duplicate webhook must not re-credit');
        });
    } finally {
        // Restore all mocks
        axios.get = origAxiosGet;
        TransactionStatus.findOne = origTxFindOne;
        TransactionStatus.create = origTxCreate;
        TransactionStatus.updateOne = origTxUpdateOne;
        WebhookEvent.create = origWhCreate;
        Transaction.create = origTxModelCreate;
        paymentGatewayService.getGateway = origGetGateway;
        walletService.credit = origWalletCredit;
        notificationService.sendInApp = origNotifySendInApp;
    }

    console.log('\n----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('----------------------------------------------------\n');

    if (failed > 0) process.exit(1);
    process.exit(0);
}

runVerificationRecoveryTests();