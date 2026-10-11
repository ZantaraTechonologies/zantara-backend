'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
const axios = require('axios');

const paymentGatewayService = require('../services/paymentGateway.service');
const virtualAccountService = require('../services/virtualAccount.service');
const PaystackAdapter = require('../adapters/payment/paystack.adapter');
const TransactionStatus = require('../models/TransactionStatus');
const WebhookEvent = require('../models/WebhookEvent');
const WalletLedger = require('../models/WalletLedger');
const Transaction = require('../models/Transaction');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');

const SECRET = 'sk_test_dva_settlement';
const GATEWAY_ID = 'gateway-paystack';

const matchesValue = (actual, expected) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        if (expected.$in) return expected.$in.includes(actual);
        if (expected.$lte) return actual != null && new Date(actual) <= new Date(expected.$lte);
        if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
            return expected.$exists ? actual !== undefined : actual === undefined;
        }
    }
    return actual === expected;
};

const matches = (item, filter = {}) => {
    if (filter.$or && !filter.$or.some(part => matches(item, part))) return false;
    return Object.entries(filter).every(([key, expected]) => key === '$or' || matchesValue(item[key], expected));
};

const queryResult = (value, sessionReader = null) => ({
    select: () => queryResult(value, sessionReader),
    session: session => Promise.resolve(sessionReader ? sessionReader(session) : value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    catch: reject => Promise.resolve(value).catch(reject)
});

class FakeDepositRepository {
    constructor(accounts = []) {
        this.accounts = accounts.map(value => ({ ...value }));
    }

    async findActivePaystackDepositOwner({ gatewayId, accountNumber, providerCustomerId, providerCustomerCode }) {
        const matches = this.accounts.filter(({ account }) =>
            account.provider === 'paystack'
            && String(account.gatewayId) === String(gatewayId)
            && account.accountNumber === accountNumber
            && String(account.providerCustomerId) === String(providerCustomerId)
            && account.providerCustomerCode === providerCustomerCode
            && account.provisioningStatus === 'active'
            && account.active === true
            && account.assigned === true
            && account.currency === 'NGN'
            && account.providerAccountId
            && account.accountReference === `PAYSTACK_DVA_${account.providerAccountId}`
        );
        return {
            match: matches.length === 1 ? { ...matches[0] } : null,
            matchCount: matches.length
        };
    }
}

const storedDva = overrides => ({
    userId: 'user-1',
    gatewaySnapshot: { code: 'paystack', adapterType: 'paystack' },
    account: {
        provider: 'paystack',
        gatewayId: GATEWAY_ID,
        bankName: 'Wema Bank',
        bankSlug: 'wema-bank',
        accountNumber: '0123456789',
        currency: 'NGN',
        providerAccountId: '991',
        providerCustomerId: '81',
        providerCustomerCode: 'CUS_ada',
        accountReference: 'PAYSTACK_DVA_991',
        provisioningStatus: 'active',
        active: true,
        assigned: true
    },
    ...overrides
});

const chargePayload = overrides => ({
    event: 'charge.success',
    data: {
        id: 77001,
        status: 'success',
        reference: 'DVA_DEPOSIT_1',
        amount: 500000,
        currency: 'NGN',
        channel: 'bank_transfer',
        authorization: {
            channel: 'dedicated_nuban',
            receiver_bank_account_number: '0123456789',
            receiver_bank: 'Wema Bank'
        },
        customer: {
            id: 81,
            customer_code: 'CUS_ada'
        },
        metadata: { userId: 'attacker-controlled-user' },
        ...overrides
    }
});

const verifiedPayment = (overrides = {}) => ({
    success: true,
    status: 'success',
    reference: 'DVA_DEPOSIT_1',
    providerTransactionId: '77001',
    amount: 5000,
    amountKobo: 500000,
    currency: 'NGN',
    message: 'Approved',
    dedicatedNuban: {
        claimsDedicatedNuban: true,
        isDedicatedNuban: true,
        transactionChannel: 'bank_transfer',
        authorizationChannel: 'dedicated_nuban',
        receiverAccountNumber: '0123456789',
        receiverBank: 'Wema Bank',
        providerCustomerId: '81',
        providerCustomerCode: 'CUS_ada'
    },
    raw: { status: 'success' },
    ...overrides
});

const signedRequest = (payload, valid = true) => {
    const body = Buffer.from(JSON.stringify(payload));
    return {
        body,
        headers: {
            'x-paystack-signature': valid
                ? crypto.createHmac('sha512', SECRET).update(body).digest('hex')
                : '0'.repeat(128)
        }
    };
};

test('Paystack verification normalizes dedicated-NUBAN ownership evidence without a live request', async () => {
    const originalGet = axios.get;
    axios.get = async () => ({
        status: 200,
        data: {
            status: true,
            message: 'Verification successful',
            data: chargePayload().data
        }
    });
    try {
        const adapter = new PaystackAdapter({
            baseUrl: 'https://api.paystack.test',
            secretKey: SECRET
        });
        const result = await adapter.verifyPayment('DVA_DEPOSIT_1');

        assert.equal(result.status, 'success');
        assert.equal(result.amountKobo, 500000);
        assert.equal(result.dedicatedNuban.isDedicatedNuban, true);
        assert.equal(result.dedicatedNuban.receiverAccountNumber, '0123456789');
        assert.equal(result.dedicatedNuban.providerCustomerId, '81');
        assert.equal(result.dedicatedNuban.providerCustomerCode, 'CUS_ada');
    } finally {
        axios.get = originalGet;
    }
});

test('Paystack dedicated-NUBAN deposits settle through the unified atomic finalizer', async t => {
    const originals = {
        repository: virtualAccountService.repository,
        getGateway: paymentGatewayService.getGateway,
        snapshot: paymentGatewayService._snapshotGatewayConfig,
        verifyPayment: PaystackAdapter.prototype.verifyPayment,
        transactionFindOne: TransactionStatus.findOne,
        transactionCreate: TransactionStatus.create,
        transactionUpdateOne: TransactionStatus.updateOne,
        eventCreate: WebhookEvent.create,
        eventFindOne: WebhookEvent.findOne,
        eventFindOneAndUpdate: WebhookEvent.findOneAndUpdate,
        ledgerFindOne: WalletLedger.findOne,
        auditFindOne: Transaction.findOne,
        auditCreate: Transaction.create,
        walletCredit: walletService.credit,
        notifyFunding: notificationService.sendFundingSuccess,
        startSession: mongoose.startSession,
        axiosGet: axios.get,
        axiosPost: axios.post
    };

    let transactions;
    let events;
    let credits;
    let ledger;
    let audits;
    let verification;
    let verifyCalls;
    let networkCalls;
    let repository;

    const reset = ({ accounts = [storedDva()], verificationResult = verifiedPayment(), seededTransactions = [] } = {}) => {
        transactions = seededTransactions.map(value => ({ ...value }));
        events = [];
        credits = [];
        ledger = [];
        audits = [];
        verification = verificationResult;
        verifyCalls = 0;
        networkCalls = 0;
        repository = new FakeDepositRepository(accounts);
        virtualAccountService.repository = repository;
    };

    paymentGatewayService.getGateway = async code => code === 'paystack' ? {
        _id: GATEWAY_ID,
        code: 'paystack',
        adapterType: 'paystack',
        name: 'Paystack',
        status: 'active',
        environment: 'live',
        secretKey: SECRET,
        webhookSecret: SECRET,
        baseUrl: 'https://api.paystack.test'
    } : null;
    paymentGatewayService._snapshotGatewayConfig = gateway => ({ code: gateway.code, adapterType: gateway.adapterType });
    PaystackAdapter.prototype.verifyPayment = async () => {
        verifyCalls++;
        return { ...verification, dedicatedNuban: verification.dedicatedNuban && { ...verification.dedicatedNuban } };
    };
    axios.get = async () => {
        networkCalls++;
        throw new Error('live Paystack access is forbidden in this test');
    };
    axios.post = async () => {
        networkCalls++;
        throw new Error('live Paystack access is forbidden in this test');
    };

    TransactionStatus.findOne = filter => {
        const found = transactions.find(item => matches(item, filter)) || null;
        return queryResult(found, session => {
            const candidates = transactions.map(item => session.readTransaction(item.refId));
            return candidates.find(item => item && matches(item, filter)) || null;
        });
    };
    TransactionStatus.create = async doc => {
        if (transactions.some(item => item.refId === doc.refId)) {
            const error = new Error('duplicate transaction reference');
            error.code = 11000;
            throw error;
        }
        const item = { ...doc, _id: new mongoose.Types.ObjectId() };
        transactions.push(item);
        return item;
    };
    TransactionStatus.updateOne = async (filter, update, options = {}) => {
        const source = options.session
            ? transactions.map(item => options.session.readTransaction(item.refId))
            : transactions;
        const item = source.find(candidate => candidate && matches(candidate, filter));
        if (!item) return { modifiedCount: 0, matchedCount: 0 };
        if (update.$set) Object.assign(item, update.$set);
        if (update.$unset) Object.keys(update.$unset).forEach(key => delete item[key]);
        return { modifiedCount: 1, matchedCount: 1 };
    };

    WebhookEvent.create = async doc => {
        if (events.some(event => event.provider === doc.provider && event.eventId === doc.eventId)) {
            const error = new Error('duplicate webhook event');
            error.code = 11000;
            throw error;
        }
        const event = { ...doc };
        events.push(event);
        return event;
    };
    WebhookEvent.findOne = filter => queryResult(events.find(event => matches(event, filter)) || null);
    WebhookEvent.findOneAndUpdate = async (filter, update) => {
        const event = events.find(candidate => matches(candidate, filter));
        if (!event) return null;
        if (update.$set) Object.assign(event, update.$set);
        if (update.$unset) Object.keys(update.$unset).forEach(key => delete event[key]);
        if (update.$inc) {
            for (const [key, value] of Object.entries(update.$inc)) event[key] = Number(event[key] || 0) + value;
        }
        return event;
    };

    WalletLedger.findOne = filter => {
        const found = ledger.find(item => matches(item, filter)) || null;
        return queryResult(found, session => [...ledger, ...session.stagedLedger].find(item => matches(item, filter)) || null);
    };
    Transaction.findOne = filter => {
        const found = audits.find(item => matches(item, filter)) || null;
        return queryResult(found, session => [...audits, ...session.stagedAudits].find(item => matches(item, filter)) || null);
    };
    Transaction.create = async (docs, options = {}) => {
        assert.ok(options.session, 'funding audit must use the settlement transaction');
        const rows = docs.map(doc => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
        options.session.stagedAudits.push(...rows);
        return rows;
    };
    walletService.credit = async (userId, amount, reference, source, transactionId, session, options = {}) => {
        assert.ok(session, 'wallet credit must use the settlement transaction');
        assert.equal(options.settlementKey, `payment:paystack:${reference}`);
        session.stagedCredits.push({ userId, amount, reference, source });
        session.stagedLedger.push({ userId, amount, reference, source, entryType: 'credit', settlementKey: options.settlementKey });
        return { balance: amount };
    };
    notificationService.sendFundingSuccess = async () => {};
    mongoose.startSession = async () => ({
        stagedTransactions: new Map(),
        stagedCredits: [],
        stagedLedger: [],
        stagedAudits: [],
        startTransaction() {},
        readTransaction(refId) {
            if (this.stagedTransactions.has(refId)) return this.stagedTransactions.get(refId);
            const current = transactions.find(item => item.refId === refId);
            if (!current) return null;
            const copy = { ...current, channels: [...(current.channels || [])] };
            this.stagedTransactions.set(refId, copy);
            return copy;
        },
        async commitTransaction() {
            for (const [refId, staged] of this.stagedTransactions) {
                const current = transactions.find(item => item.refId === refId);
                if (current) {
                    Object.keys(current).forEach(key => delete current[key]);
                    Object.assign(current, staged);
                }
            }
            credits.push(...this.stagedCredits);
            ledger.push(...this.stagedLedger);
            audits.push(...this.stagedAudits);
        },
        async abortTransaction() {},
        endSession() {}
    });

    t.after(() => {
        virtualAccountService.repository = originals.repository;
        paymentGatewayService.getGateway = originals.getGateway;
        paymentGatewayService._snapshotGatewayConfig = originals.snapshot;
        PaystackAdapter.prototype.verifyPayment = originals.verifyPayment;
        TransactionStatus.findOne = originals.transactionFindOne;
        TransactionStatus.create = originals.transactionCreate;
        TransactionStatus.updateOne = originals.transactionUpdateOne;
        WebhookEvent.create = originals.eventCreate;
        WebhookEvent.findOne = originals.eventFindOne;
        WebhookEvent.findOneAndUpdate = originals.eventFindOneAndUpdate;
        WalletLedger.findOne = originals.ledgerFindOne;
        Transaction.findOne = originals.auditFindOne;
        Transaction.create = originals.auditCreate;
        walletService.credit = originals.walletCredit;
        notificationService.sendFundingSuccess = originals.notifyFunding;
        mongoose.startSession = originals.startSession;
        axios.get = originals.axiosGet;
        axios.post = originals.axiosPost;
    });

    await t.test('successful settlement resolves stored DVA ownership and atomically credits once', async () => {
        reset();

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(chargePayload()));

        assert.equal(result.status, 200);
        assert.equal(verifyCalls, 1);
        assert.equal(networkCalls, 0);
        assert.equal(transactions.length, 1);
        assert.equal(transactions[0].userId, 'user-1');
        assert.equal(transactions[0].gatewayId, GATEWAY_ID);
        assert.deepEqual(transactions[0].channels, ['virtual_account']);
        assert.equal(transactions[0].status, 'success');
        assert.equal(credits.length, 1);
        assert.equal(credits[0].amount, 5000);
        assert.equal(ledger.length, 1);
        assert.equal(audits.length, 1);
        assert.equal(events[0].status, 'processed');
    });

    await t.test('duplicate webhook replay never creates a second wallet credit', async () => {
        reset();
        const request = signedRequest(chargePayload());

        const first = await paymentGatewayService.routeWebhook('paystack', request);
        const duplicate = await paymentGatewayService.routeWebhook('paystack', request);

        assert.equal(first.status, 200);
        assert.equal(duplicate.status, 200);
        assert.match(duplicate.message, /already processed/);
        assert.equal(credits.length, 1);
        assert.equal(ledger.length, 1);
        assert.equal(transactions.length, 1);
    });

    await t.test('concurrent duplicate processing produces at most one credit and one transaction', async () => {
        reset();
        const request = signedRequest(chargePayload());

        const results = await Promise.all([
            paymentGatewayService.routeWebhook('paystack', request),
            paymentGatewayService.routeWebhook('paystack', request)
        ]);

        assert.deepEqual(results.map(result => result.status).sort(), [200, 503]);
        assert.equal(credits.length, 1);
        assert.equal(ledger.length, 1);
        assert.equal(transactions.length, 1);
    });

    await t.test('invalid signature is rejected before verification or persistence', async () => {
        reset();

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(chargePayload(), false));

        assert.equal(result.status, 401);
        assert.equal(verifyCalls, 0);
        assert.equal(events.length, 0);
        assert.equal(transactions.length, 0);
        assert.equal(credits.length, 0);
    });

    await t.test('failed Paystack verification cannot create or credit a deposit', async () => {
        reset({ verificationResult: verifiedPayment({ success: false, status: 'failed', message: 'Failed' }) });

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(chargePayload()));

        assert.equal(result.status, 200);
        assert.equal(events[0].status, 'failed');
        assert.equal(transactions.length, 0);
        assert.equal(credits.length, 0);
    });

    await t.test('unknown DVA fails closed without trusting webhook metadata userId', async () => {
        reset({ accounts: [] });

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(chargePayload()));

        assert.equal(result.status, 200);
        assert.equal(events[0].status, 'failed');
        assert.equal(transactions.length, 0);
        assert.equal(credits.length, 0);
    });

    await t.test('mismatched gateway cannot resolve or credit a stored DVA', async () => {
        const otherGateway = storedDva({
            account: { ...storedDva().account, gatewayId: 'gateway-other' }
        });
        reset({ accounts: [otherGateway] });

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(chargePayload()));

        assert.equal(result.status, 200);
        assert.equal(events[0].status, 'failed');
        assert.equal(transactions.length, 0);
        assert.equal(credits.length, 0);
    });

    await t.test('mismatched destination account cannot credit the customer-matched DVA owner', async () => {
        reset();
        const payload = chargePayload({
            authorization: {
                channel: 'dedicated_nuban',
                receiver_bank_account_number: '1111111111',
                receiver_bank: 'Wema Bank'
            }
        });
        verification = verifiedPayment({
            dedicatedNuban: {
                ...verifiedPayment().dedicatedNuban,
                receiverAccountNumber: '1111111111'
            }
        });

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(payload));

        assert.equal(result.status, 200);
        assert.equal(events[0].status, 'failed');
        assert.equal(transactions.length, 0);
        assert.equal(credits.length, 0);
    });

    await t.test('webhook and verification destination-account mismatch fails before owner resolution', async () => {
        reset();
        verification = verifiedPayment({
            dedicatedNuban: {
                ...verifiedPayment().dedicatedNuban,
                receiverAccountNumber: '1111111111'
            }
        });

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(chargePayload()));

        assert.equal(result.status, 200);
        assert.equal(events[0].status, 'failed');
        assert.equal(transactions.length, 0);
        assert.equal(credits.length, 0);
    });

    await t.test('malformed dedicated-NUBAN payload is rejected without verification side effects', async () => {
        reset();
        const payload = chargePayload({
            reference: '',
            authorization: { channel: 'dedicated_nuban' },
            customer: {}
        });

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(payload));

        assert.equal(result.status, 200);
        assert.equal(events[0].status, 'failed');
        assert.equal(verifyCalls, 0);
        assert.equal(transactions.length, 0);
        assert.equal(credits.length, 0);
    });

    await t.test('already-settled DVA transaction remains exactly once', async () => {
        const settled = {
            refId: 'DVA_DEPOSIT_1',
            userId: 'user-1',
            type: 'funding',
            status: 'success',
            amountKobo: 500000,
            expectedCurrency: 'NGN',
            channels: ['virtual_account'],
            provider: 'paystack',
            gatewayId: GATEWAY_ID,
            providerRef: '77001',
            confirmedAmountKobo: 500000,
            confirmedCurrency: 'NGN',
            confirmedProvider: 'paystack',
            confirmedReference: 'DVA_DEPOSIT_1',
            confirmedProviderRef: '77001'
        };
        reset({ seededTransactions: [settled] });

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(chargePayload()));

        assert.equal(result.status, 200);
        assert.equal(transactions.length, 1);
        assert.equal(transactions[0].status, 'success');
        assert.equal(credits.length, 0);
        assert.equal(ledger.length, 0);
        assert.equal(events[0].status, 'processed');
    });

    await t.test('verified DVA cannot bypass ownership through the generic transaction path', async () => {
        const ordinaryTransaction = {
            refId: 'DVA_DEPOSIT_1',
            userId: 'attacker-controlled-user',
            type: 'funding',
            status: 'pending',
            amountKobo: 500000,
            expectedCurrency: 'NGN',
            channels: ['card'],
            provider: 'paystack',
            service: 'Paystack'
        };
        reset({ seededTransactions: [ordinaryTransaction] });
        const payload = chargePayload({
            channel: 'card',
            authorization: { channel: 'card' }
        });

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(payload));

        assert.equal(result.status, 200);
        assert.equal(events[0].status, 'failed');
        assert.equal(transactions[0].status, 'pending');
        assert.equal(credits.length, 0);
        assert.equal(ledger.length, 0);
    });

    await t.test('ambiguous DVA ownership fails closed', async () => {
        reset({ accounts: [storedDva(), storedDva({ userId: 'user-2' })] });

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(chargePayload()));

        assert.equal(result.status, 200);
        assert.equal(events[0].status, 'failed');
        assert.equal(transactions.length, 0);
        assert.equal(credits.length, 0);
    });
});
