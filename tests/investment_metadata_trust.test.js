'use strict';

/**
 * CRIT 3 — Investment Fulfillment Metadata Trust Tests
 *
 * Guards the _finalizeAfterClaim() investment path: the quantity of shares
 * fulfilled for a gateway payment MUST be derived from the bank-verified
 * amount (confirmedKobo) at the SERVER-side share price — never from
 * client-supplied gateway payment metadata (metadata.qty).
 *
 * Attacker model: a payer funds 'investment_buy' for the exact amount of N
 * shares but injects an inflated metadata.qty into the transfer narration,
 * receiving far more shares than paid for.
 *
 * Runs without a live MongoDB connection (in-memory mocks).
 */

const assert = require('assert');

const Transaction = require('../models/Transaction');
const TransactionStatus = require('../models/TransactionStatus');

const paymentGatewayService = require('../services/paymentGateway.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');
const investmentService = require('../services/investment.service');

async function runInvestmentMetadataTrustTests() {
    console.log('==========================================================');
    console.log(' CRIT 3 — INVESTMENT FULFILLMENT METADATA-TRUST TEST SUITE ');
    console.log('==========================================================\n');

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
    let shareFulfillments = [];
    let walletCredits = [];
    let transactionLogs = [];

    // Save originals for restoration
    const origGetInvestmentSettings = investmentService.getInvestmentSettings;
    const origFulfillSharePurchase = investmentService.fulfillSharePurchase;
    const origWalletCredit = walletService.credit;
    const origNotifFundingSuccess = notificationService.sendFundingSuccess;
    const origTxCreate = Transaction.create;
    const origTxUpdateOne = TransactionStatus.updateOne;

    // ─── MOCK SETUP ────────────────────────────────────────────────────────────
    function resetMocks() {
        shareFulfillments = [];
        walletCredits = [];
        transactionLogs = [];

        // Server-side authoritative settings (defaults). Share price pinned in
        // this harness so "derived quantity" assertions reference a fixed price.
        investmentService.getInvestmentSettings = async () => ({
            investmentEnabled: true,
            sharePrice: 10000,
            maxSharesPerUser: 20,
            totalSharesAvailable: 200,
            minSharesPerPurchase: 1
        });

        // Spy — captures the qty the service decides to fulfill.
        investmentService.fulfillSharePurchase = async (userId, qty, refId, isWalletPayment = false) => {
            shareFulfillments.push({ userId, qty, refId, isWalletPayment });
            return { success: true, qtyPurchased: qty, sharesOwned: qty };
        };

        walletService.credit = async (userId, amount, reference) => {
            walletCredits.push({ userId, amount, reference });
            return { success: true };
        };

        notificationService.sendFundingSuccess = async () => ({});

        // logTransaction swallows its own errors; keep it no-op clean anyway.
        Transaction.create = async (doc) => {
            transactionLogs.push(doc);
            return { _id: 'mock-tx-id' };
        };

        // Finalization transition pending/processing → success is a no-op mock.
        TransactionStatus.updateOne = async () => ({ modifiedCount: 1 });
    }

    // Builds the exact shape of data the fix must not trust / must derive from.
    function makeArgs({ type = 'investment_buy', amountNaira = 10000, qtyMeta = 999, amountKobo = null }) {
        const confirmedKobo = amountKobo != null ? amountKobo : Math.round(amountNaira * 100);
        const transactionStatus = {
            userId: 'user-1',
            type,
            amountKobo: confirmedKobo,
            channels: ['paystack'],
            service: 'Paystack'
        };
        const gatewayPaymentResult = {
            amount: amountNaira,
            currency: 'NGN',
            reference: `REF-${Math.random().toString(36).slice(2, 10)}`,
            metadata: { qty: qtyMeta, type },
            raw: { source: 'test' }
        };
        return {
            transactionStatus,
            gatewayPaymentResult,
            refId: gatewayPaymentResult.reference,
            confirmedKobo,
            confirmedCurrency: 'NGN',
            source: 'webhook'
        };
    }

    try {
        // Case 1 — Client-fabricated metadata.qty must NEVER drive share count.
        // Payment covers exactly 1 share (₦10,000 → 10,000 kobo → 1,000,000 kobo).
        // Attacker injects metadata.qty = 999. Derived qty MUST be 1.
        await test('metadata.qty is ignored; quantity derived from confirmed amount (1 share)', async () => {
            resetMocks();
            const args = makeArgs({ amountNaira: 10000, qtyMeta: 999 });

            const result = await paymentGatewayService._finalizeAfterClaim(args);

            assert.strictEqual(result.success, true, 'finalization should succeed');
            assert.strictEqual(shareFulfillments.length, 1, 'share purchase must be fulfilled');
            assert.strictEqual(
                shareFulfillments[0].qty,
                1,
                `share qty must be derived from confirmed amount (1), got ${shareFulfillments[0].qty} (metadata.qty was 999)`
            );
        });

        // Case 2 — Same guarantee without metadata present at all.
        // Payment covers exactly 2 shares (₦20,000). Derived qty MUST be 2.
        await test('quantity derived from confirmed amount with metadata absent (2 shares)', async () => {
            resetMocks();
            const args = makeArgs({ amountNaira: 20000, qtyMeta: 1 });

            const result = await paymentGatewayService._finalizeAfterClaim(args);

            assert.strictEqual(result.success, true, 'finalization should succeed');
            assert.strictEqual(shareFulfillments.length, 1, 'share purchase must be fulfilled');
            assert.strictEqual(
                shareFulfillments[0].qty,
                2,
                `share qty must be derived from confirmed amount (2), got ${shareFulfillments[0].qty}`
            );
        });

        // Case 3 — Amount not a whole multiple of share price MUST be rejected.
        // ₦15,000 at ₦10,000/share is 1.5 shares → invalid; no fulfillment, no success.
        await test('non-whole-share confirmed amount is rejected', async () => {
            resetMocks();
            const args = makeArgs({ amountNaira: 15000, qtyMeta: 2 });

            await assert.rejects(
                () => paymentGatewayService._finalizeAfterClaim(args),
                /not a whole multiple|do not reconcile|Invalid quantity|Invalid share price/,
                'non-whole-share confirmation must reject fulfillment'
            );
            assert.strictEqual(shareFulfillments.length, 0, 'no shares may be fulfilled for 1.5 shares');
        });

        // Case 4 — Regression: non-investment funding still credits the wallet,
        // and never touches the share fulfillment path.
        await test('non-investment funding uses wallet credit (regression)', async () => {
            resetMocks();
            const args = makeArgs({ type: 'funding', amountNaira: 25000, qtyMeta: 1 });

            const result = await paymentGatewayService._finalizeAfterClaim(args);

            assert.strictEqual(result.success, true, 'finalization should succeed');
            assert.strictEqual(walletCredits.length, 1, 'wallet credit must happen once');
            assert.strictEqual(walletCredits[0].amount, 25000, 'credit amount must be ₦25,000 (2,500,000 kobo)');
            assert.strictEqual(shareFulfillments.length, 0, 'investment fulfillment must NOT run');
        });

        // Case 5 — TOCTOU: the init-time sharePrice SNAPSHOT is authoritative.
        // Settings have since moved to ₦10,000 (per this harness), but the
        // payment was initialized when the price was ₦8,000 and paid ₦16,000.
        // The quantity MUST bind to the snapshot (2 shares), never the new price
        // (which would reject the payment as 1.6 shares).
        await test('init-time sharePrice snapshot is authoritative at fulfillment (TOCTOU closed)', async () => {
            resetMocks();
            const args = makeArgs({ amountNaira: 16000, qtyMeta: 1 });
            args.transactionStatus.sharePrice = 8000; // snapshotted at init

            const result = await paymentGatewayService._finalizeAfterClaim(args);

            assert.strictEqual(result.success, true, 'finalization must succeed (bound to snapshot)');
            assert.strictEqual(shareFulfillments.length, 1, 'share purchase must be fulfilled');
            assert.strictEqual(
                shareFulfillments[0].qty,
                2,
                `qty must bind to the init snapshot (16000/8000 = 2), got ${shareFulfillments[0].qty} — a fresh re-read at 10000 would reject this payment`
            );
        });
    } finally {
        // ─── RESTORE ───────────────────────────────────────────────────────────
        investmentService.getInvestmentSettings = origGetInvestmentSettings;
        investmentService.fulfillSharePurchase = origFulfillSharePurchase;
        walletService.credit = origWalletCredit;
        notificationService.sendFundingSuccess = origNotifFundingSuccess;
        Transaction.create = origTxCreate;
        TransactionStatus.updateOne = origTxUpdateOne;
    }

    // ─── SUMMARY ───────────────────────────────────────────────────────────────
    console.log('\n-----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('-----------------------------------------------------\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runInvestmentMetadataTrustTests().catch(err => {
    console.error('[FATAL TEST ERROR]', err);
    process.exit(1);
});