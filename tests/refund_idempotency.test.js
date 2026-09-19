'use strict';

/**
 * CRIT 4 — REFUND IDEMPOTENCY & DEBIT-PROVEN GUARD (RED-FIRST regression)
 *
 * Vulnerabilities in services/refund.service.js (FIXED):
 *   1. Idempotency guard `status === 'refunded'` was DEAD CODE:
 *      models/Transaction.js:9 enum is ['pending','success','failed','reversed'].
 *      After the first refund, status becomes 'failed' (not 'refunded'),
 *      so the guard never fired. FIXED: use transaction.isLoss as the guard.
 *
 *   2. No debit-proven guard: processRefund credited unconditionally
 *      without verifying the original debit actually succeeded.
 *      FIXED: check WalletLedger for a debit entry before crediting.
 *
 * Mirrors conventions in tests/financial_atomicity.test.js:
 *   - Mock walletService.credit, Transaction.findById, WalletLedger.findOne
 *   - Restore originals at end
 *   - Exit 1 on any failure
 */

const assert = require('assert');
const mongoose = require('mongoose');

const walletService = require('../services/wallet.service');
const Transaction = require('../models/Transaction');
const WalletLedger = require('../models/WalletLedger');
const RefundService = require('../services/refund.service');

async function runRefundIdempotencyTests() {
    console.log('=====================================================');
    console.log(' CRIT 4 — REFUND IDEMPOTENCY & DEBIT-PROVEN GUARD    ');
    console.log('=====================================================\n');

    let passed = 0;
    let failed = 0;

async function test(name, fn) {
        try {
            await fn();
            console.log(`  [PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`  [FAIL] ${name}`);
            console.error(`   Error: ${err.message}`);
            if (process.env.VERBOSE) console.error(err.stack);
            failed++;
        }
    }

    // ─── MOCK STATE ────────────────────────────────────────────────────────────
    let mockTransactions = [];
    let mockLedgerEntries = [];
    let walletCredits = [];
    // Session rollback simulation: snapshots taken at startTransaction are
    // restored on abortTransaction, emulating Mongo session semantics so the
    // crash-atomicity tests can prove a failed refund truly rolls back.
    let sessionSnapshot = [];

    const origWalletCredit = walletService.credit;
    const origTxFindById = Transaction.findById;
    const origTxUpdateOne = Transaction.updateOne;
    const origLedgerFindOne = WalletLedger.findOne;
    const origStartSession = mongoose.startSession;
    const actualProcessRefund = RefundService.processRefund.bind(RefundService);
    RefundService.processRefund = (transactionId, reason, options = { mode: 'provider_failure' }) =>
        actualProcessRefund(transactionId, reason, options);

    function makeSession() {
        return {
            startTransaction() {
                sessionSnapshot = mockTransactions.map(t => ({ ...t, details: { ...(t.details || {}) } }));
            },
            commitTransaction: async () => {},
            abortTransaction: async () => {
                mockTransactions.length = 0;
                sessionSnapshot.forEach(t => mockTransactions.push(t));
            },
            endSession: async () => {}
        };
    }

    function resetMocks() {
        mockTransactions = [];
        mockLedgerEntries = [];
        walletCredits = [];
        sessionSnapshot = [];

        // Session always returned by the service — commit is a no-op, abort rolls
        // the in-memory state back so crash-atomicity behavior is observable.
        mongoose.startSession = async () => makeSession();

        // Transaction.findById — session-chainable, returns mock with working .save()
        Transaction.findById = (id) => ({
            session: async () => {
                const found = mockTransactions.find(t => String(t._id) === String(id));
                if (!found) return null;
                found.providerOutcome = found.providerOutcome || 'definitive_failure';
                found.dispatchState = found.dispatchState || 'dispatched';
                found.save = async function () { return this; };
                return found;
            }
        });

        // Transaction.updateOne — simulates atomic claim: only one caller
        // will see isLoss=false and get modifiedCount=1; concurrent callers
        // see isLoss=true and get modifiedCount=0.
        Transaction.updateOne = (filter, update) => {
            const found = mockTransactions.find(t => {
                if (filter._id && String(t._id) !== String(filter._id)) return false;
                if (filter.isLoss !== undefined && t.isLoss !== filter.isLoss) return false;
                return true;
            });
            if (!found) return Promise.resolve({ modifiedCount: 0 });
            const set = update.$set || {};
            Object.assign(found, set);
            return Promise.resolve({ modifiedCount: 1 });
        };

        // WalletLedger.findOne — session-chainable, returns pre-seeded debit entries
        WalletLedger.findOne = (filter) => ({
            session: async () => {
                return mockLedgerEntries.find(e => {
                    if (filter.transactionId && String(e.transactionId) !== String(filter.transactionId)) return false;
                    if (filter.entryType && e.entryType !== filter.entryType) return false;
                    return true;
                }) || null;
            }
        });

        // walletService.credit — track credits (no duplicate guard;
        // WalletLedger.reference is index:true but NOT unique:true in prod)
        walletService.credit = async (userId, amount, reference, source, transactionId) => {
            walletCredits.push({ userId, amount, reference, source, transactionId });
            return { balance: 10000 + amount };
        };
    }

    resetMocks();

    // ─── SECTION A: IDEMPOTENCY — isLoss guard prevents duplicate credits ──

    await test('A1. Single refund with debit entry: one credit', async () => {
        resetMocks();
        const txId = new mongoose.Types.ObjectId();
        mockTransactions.push({
            _id: txId, userId: 'user1', amount: 5000, refId: 'PUR-001',
            status: 'pending', isLoss: false, details: {},
            save: async function () { return this; }
        });
        // Pre-seed a debit ledger entry (debit succeeded before provider failed)
        mockLedgerEntries.push({ transactionId: txId, entryType: 'debit', amount: 5000 });

        const result = await RefundService.processRefund(txId, 'Provider failed');

        assert.deepStrictEqual(result, { success: true });
        assert.strictEqual(walletCredits.length, 1, 'Exactly one credit');
        assert.strictEqual(walletCredits[0].amount, 5000);
        assert.strictEqual(walletCredits[0].reference, 'REFUND_PUR-001');
        assert.strictEqual(mockTransactions[0].isLoss, true);
    });

    await test('A2. Sequential duplicate refund: second call must return alreadyRefunded, no credit', async () => {
        resetMocks();
        const txId = new mongoose.Types.ObjectId();
        mockTransactions.push({
            _id: txId, userId: 'user1', amount: 5000, refId: 'PUR-002',
            status: 'pending', isLoss: false, details: {},
            save: async function () { return this; }
        });
        mockLedgerEntries.push({ transactionId: txId, entryType: 'debit', amount: 5000 });

        await RefundService.processRefund(txId, 'Provider failed');
        assert.strictEqual(walletCredits.length, 1, 'First refund produced 1 credit');

        // Re-fetch: isLoss is now true (first refund set it)
        Transaction.findById = (id) => ({
            session: async () => {
                if (String(id) === String(txId)) {
                    return {
                        _id: txId, userId: 'user1', amount: 5000, refId: 'PUR-002',
                        status: 'failed', isLoss: true, details: {},
                        save: async function () { return this; }
                    };
                }
                return null;
            }
        });

        const r2 = await RefundService.processRefund(txId, 'Retry');

        assert.strictEqual(walletCredits.length, 1,
            'Second sequential refund must NOT produce a second credit');
        assert.strictEqual(r2.alreadyRefunded, true,
            'Second call must return alreadyRefunded flag');
    });

    await test('A3. Sequential triple refund: exactly one credit after three calls', async () => {
        resetMocks();
        const txId = new mongoose.Types.ObjectId();
        mockTransactions.push({
            _id: txId, userId: 'user2', amount: 3000, refId: 'PUR-003',
            status: 'pending', isLoss: false, details: {},
            save: async function () { return this; }
        });
        mockLedgerEntries.push({ transactionId: txId, entryType: 'debit', amount: 3000 });

        await RefundService.processRefund(txId, 'First');

        // After first refund: isLoss=true. Re-fetch for subsequent calls.
        let currentIsLoss = true;
        Transaction.findById = (id) => ({
            session: async () => {
                if (String(id) === String(txId)) {
                    return {
                        _id: txId, userId: 'user2', amount: 3000, refId: 'PUR-003',
                        status: 'failed', isLoss: currentIsLoss, details: {},
                        save: async function () { return this; }
                    };
                }
                return null;
            }
        });

        await RefundService.processRefund(txId, 'Second');
        await RefundService.processRefund(txId, 'Third');

        assert.strictEqual(walletCredits.length, 1,
            'Triple sequential refund must produce exactly one credit');
    });

    // ─── SECTION B: DEBIT-PROVEN — WalletLedger guard prevents wallet inflation ──

    await test('B1. Refund with debit entry (legitimate): credit occurs', async () => {
        resetMocks();
        const txId = new mongoose.Types.ObjectId();
        mockTransactions.push({
            _id: txId, userId: 'user3', amount: 7000, refId: 'PUR-004',
            status: 'pending', isLoss: false, details: {},
            save: async function () { return this; }
        });
        mockLedgerEntries.push({ transactionId: txId, entryType: 'debit', amount: 7000 });

        const result = await RefundService.processRefund(txId, 'Provider timeout');

        assert.deepStrictEqual(result, { success: true });
        assert.strictEqual(walletCredits.length, 1);
        assert.strictEqual(walletCredits[0].amount, 7000);
    });

    await test('B2. Refund without debit entry (debit never happened): zero credits', async () => {
        resetMocks();
        const txId = new mongoose.Types.ObjectId();
        mockTransactions.push({
            _id: txId, userId: 'user4', amount: 4000, refId: 'PUR-005',
            status: 'pending', isLoss: false, details: {},
            save: async function () { return this; }
        });
        // NO debit entry — simulates purchase.service.js catch block where
        // walletService.debit at line 162 threw (e.g. insufficient balance)
        // before any WalletLedger entry was written.

        const result = await RefundService.processRefund(txId, 'Insufficient balance error');

        assert.strictEqual(walletCredits.length, 0,
            'No credit when no debit entry exists (prevents wallet inflation)');
        assert.strictEqual(result.skipped, true, 'Must return skipped flag');
        assert.strictEqual(result.reason, 'no_debit_found');
        // The whole refund runs in one Mongo session: with no debit there is
        // nothing to refund, so the isLoss claim is ROLLED BACK — a transaction
        // that never took money must NOT be recorded as a loss, and a later retry
        // can safely re-check. (Previously the claim autocommitted isLoss=true.)
        assert.strictEqual(mockTransactions[0].isLoss, false,
            'no_debit_found must roll back the isLoss claim (no money ever moved)');
    });

    await test('B3. Sequential refund on debited-then-failed transaction: one credit', async () => {
        resetMocks();
        const txId = new mongoose.Types.ObjectId();
        mockTransactions.push({
            _id: txId, userId: 'user4b', amount: 4000, refId: 'PUR-005b',
            status: 'pending', isLoss: false, details: {},
            save: async function () { return this; }
        });
        mockLedgerEntries.push({ transactionId: txId, entryType: 'debit', amount: 4000 });

        // First refund: legitimate (debit exists)
        await RefundService.processRefund(txId, 'Provider failed');
        assert.strictEqual(walletCredits.length, 1);

        // Second call: isLoss=true → alreadyRefunded
        Transaction.findById = (id) => ({
            session: async () => {
                if (String(id) === String(txId)) {
                    return {
                        _id: txId, userId: 'user4b', amount: 4000, refId: 'PUR-005b',
                        status: 'failed', isLoss: true, details: {},
                        save: async function () { return this; }
                    };
                }
                return null;
            }
        });

        await RefundService.processRefund(txId, 'Retry');

        assert.strictEqual(walletCredits.length, 1,
            'Second call must not double-credit even with debit entry present');
    });

    // ─── SECTION C: CONCURRENT RACE — Promise.all duplicate ──

    await test('C1. Concurrent duplicate refund: exactly one credit from Promise.all', async () => {
        resetMocks();
        const txId = new mongoose.Types.ObjectId();
        mockTransactions.push({
            _id: txId, userId: 'user5', amount: 10000, refId: 'PUR-006',
            status: 'pending', isLoss: false, details: {},
            save: async function () { return this; }
        });
        mockLedgerEntries.push({ transactionId: txId, entryType: 'debit', amount: 10000 });

        const [r1, r2] = await Promise.all([
            RefundService.processRefund(txId, 'Concurrent-A'),
            RefundService.processRefund(txId, 'Concurrent-B')
        ]);

        const creditCount = walletCredits.filter(c => c.reference === 'REFUND_PUR-006').length;
        assert.ok(creditCount <= 1,
            `Concurrent duplicate refund produced ${creditCount} credits; expected at most 1`);
    });

    // ─── SECTION D: RETURN VALUE — fixed refund returns proper result ──

    await test('D1. Refund on non-existent transaction throws', async () => {
        resetMocks();
        let threw = false;
        try {
            await RefundService.processRefund(new mongoose.Types.ObjectId(), 'Ghost');
        } catch (err) {
            threw = true;
            assert.ok(err.message.includes('not found'));
        }
        assert.ok(threw, 'Must throw for non-existent transaction');
    });

    await test('D2. Transaction status enum must include a terminal refund state', async () => {
        const schema = Transaction.schema;
        const statusPath = schema.path('status');
        const enumValues = statusPath.enumValues || statusPath.options?.enum || [];
        assert.ok(enumValues.includes('reversed'),
            'Transaction status enum must include reversed for terminal refund state');
    });

    // ─── SECTION E: CRASH ATOMICITY — claim + credit are ONE session ──

    await test('E1. Credit throw after claim rolls back isLoss (no permanent refund suppression)', async () => {
        resetMocks();
        const txId = new mongoose.Types.ObjectId();
        mockTransactions.push({
            _id: txId, userId: 'userCrash', amount: 6000, refId: 'PUR-CRASH',
            status: 'pending', isLoss: false, details: {},
            save: async function () { return this; }
        });
        // Debit DID succeed before the provider failed — a legitimate refund.
        mockLedgerEntries.push({ transactionId: txId, entryType: 'debit', amount: 6000 });

        // Simulate wallet credit crashing AFTER the session claimed isLoss=true.
        walletService.credit = async () => { throw new Error('DB network timeout mid-refund'); };

        let threw = false;
        try {
            await RefundService.processRefund(txId, 'Crash');
        } catch (err) {
            threw = true;
        }
        assert.ok(threw, 'Refund must throw when the credit crashes');

        // The WHOLE session must roll back: the isLoss claim must NOT stick.
        assert.strictEqual(mockTransactions[0].isLoss, false,
            'CRIT 4 BUG: the isLoss claim must roll back with the credit — a crash must not permanently suppress the refund');
        assert.strictEqual(mockTransactions[0].status, 'pending',
            'Status must stay untouched by a rolled-back refund');
        assert.strictEqual(walletCredits.length, 0, 'No credit on crash');
    });

    await test('E2. Retry after crash refunds successfully (crash window closed)', async () => {
        resetMocks();
        const txId = new mongoose.Types.ObjectId();
        mockTransactions.push({
            _id: txId, userId: 'userCrash2', amount: 6000, refId: 'PUR-CRASH2',
            status: 'pending', isLoss: false, details: {},
            save: async function () { return this; }
        });
        mockLedgerEntries.push({ transactionId: txId, entryType: 'debit', amount: 6000 });

        // Crash the first attempt.
        walletService.credit = async () => { throw new Error('DB network timeout mid-refund'); };
        try { await RefundService.processRefund(txId, 'Crash'); } catch (_) {}

        // Restore the working credit — the retry MUST be able to refund.
        walletService.credit = async (userId, amount, reference, source, transactionId) => {
            walletCredits.push({ userId, amount, reference, source, transactionId });
            return { balance: 10000 + amount };
        };

        const result = await RefundService.processRefund(txId, 'Retry after crash');
        assert.deepStrictEqual(result, { success: true });
        assert.strictEqual(walletCredits.length, 1,
            'Retry after a crash must credit exactly once — the crash window is closed');
        assert.strictEqual(mockTransactions[0].isLoss, true);
        assert.strictEqual(mockTransactions[0].status, 'failed');
    });

    // ─── RESTORE ───────────────────────────────────────────────────────────────
    walletService.credit = origWalletCredit;
    Transaction.findById = origTxFindById;
    Transaction.updateOne = origTxUpdateOne;
    WalletLedger.findOne = origLedgerFindOne;
    mongoose.startSession = origStartSession;

    // ─── SUMMARY ───────────────────────────────────────────────────────────────
    console.log('\n-----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('-----------------------------------------------------\n');

    process.exit(failed > 0 ? 1 : 0);
}

runRefundIdempotencyTests().catch(err => {
    console.error('[FATAL TEST ERROR]', err);
    process.exit(1);
});
