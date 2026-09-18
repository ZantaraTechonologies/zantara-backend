'use strict';

/**
 * Admin reconciliation settlement regression tests for the token/lease-owned
 * authoritative settlement path. Runs against a transactional in-memory store.
 */

const assert = require('assert/strict');
const mongoose = require('mongoose');

const Transaction = require('../models/Transaction');
const TransactionStatus = require('../models/TransactionStatus');
const WalletLedger = require('../models/WalletLedger');
const paymentGatewayService = require('../services/paymentGateway.service');
const walletService = require('../services/wallet.service');
const investmentService = require('../services/investment.service');
const notificationService = require('../services/notification.service');

const originals = {
    startSession: mongoose.startSession,
    statusFindOne: TransactionStatus.findOne,
    statusUpdateOne: TransactionStatus.updateOne,
    ledgerFindOne: WalletLedger.findOne,
    transactionFindOne: Transaction.findOne,
    transactionCreate: Transaction.create,
    walletCredit: walletService.credit,
    fulfillSharePurchase: investmentService.fulfillSharePurchase,
    sendFundingSuccess: notificationService.sendFundingSuccess
};

let records;
let wallets;
let ledger;
let fulfillments;
let audits;
let notifications;
let claimFilters;
let ledgerFilters;
let sessions;
let sessionSequence;
let failFinalization;

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function comparable(value) {
    return value instanceof Date ? value.getTime() : value;
}

function matchesValue(actual, expected) {
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
        if (Object.prototype.hasOwnProperty.call(expected, '$in')) return expected.$in.includes(actual);
        if (Object.prototype.hasOwnProperty.call(expected, '$lte')) {
            return actual != null && comparable(actual) <= comparable(expected.$lte);
        }
        if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
            return expected.$exists ? actual !== undefined : actual === undefined;
        }
    }
    return comparable(actual) === comparable(expected);
}

