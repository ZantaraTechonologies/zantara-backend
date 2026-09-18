'use strict';

/**
 * Investment fulfillment trust-boundary tests. These exercise the public
 * finalizeFundingCredit path, including its token-owned transactional settle.
 */

const assert = require('assert/strict');
const mongoose = require('mongoose');

const Transaction = require('../models/Transaction');
const TransactionStatus = require('../models/TransactionStatus');
const WalletLedger = require('../models/WalletLedger');
const paymentGatewayService = require('../services/paymentGateway.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');
const investmentService = require('../services/investment.service');

const originals = {
    startSession: mongoose.startSession,
    statusFindOne: TransactionStatus.findOne,
    statusUpdateOne: TransactionStatus.updateOne,
    ledgerFindOne: WalletLedger.findOne,
    transactionFindOne: Transaction.findOne,
    transactionCreate: Transaction.create,
    getInvestmentSettings: investmentService.getInvestmentSettings,
    fulfillSharePurchase: investmentService.fulfillSharePurchase,
    walletCredit: walletService.credit,
    sendFundingSuccess: notificationService.sendFundingSuccess
};

let records;
let fulfillments;
let walletCredits;
let audits;
let notifications;
let settingsReads;
let sessions;

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function matchesValue(actual, expected) {
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
        if (Object.prototype.hasOwnProperty.call(expected, '$in')) return expected.$in.includes(actual);
    }
    return actual === expected;
}

function matches(item, filter = {}) {
    return Object.entries(filter).every(([key, expected]) => matchesValue(item[key], expected));
}

function applyUpdate(item, update = {}) {
    if (update.$set) Object.assign(item, clone(update.$set));
    if (update.$unset) {
        for (const key of Object.keys(update.$unset)) delete item[key];
    }
}

function query(value, sessionReader) {
    return {
        session: session => Promise.resolve(sessionReader ? sessionReader(session) : value),
        then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
        catch: reject => Promise.resolve(value).catch(reject)
    };
}

function createSession() {
    const session = {
        stagedRecord: null,
        stagedFulfillments: [],
        stagedCredits: [],
        stagedAudits: [],
        committed: false,
        aborted: false,
        ended: false,
        startTransaction() {},
        async commitTransaction() {
            if (this.stagedRecord) Object.assign(records.get(this.stagedRecord.refId), clone(this.stagedRecord));
            fulfillments.push(...clone(this.stagedFulfillments));
            walletCredits.push(...clone(this.stagedCredits));
            audits.push(...clone(this.stagedAudits));
            this.committed = true;
        },
        async abortTransaction() {
            this.stagedRecord = null;
            this.stagedFulfillments = [];
            this.stagedCredits = [];
            this.stagedAudits = [];
            this.aborted = true;
        },
        endSession() {
            this.ended = true;
        }
    };
    sessions.push(session);
    return session;
}

