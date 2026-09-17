'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');

const paymentGatewayService = require('../services/paymentGateway.service');
const PaystackAdapter = require('../adapters/payment/paystack.adapter');
const FlutterwaveAdapter = require('../adapters/payment/flutterwave.adapter');
const TransactionStatus = require('../models/TransactionStatus');
const WebhookEvent = require('../models/WebhookEvent');
const Transaction = require('../models/Transaction');
const walletService = require('../services/wallet.service');
const investmentService = require('../services/investment.service');
const notificationService = require('../services/notification.service');
const { webhook: paystackWebhook } = require('../controllers/paystackController');

const PAYSTACK_SECRET = 'sk_test_webhook_integrity';
const FLUTTERWAVE_SECRET = 'flw_test_webhook_integrity';
const FLUTTERWAVE_HASH = 'flw_webhook_hash';

function buildCurrentWebhookApp() {
    const app = express();

    // Mirrors the production registration order in server.js. These are the
    // actual routers/controllers and body parsers, not controller-only calls.
    app.use('/api/webhooks', require('../routes/webhooks'));
    const paystackRawBody = express.raw({ type: '*/*' });
    app.post('/webhooks/paystack', paystackRawBody, paystackWebhook);
    app.post('/api/paystack/webhook', paystackRawBody, paystackWebhook);
    app.post('/api/wallet/paystack/webhook', paystackRawBody, paystackWebhook);

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use('/api/paystack', require('../routes/paystack'));
    app.use('/api/wallet', require('../routes/wallet'));

    return app;
}

function queryResult(value) {
    return {
        sort: () => queryResult(value),
        limit: () => queryResult(value),
        session: () => queryResult(value),
        select: () => queryResult(value),
        lean: () => Promise.resolve(value),
        then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
        catch: (reject) => Promise.resolve(value).catch(reject)
    };
}

function matchesValue(actual, expected) {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        if (expected.$in) return expected.$in.includes(actual);
        if (expected.$lte) return actual != null && new Date(actual) <= new Date(expected.$lte);
        if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
            return expected.$exists ? actual !== undefined : actual === undefined;
        }
    }
    return actual === expected;
}

function matchesFilter(item, filter = {}) {
    if (filter.$or && !filter.$or.some(part => matchesFilter(item, part))) return false;
    return Object.entries(filter).every(([key, expected]) => {
        if (key === '$or') return true;
        return matchesValue(item[key], expected);
    });
}

function applyUpdate(item, update = {}) {
    if (update.$set) Object.assign(item, update.$set);
    if (update.$unset) {
        for (const key of Object.keys(update.$unset)) delete item[key];
    }
    if (update.$inc) {
        for (const [key, amount] of Object.entries(update.$inc)) {
            item[key] = Number(item[key] || 0) + amount;
        }
    }
    item.updatedAt = new Date();
}

function paystackPayload({ refId, eventId, amountKobo = 500000, metadata = {} }) {
    return {
        event: 'charge.success',
        data: {
            id: eventId,
            status: 'success',
            reference: refId,
            amount: amountKobo,
            currency: 'NGN',
            metadata
        }
    };
}

function flutterwavePayload({ refId, eventId, amount = 5000 }) {
    return {
        event: 'charge.completed',
        status: 'successful',
        data: {
            id: eventId,
            status: 'successful',
            tx_ref: refId,
            amount,
            currency: 'NGN',
            meta: {}
        }
    };
}

