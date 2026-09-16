'use strict';

/**
 * CRIT 3 — ADMIN RECONCILIATION SETTLEMENT (write-path) regression.
 *
 * Guards paymentGatewayService.adminSettleProcessing() — the recovery path for
 * funding/investment payments stuck in 'processing' (the finalizeFundingCredit
 * crash window where the lock was claimed but the credit/finalize crashed).
 *
 * Guarantees under test:
 *   1. A stuck 'processing' funding is settled with exactly-once credit —
 *      if the credit ALREADY committed (crash between credit and finalize),
 *      the settle must NOT credit again.
 *   2. A stuck investment_buy binds quantity to the init-time sharePrice
 *      snapshot and can be settled.
 *   3. Non-whole-share amounts and non-'processing' statuses are rejected
 *      for manual review (never auto-settled).
 *
 * Runs without a live MongoDB connection (in-memory mocks).
 */

const assert = require('assert');
const mongoose = require('mongoose');

const TransactionStatus = require('../models/TransactionStatus');
const WalletLedger = require('../models/WalletLedger');

const paymentGatewayService = require('../services/paymentGateway.service');
const walletService = require('../services/wallet.service');
const investmentService = require('../services/investment.service');
const notificationService = require('../services/notification.service');

async function runAdminSettlementTests() {
    console.log('==========================================================');
    console.log(' CRIT 3 — ADMIN RECONCILIATION SETTLEMENT TEST SUITE      ');
    console.log('==========================================================\n');

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
    let mockRecords = [];
    let mockLedgerCredits = [];
    let walletCredits = [];
    let shareFulfillments = [];

    const origStartSession = mongoose.startSession;
    const origTxFindOne = TransactionStatus.findOne;
    const origTxUpdateOne = TransactionStatus.updateOne;
    const origLedgerFindOne = WalletLedger.findOne;
    const origWalletCredit = walletService.credit;
    const origFulfill = investmentService.fulfillSharePurchase;
    const origGetSettings = investmentService.getInvestmentSettings;
    const origNotif = notificationService.sendFundingSuccess;

    // Each call to adminSettleProcessing receives its OWN session identity so
    // staged credit writes can be rolled back when a session aborts — mirroring
    // the real MongoDB transaction durability that feeds the finalize guard.
    let sessionSeq = 0;

    const abortStagedWrites = (sessionId) => {
        walletCredits = walletCredits.filter(c => c._sessionId !== sessionId);
        mockLedgerCredits = mockLedgerCredits.filter(c => c._sessionId !== sessionId);
    };

    const makeFakeSession = () => {
        const sessionId = ++sessionSeq;
        return {
            _sessionId: sessionId,
            startTransaction: async () => {},
            commitTransaction: async () => {},
            abortTransaction: async () => abortStagedWrites(sessionId),
            endSession: async () => {}
        };
    };

    function resetMocks() {
        mockRecords = [];
        mockLedgerCredits = [];
        walletCredits = [];
        shareFulfillments = [];

        mongoose.startSession = async () => makeFakeSession();

        TransactionStatus.findOne = (filter) => ({
            session: async () => mockRecords.find(r => r.refId === filter.refId) || null
        });

        TransactionStatus.updateOne = (filter, update) => {
            const rec = mockRecords.find(r => {
                if (filter.refId && r.refId !== filter.refId) return false;
                if (filter.status && r.status !== filter.status) return false;
                return true;
            });
            if (!rec) return Promise.resolve({ modifiedCount: 0 });
            if (update.$set) Object.assign(rec, update.$set);
            return Promise.resolve({ modifiedCount: 1 });
        };

        WalletLedger.findOne = (filter) => ({
            session: async () => mockLedgerCredits.find(l =>
                (!filter.reference || l.reference === filter.reference) && l.entryType === filter.entryType
            ) || null
        });

        walletService.credit = async (userId, amount, reference, source, transactionId, session) => {
            walletCredits.push({ userId, amount, reference, source, transactionId, _sessionId: session && session._sessionId });
            mockLedgerCredits.push({ reference, entryType: 'credit', userId, _sessionId: session && session._sessionId });
            return { balance: 10000 + amount };
        };

        investmentService.fulfillSharePurchase = async (userId, qty, refId, isWalletPayment = false, externalSession = null, sharePriceOverride = null) => {
            if (shareFulfillments.some(f => f.refId === refId)) {
                return { success: true, message: 'Already processed' };
            }
            shareFulfillments.push({ userId, qty, refId, isWalletPayment, sharePriceOverride });
            return { success: true, qtyPurchased: qty, sharesOwned: qty };
        };

        investmentService.getInvestmentSettings = async () => ({
            investmentEnabled: true,
            sharePrice: 10000,
            maxSharesPerUser: 20,
            totalSharesAvailable: 200,
            minSharesPerPurchase: 1
        });

        notificationService.sendFundingSuccess = async () => ({});
    }

    resetMocks();

    const record = (overrides) => ({
        refId: 'REF-SETTLE',
        userId: 'user-settle',
        type: 'funding',
        status: 'processing',
        confirmedAmountKobo: 50000,
        amountKobo: 50000,
        channels: ['bank_transfer'],
        provider: 'paystack',
        ...overrides
    });

    // ─── SECTION A: FUNDING SETTLEMENT ────────────────────────────────────────

    await test('A1. Stuck processing funding is settled with one credit', async () => {
        resetMocks();
        const rec = record({ refId: 'REF-A1' });
        mockRecords.push(rec);

        const result = await paymentGatewayService.adminSettleProcessing({ refId: 'REF-A1', adminId: 'admin-1' });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.settled, true);
        assert.strictEqual(result.credited, true, 'no prior credit — must credit');
        assert.strictEqual(walletCredits.length, 1);
        assert.strictEqual(walletCredits[0].amount, 500);
        assert.strictEqual(rec.status, 'success');
        assert.ok(rec.reconciliationReason.includes('Admin settlement'), 'settlement must be audited on the record');
    });

    await test('A2. Prior credit already committed (crash between credit & finalize) — no double-credit', async () => {
        resetMocks();
        const rec = record({ refId: 'REF-A2' });
        mockRecords.push(rec);
        // The crashed run already committed the wallet credit ledger row.
        mockLedgerCredits.push({ reference: 'REF-A2', entryType: 'credit', userId: 'user-settle' });

        const result = await paymentGatewayService.adminSettleProcessing({ refId: 'REF-A2', adminId: 'admin-2' });

        assert.strictEqual(result.settled, true);
        assert.strictEqual(result.credited, false, 'must NOT credit again when the ledger already shows the credit');
        assert.strictEqual(walletCredits.length, 0, 'double-credit must be impossible');
        assert.strictEqual(rec.status, 'success', 'finalize the already-credited payment to success');
    });

    // ─── SECTION B: STATUS ELIGIBILITY ────────────────────────────────────────

    await test('B1. Only processing records are eligible for settlement', async () => {
        for (const status of ['pending', 'success', 'failed', 'reconciliation_required']) {
            resetMocks();
            mockRecords.push(record({ refId: `REF-ST-${status}`, status }));

            let threw = false;
            try {
                await paymentGatewayService.adminSettleProcessing({ refId: `REF-ST-${status}`, adminId: 'admin-x' });
            } catch (err) {
                threw = true;
                assert.ok(err.message.includes('processing'), `must reject status '${status}'`);
            }
            assert.ok(threw, `must reject non-processing status '${status}'`);
        }
    });

    await test('B2. Unknown reference is rejected', async () => {
        resetMocks();
        let threw = false;
        try {
            await paymentGatewayService.adminSettleProcessing({ refId: 'NO-SUCH-REF', adminId: 'admin-x' });
        } catch (err) {
            threw = true;
            assert.ok(err.message.includes('not found'));
        }
        assert.ok(threw, 'must throw for an unknown reference');
    });

    await test('B3. Missing confirmed amount is rejected', async () => {
        resetMocks();
        mockRecords.push(record({ refId: 'REF-A3', confirmedAmountKobo: undefined, amountKobo: undefined }));

        let threw = false;
        try {
            await paymentGatewayService.adminSettleProcessing({ refId: 'REF-A3', adminId: 'admin-x' });
        } catch (err) {
            threw = true;
        }
        assert.ok(threw, 'must reject settlement without an amount');
    });

    await test('B4. Missing reference is rejected', async () => {
        resetMocks();
        let threw = false;
        try {
            await paymentGatewayService.adminSettleProcessing({});
        } catch (err) {
            threw = true;
        }
        assert.ok(threw, 'must require a reference');
    });

    // ─── SECTION C: INVESTMENT_BUY SETTLEMENT ─────────────────────────────────

    await test('C1. Stuck investment_buy settles to success with snapshot-bound qty', async () => {
        resetMocks();
        const rec = record({
            refId: 'REF-INV1',
            type: 'investment_buy',
            confirmedAmountKobo: 1600000, // 16000 NGN
            amountKobo: 1600000,
            sharePrice: 8000 // bound at init
        });
        mockRecords.push(rec);

        const result = await paymentGatewayService.adminSettleProcessing({ refId: 'REF-INV1', adminId: 'admin-1' });

        assert.strictEqual(result.settled, true);
        assert.strictEqual(result.credited, true);
        assert.strictEqual(shareFulfillments.length, 1);
        assert.strictEqual(shareFulfillments[0].qty, 2, 'qty must bind to the init snapshot (16000/8000 = 2)');
        assert.strictEqual(shareFulfillments[0].sharePriceOverride, 8000, 'fulfillment must record the snapshot price');
        assert.strictEqual(rec.status, 'success');
    });

    await test('C2. investment_buy already fulfilled is not re-fulfilled', async () => {
        resetMocks();
        const rec = record({
            refId: 'REF-INV2',
            type: 'investment_buy',
            confirmedAmountKobo: 1600000,
            amountKobo: 1600000,
            sharePrice: 8000
        });
        mockRecords.push(rec);
        shareFulfillments.push({ userId: 'user-settle', qty: 2, refId: 'REF-INV2' }); // prior fulfilled

        const result = await paymentGatewayService.adminSettleProcessing({ refId: 'REF-INV2', adminId: 'admin-2' });

        assert.strictEqual(result.settled, true);
        assert.strictEqual(result.credited, false, 'already fulfilled — must not run again');
        assert.strictEqual(shareFulfillments.length, 1, 'no second fulfillment');
        assert.strictEqual(rec.status, 'success');
    });

    await test('C3. Non-whole-share amount rejects settlement (manual review required)', async () => {
        resetMocks();
        mockRecords.push(record({
            refId: 'REF-INV3',
            type: 'investment_buy',
            confirmedAmountKobo: 1500000, // 15000 NGN @ 8000 = 1.875 shares
            amountKobo: 1500000,
            sharePrice: 8000
        }));

        let threw = false;
        try {
            await paymentGatewayService.adminSettleProcessing({ refId: 'REF-INV3', adminId: 'admin-3' });
        } catch (err) {
            threw = true;
            assert.ok(err.message.includes('not a whole multiple'), 'must reject a non-whole-share amount');
        }
        assert.ok(threw, 'must reject a non-whole-share amount');
        assert.strictEqual(shareFulfillments.length, 0, 'no partial fulfillment');
    });

    // ─── SECTION D: CONCURRENCY — DOUBLE-CREDIT GUARD ─────────────────────────

    await test('D1. Two concurrent settlements for the same processing funding credit exactly once', async () => {
        resetMocks();
        const rec = record({ refId: 'REF-D1' });
        mockRecords.push(rec);

        // Both settlers observe 'processing' AND find no prior credit (naive-
        // read race). The shared finalize guard must let EXACTLY ONE commit.
        const [r1, r2] = await Promise.all([
            paymentGatewayService.adminSettleProcessing({ refId: 'REF-D1', adminId: 'admin-a' }),
            paymentGatewayService.adminSettleProcessing({ refId: 'REF-D1', adminId: 'admin-b' })
        ]);

        assert.strictEqual(walletCredits.length, 1, 'exactly one credit despite a concurrent double-settle');
        assert.ok(r1.settled !== r2.settled, 'exactly one runner reported settled');
        assert.strictEqual(rec.status, 'success');
        const winner = r1.settled ? r1 : r2;
        const loser = r1.settled ? r2 : r1;
        assert.strictEqual(winner.credited, true);
        assert.strictEqual(loser.credited, false, 'loser must not report a credit');
        assert.strictEqual(loser.alreadyProcessed, true, 'loser must report that the settlement was already claimed');
    });

    // ─── RESTORE ───────────────────────────────────────────────────────────────
    mongoose.startSession = origStartSession;
    TransactionStatus.findOne = origTxFindOne;
    TransactionStatus.updateOne = origTxUpdateOne;
    WalletLedger.findOne = origLedgerFindOne;
    walletService.credit = origWalletCredit;
    investmentService.fulfillSharePurchase = origFulfill;
    investmentService.getInvestmentSettings = origGetSettings;
    notificationService.sendFundingSuccess = origNotif;

    // ─── SUMMARY ───────────────────────────────────────────────────────────────
    console.log('\n-----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('-----------------------------------------------------\n');

    process.exit(failed > 0 ? 1 : 0);
}

runAdminSettlementTests().catch(err => {
    console.error('[FATAL TEST ERROR]', err);
    process.exit(1);
});