function installMocks() {
    mongoose.startSession = async () => createSession();

    TransactionStatus.findOne = (filter = {}) => {
        const current = [...records.values()].find(item => matches(item, filter)) || null;
        return query(current, session => {
            const candidate = session.stagedRecord || current;
            return candidate && matches(candidate, filter) ? clone(candidate) : null;
        });
    };

    TransactionStatus.updateOne = async (filter = {}, update = {}, options = {}) => {
        const current = options.session?.stagedRecord || [...records.values()].find(item => matches(item, filter));
        if (!current || !matches(current, filter)) return { matchedCount: 0, modifiedCount: 0 };
        const updated = clone(current);
        applyUpdate(updated, update);
        if (options.session) options.session.stagedRecord = updated;
        else Object.assign(records.get(updated.refId), updated);
        return { matchedCount: 1, modifiedCount: 1 };
    };

    WalletLedger.findOne = filter => query(
        walletCredits.find(item => matches(item, filter)) || null,
        session => [...walletCredits, ...session.stagedCredits].find(item => matches(item, filter)) || null
    );

    investmentService.getInvestmentSettings = async () => {
        settingsReads++;
        return { sharePrice: 10000 };
    };

    investmentService.fulfillSharePurchase = async (
        userId,
        qty,
        refId,
        isWalletPayment,
        session,
        sharePriceOverride
    ) => {
        assert.ok(session, 'investment fulfillment must participate in the settlement transaction');
        session.stagedFulfillments.push({
            userId: String(userId), qty, refId, isWalletPayment, sharePriceOverride
        });
        return { success: true, qtyPurchased: qty, sharesOwned: qty };
    };

    walletService.credit = async (userId, amount, reference, source, transactionId, session, options) => {
        assert.ok(session, 'funding credit must participate in the settlement transaction');
        session.stagedCredits.push({
            userId: String(userId), amount, reference, source, transactionId,
            settlementKey: options.settlementKey,
            entryType: 'credit'
        });
        return { balance: 1000 + amount };
    };

    Transaction.findOne = filter => query(
        audits.find(item => matches(item, filter)) || null,
        session => [...audits, ...session.stagedAudits].find(item => matches(item, filter)) || null
    );

    Transaction.create = async (docs, options = {}) => {
        assert.ok(options.session, 'funding audit must use the settlement transaction');
        const created = docs.map(doc => ({ ...clone(doc), _id: `audit-${audits.length + 1}` }));
        options.session.stagedAudits.push(...created);
        return created;
    };

    notificationService.sendFundingSuccess = async payload => {
        notifications.push(clone(payload));
        return { success: true };
    };
}

function reset() {
    records = new Map();
    fulfillments = [];
    walletCredits = [];
    audits = [];
    notifications = [];
    settingsReads = 0;
    sessions = [];
}

function makeSettlement({ type = 'investment_buy', amountNaira = 10000, qtyMeta = 999, sharePrice = 10000 }) {
    const refId = `REF-${type}-${amountNaira}-${Math.random().toString(36).slice(2, 8)}`;
    const transactionStatus = {
        refId,
        userId: 'user-1',
        type,
        status: 'pending',
        amountKobo: Math.round(amountNaira * 100),
        expectedCurrency: 'NGN',
        provider: 'paystack',
        service: 'Paystack',
        channels: ['bank_transfer'],
        ...(type === 'investment_buy' ? { sharePrice } : {})
    };
    const gatewayPaymentResult = {
        status: 'success',
        amount: amountNaira,
        currency: 'NGN',
        reference: refId,
        gateway: 'paystack',
        providerTransactionId: `PS-${refId}`,
        metadata: { qty: qtyMeta, type },
        raw: { source: 'provider-verify', metadata: { qty: qtyMeta } }
    };
    records.set(refId, transactionStatus);
    return { transactionStatus, gatewayPaymentResult };
}