test('webhook integrity HTTP and middleware remediation', async (t) => {
    const originals = {
        getGateway: paymentGatewayService.getGateway,
        transactionFindOne: TransactionStatus.findOne,
        transactionCreate: TransactionStatus.create,
        transactionUpdateOne: TransactionStatus.updateOne,
        eventCreate: WebhookEvent.create,
        eventFindOne: WebhookEvent.findOne,
        eventFindOneAndUpdate: WebhookEvent.findOneAndUpdate,
        transactionCreateLog: Transaction.create,
        walletCredit: walletService.credit,
        fulfillSharePurchase: investmentService.fulfillSharePurchase,
        sendFundingSuccess: notificationService.sendFundingSuccess,
        paystackVerifyPayment: PaystackAdapter.prototype.verifyPayment,
        paystackVerifySignature: PaystackAdapter.prototype.verifyWebhookSignature,
        flutterwaveVerifyPayment: FlutterwaveAdapter.prototype.verifyPayment
    };

    let transactions;
    let events;
    let walletCredits;
    let investmentFulfillments;
    let providerVerifyCalls;
    let signatureBodies;
    let verificationResults;

    const reset = () => {
        transactions = [];
        events = [];
        walletCredits = [];
        investmentFulfillments = [];
        providerVerifyCalls = [];
        signatureBodies = [];
        verificationResults = new Map();
    };

    const seedTransaction = (refId, overrides = {}) => {
        const transaction = {
            refId,
            userId: `owner-${refId}`,
            type: 'funding',
            status: 'pending',
            amountKobo: 500000,
            amount: 5000,
            channels: ['card'],
            provider: 'paystack',
            service: 'Paystack',
            ...overrides
        };
        transactions.push(transaction);
        return transaction;
    };

    const setVerification = (provider, refId, resultOrFunction) => {
        verificationResults.set(`${provider}:${refId}`, resultOrFunction);
    };

    const verifyFor = async (provider, refId) => {
        providerVerifyCalls.push({ provider, refId });
        const configured = verificationResults.get(`${provider}:${refId}`);
        if (typeof configured === 'function') return configured();
        if (configured) return configured;
        const tx = transactions.find(item => item.refId === refId);
        return {
            success: true,
            status: 'success',
            reference: refId,
            providerTransactionId: `${provider}-${refId}`,
            amount: (tx?.amountKobo || 500000) / 100,
            currency: 'NGN',
            metadata: {},
            raw: {}
        };
    };

    reset();

    paymentGatewayService.getGateway = async (code) => {
        if (code === 'paystack') {
            return {
                code,
                name: 'Paystack',
                adapterType: 'paystack',
                secretKey: PAYSTACK_SECRET,
                webhookSecret: PAYSTACK_SECRET,
                baseUrl: 'https://api.paystack.co'
            };
        }
        if (code === 'flutterwave') {
            return {
                code,
                name: 'Flutterwave',
                adapterType: 'flutterwave',
                secretKey: FLUTTERWAVE_SECRET,
                webhookSecret: FLUTTERWAVE_HASH,
                baseUrl: 'https://api.flutterwave.com/v3'
            };
        }
        return null;
    };

    TransactionStatus.findOne = (filter = {}) => {
        return queryResult(transactions.find(item => matchesFilter(item, filter)) || null);
    };
    TransactionStatus.create = async (doc) => {
        const item = { ...doc, createdAt: new Date(), updatedAt: new Date() };
        transactions.push(item);
        return item;
    };
    TransactionStatus.updateOne = async (filter, update) => {
        const item = transactions.find(candidate => matchesFilter(candidate, filter));
        if (!item) return { matchedCount: 0, modifiedCount: 0 };
        applyUpdate(item, update);
        return { matchedCount: 1, modifiedCount: 1 };
    };

    WebhookEvent.create = async (doc) => {
        const duplicate = events.find(item => item.provider === doc.provider && item.eventId === doc.eventId);
        if (duplicate) {
            const error = new Error('E11000 duplicate key error');
            error.code = 11000;
            error.keyValue = { provider: doc.provider, eventId: doc.eventId };
            throw error;
        }
        const item = {
            ...doc,
            attemptCount: doc.attemptCount || 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            save: async function save() {
                this.updatedAt = new Date();
                return this;
            }
        };
        events.push(item);
        return item;
    };
    WebhookEvent.findOne = (filter = {}) => {
        return queryResult(events.find(item => matchesFilter(item, filter)) || null);
    };
    WebhookEvent.findOneAndUpdate = async (filter, update) => {
        const item = events.find(candidate => matchesFilter(candidate, filter));
        if (!item) return null;
        applyUpdate(item, update);
        return item;
    };

    Transaction.create = async () => ({ id: 'audit-log' });
    walletService.credit = async (userId, amount, reference, source) => {
        walletCredits.push({ userId, amount, reference, source });
        return { balance: amount };
    };
    investmentService.fulfillSharePurchase = async (userId, qty, refId, isWalletPayment, session, sharePrice) => {
        investmentFulfillments.push({ userId, qty, refId, isWalletPayment, session, sharePrice });
        return { success: true };
    };
    notificationService.sendFundingSuccess = async () => ({ success: true });

    PaystackAdapter.prototype.verifyPayment = async function verifyPayment(refId) {
        return verifyFor('paystack', refId);
    };
    FlutterwaveAdapter.prototype.verifyPayment = async function verifyPayment(refId) {
        return verifyFor('flutterwave', refId);
    };
    PaystackAdapter.prototype.verifyWebhookSignature = function verifyWebhookSignature(headers, rawBody) {
        signatureBodies.push(rawBody);
        return originals.paystackVerifySignature.call(this, headers, rawBody);
    };

    const app = buildCurrentWebhookApp();
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const postPaystack = async (path, payload, signatureMode = 'valid') => {
        const raw = JSON.stringify(payload);
        const headers = { 'content-type': 'application/json' };
        if (signatureMode !== 'missing') {
            headers['x-paystack-signature'] = signatureMode === 'valid'
                ? crypto.createHmac('sha512', PAYSTACK_SECRET).update(Buffer.from(raw)).digest('hex')
                : 'invalid-signature';
        }
        const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: raw });
        return { response, raw };
    };

    const postFlutterwave = async (path, payload) => {
        return fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'verif-hash': FLUTTERWAVE_HASH
            },
            body: JSON.stringify(payload)
        });
    };

    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        paymentGatewayService.getGateway = originals.getGateway;
        TransactionStatus.findOne = originals.transactionFindOne;
        TransactionStatus.create = originals.transactionCreate;
        TransactionStatus.updateOne = originals.transactionUpdateOne;
        WebhookEvent.create = originals.eventCreate;
        WebhookEvent.findOne = originals.eventFindOne;
        WebhookEvent.findOneAndUpdate = originals.eventFindOneAndUpdate;
        Transaction.create = originals.transactionCreateLog;
        walletService.credit = originals.walletCredit;
        investmentService.fulfillSharePurchase = originals.fulfillSharePurchase;
        notificationService.sendFundingSuccess = originals.sendFundingSuccess;
        PaystackAdapter.prototype.verifyPayment = originals.paystackVerifyPayment;
        PaystackAdapter.prototype.verifyWebhookSignature = originals.paystackVerifySignature;
        FlutterwaveAdapter.prototype.verifyPayment = originals.flutterwaveVerifyPayment;
    });

    await t.test('R1 correctly signed Paystack JSON succeeds through the canonical URL', async () => {
        reset();
        seedTransaction('R1-REF');
        const { response } = await postPaystack(
            '/api/webhooks/payment/paystack',
            paystackPayload({ refId: 'R1-REF', eventId: 'R1-EVENT' })
        );
        assert.equal(response.status, 200);
        assert.equal(walletCredits.length, 1);
    });

    await t.test('R2 correctly signed Paystack JSON succeeds through every retained alias', async () => {
        for (const [index, path] of [
            '/webhooks/paystack',
            '/api/paystack/webhook',
            '/api/wallet/paystack/webhook'
        ].entries()) {
            reset();
            const refId = `R2-REF-${index}`;
            seedTransaction(refId);
            const { response } = await postPaystack(path, paystackPayload({ refId, eventId: `R2-EVENT-${index}` }));
            assert.equal(response.status, 200, `${path} must accept the correctly signed payload`);
            assert.equal(walletCredits.length, 1, `${path} must settle once`);
        }
    });

    await t.test('R3 every Paystack entry point supplies the exact original Buffer', async () => {
        for (const [index, path] of [
            '/api/webhooks/payment/paystack',
            '/webhooks/paystack',
            '/api/paystack/webhook',
            '/api/wallet/paystack/webhook'
        ].entries()) {
            reset();
            const refId = `R3-REF-${index}`;
            const payload = paystackPayload({ refId, eventId: `R3-EVENT-${index}` });
            seedTransaction(refId);
            const { response, raw } = await postPaystack(path, payload);
            assert.equal(response.status, 200, `${path} must accept the signed payload`);
            assert.equal(signatureBodies.length, 1);
            assert.ok(Buffer.isBuffer(signatureBodies[0]), `${path} must pass a Buffer`);
            assert.deepEqual(signatureBodies[0], Buffer.from(raw), `${path} must preserve exact bytes`);
        }
    });

    await t.test('R4 missing Paystack signature is rejected before all side effects', async () => {
        reset();
        const tx = seedTransaction('R4-REF');
        const { response } = await postPaystack(
            '/api/webhooks/payment/paystack',
            paystackPayload({ refId: 'R4-REF', eventId: 'R4-EVENT' }),
            'missing'
        );
        assert.equal(response.status, 401);
        assert.equal(events.length, 0);
        assert.equal(providerVerifyCalls.length, 0);
        assert.equal(tx.status, 'pending');
        assert.equal(walletCredits.length, 0);
        assert.equal(investmentFulfillments.length, 0);
    });

    await t.test('R5 invalid Paystack signature is rejected before all side effects', async () => {
        reset();
        const tx = seedTransaction('R5-REF');
        const { response } = await postPaystack(
            '/api/webhooks/payment/paystack',
            paystackPayload({ refId: 'R5-REF', eventId: 'R5-EVENT' }),
            'invalid'
        );
        assert.equal(response.status, 401);
        assert.equal(events.length, 0);
        assert.equal(providerVerifyCalls.length, 0);
        assert.equal(tx.status, 'pending');
        assert.equal(walletCredits.length, 0);
        assert.equal(investmentFulfillments.length, 0);
    });

    await t.test('R6 inconclusive secondary verification returns retryable non-2xx', async () => {
        reset();
        seedTransaction('R6-REF');
        setVerification('paystack', 'R6-REF', {
            success: false,
            status: 'pending',
            reference: 'R6-REF',
            message: 'provider timeout'
        });
        const { response } = await postPaystack(
            '/api/webhooks/payment/paystack',
            paystackPayload({ refId: 'R6-REF', eventId: 'R6-EVENT' })
        );
        assert.equal(response.status, 503);
        assert.equal(events[0].status, 'retryable');
        assert.equal(walletCredits.length, 0);
    });

    await t.test('R7 same provider and eventId can reprocess a retryable event', async () => {
        reset();
        seedTransaction('R7-REF');
        let attempt = 0;
        setVerification('paystack', 'R7-REF', () => {
            attempt++;
            return attempt === 1
                ? { success: false, status: 'pending', reference: 'R7-REF', message: 'not ready' }
                : { success: true, status: 'success', reference: 'R7-REF', amount: 5000, currency: 'NGN' };
        });
        const payload = paystackPayload({ refId: 'R7-REF', eventId: 'R7-EVENT' });
        assert.equal((await postPaystack('/api/webhooks/payment/paystack', payload)).response.status, 503);
        assert.equal((await postPaystack('/api/webhooks/payment/paystack', payload)).response.status, 200);
        assert.equal(events[0].status, 'processed');
    });

    await t.test('R8 retry invokes secondary provider verification again', async () => {
        reset();
        seedTransaction('R8-REF');
        let attempt = 0;
        setVerification('paystack', 'R8-REF', () => {
            attempt++;
            return attempt === 1
                ? { success: false, status: 'pending', reference: 'R8-REF', message: 'not ready' }
                : { success: true, status: 'success', reference: 'R8-REF', amount: 5000, currency: 'NGN' };
        });
        const payload = paystackPayload({ refId: 'R8-REF', eventId: 'R8-EVENT' });
        await postPaystack('/api/webhooks/payment/paystack', payload);
        await postPaystack('/api/webhooks/payment/paystack', payload);
        assert.equal(providerVerifyCalls.length, 2);
    });

    await t.test('R9 successful retry settles exactly once', async () => {
        reset();
        const tx = seedTransaction('R9-REF');
        let attempt = 0;
        setVerification('paystack', 'R9-REF', () => {
            attempt++;
            return attempt === 1
                ? { success: false, status: 'pending', reference: 'R9-REF', message: 'not ready' }
                : { success: true, status: 'success', reference: 'R9-REF', amount: 5000, currency: 'NGN' };
        });
        const payload = paystackPayload({ refId: 'R9-REF', eventId: 'R9-EVENT' });
        await postPaystack('/api/webhooks/payment/paystack', payload);
        await postPaystack('/api/webhooks/payment/paystack', payload);
        await postPaystack('/api/webhooks/payment/paystack', payload);
        assert.equal(walletCredits.length, 1);
        assert.equal(tx.status, 'success');
    });

    await t.test('R10 concurrent retry deliveries settle exactly once', async () => {
        reset();
        const tx = seedTransaction('R10-REF');
        let attempt = 0;
        setVerification('paystack', 'R10-REF', async () => {
            attempt++;
            if (attempt === 1) {
                return { success: false, status: 'pending', reference: 'R10-REF', message: 'not ready' };
            }
            await new Promise(resolve => setTimeout(resolve, 25));
            return { success: true, status: 'success', reference: 'R10-REF', amount: 5000, currency: 'NGN' };
        });
        const payload = paystackPayload({ refId: 'R10-REF', eventId: 'R10-EVENT' });
        assert.equal((await postPaystack('/api/webhooks/payment/paystack', payload)).response.status, 503);
        const responses = await Promise.all([
            postPaystack('/api/webhooks/payment/paystack', payload),
            postPaystack('/api/webhooks/payment/paystack', payload)
        ]);
        assert.deepEqual(responses.map(item => item.response.status).sort(), [200, 503]);
        assert.equal(providerVerifyCalls.length, 2);
        assert.equal(walletCredits.length, 1);
        assert.equal(tx.status, 'success');
    });

    await t.test('R11 two providers independently process the same textual eventId', async () => {
        reset();
        seedTransaction('R11-PS', { provider: 'paystack' });
        seedTransaction('R11-FLW', { provider: 'flutterwave', service: 'Flutterwave' });
        const paystack = await postPaystack(
            '/api/webhooks/payment/paystack',
            paystackPayload({ refId: 'R11-PS', eventId: '12345' })
        );
        const flutterwave = await postFlutterwave(
            '/api/webhooks/payment/flutterwave',
            flutterwavePayload({ refId: 'R11-FLW', eventId: '12345' })
        );
        assert.equal(paystack.response.status, 200);
        assert.equal(flutterwave.status, 200);
        assert.equal(walletCredits.length, 2);

        const indexes = WebhookEvent.schema.indexes();
        const globalUnique = indexes.some(([keys, options]) => keys.eventId === 1 && Object.keys(keys).length === 1 && options.unique);
        const providerScoped = indexes.some(([keys, options]) => keys.provider === 1 && keys.eventId === 1 && options.unique);
        assert.equal(globalUnique, false, 'eventId must not remain globally unique');
        assert.equal(providerScoped, true, 'provider + eventId must be uniquely indexed');
    });

    await t.test('R12 same provider and eventId deduplicates after successful processing', async () => {
        reset();
        seedTransaction('R12-REF');
        const payload = paystackPayload({ refId: 'R12-REF', eventId: 'R12-EVENT' });
        assert.equal((await postPaystack('/api/webhooks/payment/paystack', payload)).response.status, 200);
        assert.equal((await postPaystack('/api/webhooks/payment/paystack', payload)).response.status, 200);
        assert.equal(providerVerifyCalls.length, 1);
        assert.equal(walletCredits.length, 1);
    });

    await t.test('R13 same event through two retained aliases remains idempotent', async () => {
        reset();
        seedTransaction('R13-REF');
        const payload = paystackPayload({ refId: 'R13-REF', eventId: 'R13-EVENT' });
        assert.equal((await postPaystack('/api/webhooks/payment/paystack', payload)).response.status, 200);
        assert.equal((await postPaystack('/webhooks/paystack', payload)).response.status, 200);
        assert.equal(providerVerifyCalls.length, 1);
        assert.equal(walletCredits.length, 1);
    });

    await t.test('R14 provider mismatch remains rejected without settlement', async () => {
        reset();
        const tx = seedTransaction('R14-REF', { provider: 'flutterwave' });
        const { response } = await postPaystack(
            '/api/webhooks/payment/paystack',
            paystackPayload({ refId: 'R14-REF', eventId: 'R14-EVENT' })
        );
        assert.equal(response.status, 500);
        assert.equal(walletCredits.length, 0);
        assert.equal(tx.status, 'pending');
    });

    await t.test('R15 unsupported gatewayCode remains rejected', async () => {
        reset();
        const response = await fetch(`${baseUrl}/api/webhooks/payment/unsupported`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        assert.equal(response.status, 404);
        assert.equal(events.length, 0);
        assert.equal(providerVerifyCalls.length, 0);
    });

    await t.test('R16 webhook metadata cannot replace authoritative provider verification', async () => {
        reset();
        const tx = seedTransaction('R16-REF');
        setVerification('paystack', 'R16-REF', {
            success: false,
            status: 'pending',
            reference: 'R16-REF',
            message: 'not yet authoritative'
        });
        const { response } = await postPaystack(
            '/api/webhooks/payment/paystack',
            paystackPayload({
                refId: 'R16-REF',
                eventId: 'R16-EVENT',
                metadata: { userId: 'attacker-controlled-user', qty: 999999 }
            })
        );
        assert.equal(response.status, 503);
        assert.equal(walletCredits.length, 0);
        assert.equal(investmentFulfillments.length, 0);
        assert.equal(tx.status, 'pending');
    });

    await t.test('R17 wallet funding remains exactly once', async () => {
        reset();
        const tx = seedTransaction('R17-REF');
        const payload = paystackPayload({ refId: 'R17-REF', eventId: 'R17-EVENT' });
        await Promise.all([
            postPaystack('/api/webhooks/payment/paystack', payload),
            postPaystack('/webhooks/paystack', payload)
        ]);
        assert.equal(walletCredits.length, 1);
        assert.equal(walletCredits[0].userId, tx.userId);
        assert.equal(tx.status, 'success');
    });

    await t.test('R18 investment fulfillment remains exactly once', async () => {
        reset();
        const tx = seedTransaction('R18-REF', {
            type: 'investment_buy',
            sharePrice: 10000,
            amountKobo: 5000000,
            amount: 50000
        });
        const payload = paystackPayload({ refId: 'R18-REF', eventId: 'R18-EVENT', amountKobo: 5000000 });
        await Promise.all([
            postPaystack('/api/webhooks/payment/paystack', payload),
            postPaystack('/webhooks/paystack', payload)
        ]);
        assert.equal(walletCredits.length, 0);
        assert.equal(investmentFulfillments.length, 1);
        assert.equal(investmentFulfillments[0].userId, tx.userId);
        assert.equal(investmentFulfillments[0].qty, 5);
        assert.equal(tx.status, 'success');
    });
});