function matches(item, filter = {}) {
    if (filter.$or && !filter.$or.some(part => matches(item, part))) return false;
    return Object.entries(filter).every(([key, expected]) => {
        if (key === '$or') return true;
        return matchesValue(item[key], expected);
    });
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
        id: `session-${++sessionSequence}`,
        recordVersions: new Map(),
        stagedRecords: new Map(),
        walletVersions: new Map(),
        stagedWallets: new Map(),
        stagedLedger: [],
        stagedFulfillments: [],
        stagedAudits: [],
        committed: false,
        aborted: false,
        ended: false,
        startTransaction() {},
        readRecord(refId) {
            if (this.stagedRecords.has(refId)) return clone(this.stagedRecords.get(refId));
            const current = records.get(refId);
            if (!current) return null;
            if (!this.recordVersions.has(refId)) this.recordVersions.set(refId, current._version);
            return clone(current);
        },
        stageRecord(record) {
            if (!this.recordVersions.has(record.refId)) {
                const current = records.get(record.refId);
                this.recordVersions.set(record.refId, current ? current._version : -1);
            }
            this.stagedRecords.set(record.refId, clone(record));
        },
        stageCredit(userId, amount, reference, source, settlementKey) {
            const current = wallets.get(userId);
            if (!current) throw new Error('Wallet not found');
            if (!this.walletVersions.has(userId)) this.walletVersions.set(userId, current._version);
            const staged = this.stagedWallets.get(userId) || clone(current);
            const balanceBefore = staged.balance;
            staged.balance += amount;
            this.stagedWallets.set(userId, staged);
            this.stagedLedger.push({
                userId,
                reference,
                entryType: 'credit',
                source,
                amount,
                balanceBefore,
                balanceAfter: staged.balance,
                settlementKey
            });
            return staged.balance;
        },
        async commitTransaction() {
            for (const [refId, version] of this.recordVersions) {
                const current = records.get(refId);
                if (!current || current._version !== version) throw new Error('WriteConflict: settlement record changed');
            }
            for (const [userId, version] of this.walletVersions) {
                const current = wallets.get(userId);
                if (!current || current._version !== version) throw new Error('WriteConflict: wallet changed');
            }
            for (const [refId, staged] of this.stagedRecords) {
                records.set(refId, { ...clone(staged), _version: records.get(refId)._version + 1 });
            }
            for (const [userId, staged] of this.stagedWallets) {
                wallets.set(userId, { ...clone(staged), _version: wallets.get(userId)._version + 1 });
            }
            ledger.push(...clone(this.stagedLedger));
            fulfillments.push(...clone(this.stagedFulfillments));
            audits.push(...clone(this.stagedAudits));
            this.committed = true;
        },
        async abortTransaction() {
            this.stagedRecords.clear();
            this.stagedWallets.clear();
            this.stagedLedger = [];
            this.stagedFulfillments = [];
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
        const current = [...records.values()].find(item => matches(item, filter));
        return query(current ? clone(current) : null, session => {
            return [...records.keys()]
                .map(refId => session.readRecord(refId))
                .find(item => item && matches(item, filter)) || null;
        });
    };

    TransactionStatus.updateOne = async (filter = {}, update = {}, options = {}) => {
        if (!options.session && filter.$or) claimFilters.push(clone(filter));
        const session = options.session;
        if (session) {
            const candidate = [...records.keys()]
                .map(refId => session.readRecord(refId))
                .find(item => item && matches(item, filter));
            if (!candidate) return { matchedCount: 0, modifiedCount: 0 };
            if (failFinalization && filter.status === 'settlement_pending' && update.$set?.status === 'success') {
                throw new Error('injected finalization failure');
            }
            const before = JSON.stringify(candidate);
            applyUpdate(candidate, update);
            session.stageRecord(candidate);
            return { matchedCount: 1, modifiedCount: before === JSON.stringify(candidate) ? 0 : 1 };
        }

        const entry = [...records.entries()].find(([, item]) => matches(item, filter));
        if (!entry) return { matchedCount: 0, modifiedCount: 0 };
        const [refId, current] = entry;
        const updated = clone(current);
        applyUpdate(updated, update);
        records.set(refId, { ...updated, _version: current._version + 1 });
        return { matchedCount: 1, modifiedCount: JSON.stringify(current) === JSON.stringify(updated) ? 0 : 1 };
    };

    WalletLedger.findOne = (filter = {}) => {
        ledgerFilters.push(clone(filter));
        const current = ledger.find(item => matches(item, filter)) || null;
        return query(current, session => {
            return [...ledger, ...session.stagedLedger].find(item => matches(item, filter)) || null;
        });
    };

    walletService.credit = async (userId, amount, reference, source, transactionId, session, options = {}) => {
        assert.ok(session, 'wallet credit must use the settlement transaction session');
        assert.equal(transactionId, null);
        const balance = session.stageCredit(String(userId), amount, reference, source, options.settlementKey);
        return { balance };
    };

    investmentService.fulfillSharePurchase = async (
        userId,
        qty,
        refId,
        isWalletPayment,
        session,
        sharePriceOverride
    ) => {
        assert.ok(session, 'share fulfillment must use the settlement transaction session');
        const existing = [...fulfillments, ...session.stagedFulfillments].find(item => item.refId === refId);
        if (existing) return { success: true, message: 'Already processed' };
        session.stagedFulfillments.push({
            userId: String(userId), qty, refId, isWalletPayment, sharePriceOverride
        });
        return { success: true, qtyPurchased: qty, sharesOwned: qty };
    };

    Transaction.findOne = filter => query(
        audits.find(item => matches(item, filter)) || null,
        session => [...audits, ...session.stagedAudits].find(item => matches(item, filter)) || null
    );

    Transaction.create = async (docs, options = {}) => {
        assert.ok(options.session, 'funding audit must use the settlement transaction session');
        assert.ok(Array.isArray(docs), 'transactional Transaction.create must use the array form');
        const created = docs.map((doc, index) => ({ ...clone(doc), _id: `audit-${audits.length + index + 1}` }));
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
    wallets = new Map();
    ledger = [];
    fulfillments = [];
    audits = [];
    notifications = [];
    claimFilters = [];
    ledgerFilters = [];
    sessions = [];
    sessionSequence = 0;
    failFinalization = false;
}

function addRecord(refId, overrides = {}) {
    const record = {
        refId,
        userId: 'user-settle',
        type: 'funding',
        status: 'processing',
        amountKobo: 50000,
        expectedCurrency: 'NGN',
        confirmedAmountKobo: 50000,
        confirmedCurrency: 'NGN',
        provider: 'paystack',
        confirmedProvider: 'paystack',
        confirmedReference: refId,
        confirmedProviderRef: `PS-${refId}`,
        service: 'Paystack',
        channels: ['bank_transfer'],
        _version: 0,
        ...overrides
    };
    records.set(refId, record);
    if (record.userId && !wallets.has(String(record.userId))) {
        wallets.set(String(record.userId), { userId: String(record.userId), balance: 10000, _version: 0 });
    }
    return record;
}

function current(refId) {
    return records.get(refId);
}

async function runAdminSettlementTests() {
    console.log('==========================================================');
    console.log(' ADMIN TOKEN/LEASE RECONCILIATION SETTLEMENT TEST SUITE   ');
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
        await test('A1. Processing funding is atomically claimed, credited, audited, and finalized', async () => {
            reset();
            addRecord('REF-A1');

            const result = await paymentGatewayService.adminSettleProcessing({
                refId: 'REF-A1', adminId: 'admin-1', note: 'verified provider receipt'
            });

            assert.equal(result.success, true);
            assert.equal(result.settled, true);
            assert.equal(result.credited, true);
            assert.equal(current('REF-A1').status, 'success');
            assert.equal(current('REF-A1').settlementClaimToken, undefined);
            assert.equal(current('REF-A1').settlementLeaseExpiresAt, undefined);
            assert.match(current('REF-A1').reconciliationReason, /verified provider receipt; Admin settlement by admin-1/);
            assert.equal(ledger.length, 1);
            assert.equal(ledger[0].amount, 500);
            assert.equal(ledger[0].settlementKey, 'payment:paystack:REF-A1');
            assert.equal(audits.length, 1);
            assert.deepEqual(
                { transactionId: audits[0].transactionId, refId: audits[0].refId, type: audits[0].type, amount: audits[0].amount, status: audits[0].status },
                { transactionId: 'REF-A1', refId: 'REF-A1', type: 'funding', amount: 500, status: 'success' }
            );
            assert.equal(notifications.length, 1);
            assert.equal(sessions.length, 1);
            assert.equal(sessions[0].committed, true);
            assert.equal(sessions[0].ended, true);

            assert.equal(claimFilters.length, 1);
            const filter = claimFilters[0];
            assert.equal(filter.refId, 'REF-A1');
            assert.deepEqual(filter.status, { $in: ['processing', 'settlement_pending'] });
            assert.equal(filter.$or.length, 2);
            assert.ok(filter.$or[0].settlementLeaseExpiresAt.$lte instanceof Date);
            assert.deepEqual(filter.$or[1], {
                settlementClaimToken: { $exists: false },
                settlementLeaseExpiresAt: { $exists: false }
            });
        });

        await test('A2. Exact historical funding credit is reused without double-credit', async () => {
            reset();
            addRecord('REF-A2');
            ledger.push(
                { reference: 'REF-A2', userId: 'other-user', entryType: 'credit', source: 'funding', amount: 500 },
                { reference: 'REF-A2', userId: 'user-settle', entryType: 'debit', source: 'funding', amount: 500 },
                { reference: 'REF-A2', userId: 'user-settle', entryType: 'credit', source: 'admin', amount: 500 },
                { reference: 'REF-A2', userId: 'user-settle', entryType: 'credit', source: 'funding_retry', amount: 500 }
            );

            const result = await paymentGatewayService.adminSettleProcessing({ refId: 'REF-A2', adminId: 'admin-2' });

            assert.equal(result.credited, false);
            assert.equal(ledger.length, 4, 'an exact historical row must prevent a new credit');
            assert.equal(wallets.get('user-settle').balance, 10000);
            assert.equal(current('REF-A2').status, 'success');
            assert.equal(audits.length, 1, 'the immutable funding audit is still backfilled');
            assert.deepEqual(ledgerFilters, [{
                reference: 'REF-A2',
                userId: 'user-settle',
                entryType: 'credit',
                source: { $in: ['funding', 'funding_retry'] }
            }]);
        });

        await test('A3. Historical credit amount mismatch aborts the transaction', async () => {
            reset();
            addRecord('REF-A3');
            ledger.push({
                reference: 'REF-A3', userId: 'user-settle', entryType: 'credit', source: 'funding', amount: 499
            });

            await assert.rejects(
                paymentGatewayService.adminSettleProcessing({ refId: 'REF-A3' }),
                /Historical funding credit amount does not reconcile/
            );

            assert.equal(current('REF-A3').status, 'reconciliation_required', 'malformed historical credit is quarantined');
            assert.equal(current('REF-A3').settlementClaimToken, undefined, 'quarantine clears settlement authority');
            assert.equal(current('REF-A3').settlementLeaseExpiresAt, undefined, 'quarantine clears the lease');
            assert.equal(wallets.get('user-settle').balance, 10000);
            assert.equal(ledger.length, 1);
            assert.equal(audits.length, 0);
            assert.equal(notifications.length, 0);
            assert.equal(sessions[0].aborted, true);
            assert.equal(sessions[0].ended, true);
        });

        await test('B1. Non-settlement statuses and unknown references are rejected', async () => {
            for (const status of ['pending', 'success', 'failed', 'reconciliation_required']) {
                reset();
                addRecord(`REF-${status}`, { status });
                await assert.rejects(
                    paymentGatewayService.adminSettleProcessing({ refId: `REF-${status}` }),
                    /status or active settlement lease is not eligible/
                );
                assert.equal(ledger.length, 0);
                assert.equal(audits.length, 0);
            }

            reset();
            await assert.rejects(
                paymentGatewayService.adminSettleProcessing({ refId: 'NO-SUCH-REF' }),
                /not found/
            );
            await assert.rejects(paymentGatewayService.adminSettleProcessing({}), /Reference is required/);
        });

        await test('B2. Active leases cannot be stolen and stale tokens cannot settle', async () => {
            reset();
            addRecord('REF-LEASE', {
                status: 'settlement_pending',
                settlementClaimToken: 'current-owner-token',
                settlementLeaseExpiresAt: new Date(Date.now() + 60000)
            });

            await assert.rejects(
                paymentGatewayService.adminSettleProcessing({ refId: 'REF-LEASE', adminId: 'admin-thief' }),
                /active settlement lease is not eligible/
            );
            await assert.rejects(
                paymentGatewayService.adminSettleProcessing({ refId: 'REF-LEASE', claimToken: 'stale-token' }),
                error => error.code === 'SETTLEMENT_CLAIM_LOST'
            );
            assert.equal(current('REF-LEASE').settlementClaimToken, 'current-owner-token');
            assert.equal(ledger.length, 0);
            assert.equal(audits.length, 0);
        });

        await test('B3. Current token owner can settle an active lease', async () => {
            reset();
            addRecord('REF-OWNER', {
                status: 'settlement_pending',
                settlementClaimToken: 'current-owner-token',
                settlementLeaseExpiresAt: new Date(Date.now() + 60000)
            });

            const result = await paymentGatewayService.adminSettleProcessing({
                refId: 'REF-OWNER', claimToken: 'current-owner-token', automatedRecovery: true
            });

            assert.equal(result.settled, true);
            assert.equal(result.source, 'automatic_recovery');
            assert.equal(current('REF-OWNER').status, 'success');
            assert.equal(ledger.length, 1);
            assert.equal(claimFilters.length, 0, 'an existing token must not perform a new claim');
        });

        await test('B4. Complete, matching persisted provider evidence is mandatory', async () => {
            const required = [
                'confirmedAmountKobo',
                'confirmedCurrency',
                'confirmedProvider',
                'confirmedReference',
                'confirmedProviderRef'
            ];
            for (const field of required) {
                reset();
                const record = addRecord(`REF-MISSING-${field}`);
                delete record[field];
                await assert.rejects(paymentGatewayService.adminSettleProcessing({ refId: record.refId }));
                assert.notEqual(current(record.refId).status, 'success');
                assert.equal(ledger.length, 0);
                assert.equal(audits.length, 0);
            }

            reset();
            addRecord('REF-EVIDENCE-MISMATCH', { confirmedReference: 'ATTACKER-REF' });
            await assert.rejects(
                paymentGatewayService.adminSettleProcessing({ refId: 'REF-EVIDENCE-MISMATCH' }),
                /Persisted settlement reference mismatch/
            );
            assert.equal(ledger.length, 0);
        });

        await test('C1. Investment quantity and fulfillment price bind to the persisted snapshot', async () => {
            reset();
            addRecord('REF-INV1', {
                type: 'investment_buy',
                amountKobo: 1600000,
                confirmedAmountKobo: 1600000,
                sharePrice: 8000
            });

            const result = await paymentGatewayService.adminSettleProcessing({ refId: 'REF-INV1', adminId: 'admin-1' });

            assert.equal(result.settled, true);
            assert.equal(result.credited, true);
            assert.equal(fulfillments.length, 1);
            assert.equal(fulfillments[0].qty, 2);
            assert.equal(fulfillments[0].sharePriceOverride, 8000);
            assert.equal(fulfillments[0].isWalletPayment, false);
            assert.equal(current('REF-INV1').status, 'success');
            assert.equal(audits.length, 0, 'investment fulfillment must not create a funding audit');
        });

        await test('C2. Already fulfilled investment is finalized without re-fulfillment', async () => {
            reset();
            addRecord('REF-INV2', {
                type: 'investment_buy',
                amountKobo: 1600000,
                confirmedAmountKobo: 1600000,
                sharePrice: 8000
            });
            fulfillments.push({ userId: 'user-settle', qty: 2, refId: 'REF-INV2', sharePriceOverride: 8000 });

            const result = await paymentGatewayService.adminSettleProcessing({ refId: 'REF-INV2' });

            assert.equal(result.credited, false);
            assert.equal(fulfillments.length, 1);
            assert.equal(current('REF-INV2').status, 'success');
        });

        await test('C3. Non-whole-share amount rolls back fulfillment and finalization', async () => {
            reset();
            addRecord('REF-INV3', {
                type: 'investment_buy',
                amountKobo: 1500000,
                confirmedAmountKobo: 1500000,
                sharePrice: 8000
            });

            await assert.rejects(
                paymentGatewayService.adminSettleProcessing({ refId: 'REF-INV3' }),
                /not a whole multiple/
            );
            assert.equal(current('REF-INV3').status, 'reconciliation_required');
            assert.equal(fulfillments.length, 0);
            assert.equal(sessions[0].aborted, true);
        });

        await test('D1. Concurrent administrators produce one claimant and exactly one credit', async () => {
            reset();
            addRecord('REF-CONCURRENT');

            const outcomes = await Promise.allSettled([
                paymentGatewayService.adminSettleProcessing({ refId: 'REF-CONCURRENT', adminId: 'admin-a' }),
                paymentGatewayService.adminSettleProcessing({ refId: 'REF-CONCURRENT', adminId: 'admin-b' })
            ]);

            assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value.settled).length, 1);
            assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
            assert.equal(ledger.length, 1);
            assert.equal(audits.length, 1);
            assert.equal(notifications.length, 1);
            assert.equal(wallets.get('user-settle').balance, 10500);
            assert.equal(current('REF-CONCURRENT').status, 'success');
            assert.equal(sessions.length, 1, 'the failed atomic claimant must never enter settlement');
            assert.equal(claimFilters.length, 2, 'both contenders must use the lease-aware atomic filter');
        });

        await test('D2. Finalization failure rolls back credit, audit, and transactional status', async () => {
            reset();
            addRecord('REF-ROLLBACK');
            failFinalization = true;

            await assert.rejects(
                paymentGatewayService.adminSettleProcessing({ refId: 'REF-ROLLBACK' }),
                /injected finalization failure/
            );

            assert.equal(current('REF-ROLLBACK').status, 'settlement_pending');
            assert.equal(wallets.get('user-settle').balance, 10000);
            assert.equal(ledger.length, 0);
            assert.equal(audits.length, 0);
            assert.equal(notifications.length, 0);
            assert.equal(sessions[0].aborted, true);
            assert.equal(sessions[0].committed, false);
            assert.equal(sessions[0].ended, true);
        });
    } finally {
        mongoose.startSession = originals.startSession;
        TransactionStatus.findOne = originals.statusFindOne;
        TransactionStatus.updateOne = originals.statusUpdateOne;
        WalletLedger.findOne = originals.ledgerFindOne;
        Transaction.findOne = originals.transactionFindOne;
        Transaction.create = originals.transactionCreate;
        walletService.credit = originals.walletCredit;
        investmentService.fulfillSharePurchase = originals.fulfillSharePurchase;
        notificationService.sendFundingSuccess = originals.sendFundingSuccess;
    }

    console.log('\n-----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('-----------------------------------------------------\n');
    process.exitCode = failed > 0 ? 1 : 0;
}

runAdminSettlementTests().catch(error => {
    console.error('[FATAL TEST ERROR]', error);
    process.exitCode = 1;
});