async function runInvestmentMetadataTrustTests() {
    console.log('==========================================================');
    console.log(' INVESTMENT AUTHORITATIVE SETTLEMENT TRUST TEST SUITE     ');
    console.log('==========================================================\n');

    installMocks();
    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            passed++;
            console.log(`  [PASS] ${name}`);
        } catch (error) {
            failed++;
            console.error(`  [FAIL] ${name}`);
            console.error(`   Error: ${error.message}`);
            if (process.env.VERBOSE) console.error(error.stack);
        }
    }

    try {
        await test('metadata.qty is ignored; one paid share yields exactly one share', async () => {
            reset();
            const settlement = makeSettlement({ amountNaira: 10000, qtyMeta: 999 });

            const result = await paymentGatewayService.finalizeFundingCredit(settlement);

            assert.equal(result.success, true);
            assert.equal(result.credited, true);
            assert.equal(fulfillments.length, 1);
            assert.equal(fulfillments[0].qty, 1, 'provider metadata.qty=999 must not influence fulfillment');
            assert.equal(fulfillments[0].sharePriceOverride, 10000);
            assert.equal(records.get(settlement.transactionStatus.refId).confirmedAmountKobo, 1000000);
            assert.equal(records.get(settlement.transactionStatus.refId).confirmedProviderRef, `PS-${settlement.transactionStatus.refId}`);
        });

        await test('quantity is amount-derived when provider metadata is absent', async () => {
            reset();
            const settlement = makeSettlement({ amountNaira: 20000, qtyMeta: 1 });
            delete settlement.gatewayPaymentResult.metadata;
            delete settlement.gatewayPaymentResult.raw.metadata;

            const result = await paymentGatewayService.finalizeFundingCredit(settlement);

            assert.equal(result.success, true);
            assert.equal(fulfillments.length, 1);
            assert.equal(fulfillments[0].qty, 2);
            assert.equal(records.get(settlement.transactionStatus.refId).status, 'success');
        });

        await test('non-whole-share confirmed amount is rejected and fulfillment rolls back', async () => {
            reset();
            const settlement = makeSettlement({ amountNaira: 15000, qtyMeta: 2 });

            await assert.rejects(
                paymentGatewayService.finalizeFundingCredit(settlement),
                /not a whole multiple/
            );

            assert.equal(fulfillments.length, 0);
            assert.equal(walletCredits.length, 0);
            assert.equal(audits.length, 0);
            assert.equal(records.get(settlement.transactionStatus.refId).status, 'reconciliation_required');
            assert.equal(sessions.length, 1);
            assert.equal(sessions[0].aborted, true);
            assert.equal(sessions[0].ended, true);
        });

        await test('ordinary funding still credits the wallet and creates its audit', async () => {
            reset();
            const settlement = makeSettlement({ type: 'funding', amountNaira: 25000, qtyMeta: 999 });

            const result = await paymentGatewayService.finalizeFundingCredit(settlement);

            assert.equal(result.success, true);
            assert.equal(result.credited, true);
            assert.equal(walletCredits.length, 1);
            assert.equal(walletCredits[0].amount, 25000);
            assert.equal(walletCredits[0].settlementKey, `payment:paystack:${settlement.transactionStatus.refId}`);
            assert.equal(fulfillments.length, 0);
            assert.equal(audits.length, 1);
            assert.equal(audits[0].transactionId, settlement.transactionStatus.refId);
            assert.equal(audits[0].amount, 25000);
            assert.equal(records.get(settlement.transactionStatus.refId).status, 'success');
        });

        await test('init-time sharePrice snapshot remains authoritative after settings change', async () => {
            reset();
            const settlement = makeSettlement({ amountNaira: 16000, qtyMeta: 1, sharePrice: 8000 });

            const result = await paymentGatewayService.finalizeFundingCredit(settlement);

            assert.equal(result.success, true);
            assert.equal(fulfillments.length, 1);
            assert.equal(fulfillments[0].qty, 2, '16000 / snapshotted 8000 must fulfill two shares');
            assert.equal(fulfillments[0].sharePriceOverride, 8000);
            assert.equal(settingsReads, 0, 'settlement must not re-read the current 10000 share price');
            assert.equal(records.get(settlement.transactionStatus.refId).sharePrice, 8000);
        });
    } finally {
        mongoose.startSession = originals.startSession;
        TransactionStatus.findOne = originals.statusFindOne;
        TransactionStatus.updateOne = originals.statusUpdateOne;
        WalletLedger.findOne = originals.ledgerFindOne;
        Transaction.findOne = originals.transactionFindOne;
        Transaction.create = originals.transactionCreate;
        investmentService.getInvestmentSettings = originals.getInvestmentSettings;
        investmentService.fulfillSharePurchase = originals.fulfillSharePurchase;
        walletService.credit = originals.walletCredit;
        notificationService.sendFundingSuccess = originals.sendFundingSuccess;
    }

    console.log('\n-----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('-----------------------------------------------------\n');
    process.exitCode = failed > 0 ? 1 : 0;
}

runInvestmentMetadataTrustTests().catch(error => {
    console.error('[FATAL TEST ERROR]', error);
    process.exitCode = 1;
});
