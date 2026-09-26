/**
 * HIGH 2 (Batch 2B): Multi-PIN failure → exact refund, once, idempotently.
 *
 * Follows the Batch 1 CRIT-4 harness (tests/refund_idempotency.test.js):
 *  - Transaction.findById().session / WalletLedger.findOne().session /
 *    Transaction.updateOne (atomic isLoss claim) / walletService.credit
 *
 * Scenario:
 *   unit customer price 1000, quantity 2
 *   authoritative debit = 2000 (transaction.amount)
 *   provider fails AFTER the committed debit
 *   → refund = 2000 (credited from transaction.amount)
 *   → net customer financial effect = 0
 *   → refund occurs exactly once; a retry refunds 0 additional.
 *
 * Run: node tests/pin_quantity_refund.test.js
 */
const assert = require('assert');
const mongoose = require('mongoose');

const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
const Expense = require('../models/Expense');
const WalletLedger = require('../models/WalletLedger');
const PricingRule = require('../models/PricingRule');

const purchaseService = require('../services/purchase.service');
const refundService = require('../services/refund.service');
const procurementService = require('../services/procurement.service');
const pinService = require('../services/pin.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');
const referral = require('../utils/referral');

const ORIG = {
    TxCreate: Transaction.create,
    TxFindById: Transaction.findById,
    TxUpdateOne: Transaction.updateOne,
    UserFindById: User.findById,
    WalletFindOne: Wallet.findOne,
    ServiceFindOne: Service.findOne,
    ServiceIdentityFindOne: ServiceIdentity.findOne,
    ExpenseCreate: Expense.create,
    LedgerFindOne: WalletLedger.findOne,
    PricingRuleFind: PricingRule.find,
    startSession: mongoose.startSession,
    verifyPin: pinService.verifyPin,
    walletDebit: walletService.debit,
    walletCredit: walletService.credit,
    procRefund: refundService.processRefund,
    selectBestOffer: procurementService.selectBestOffer,
    commission: referral.processLifetimeCommission,
};
const actualProcessRefund = refundService.processRefund.bind(refundService);
refundService.processRefund = (transactionId, reason, options = { mode: 'provider_failure' }) =>
    actualProcessRefund(transactionId, reason, options);

const OID = () => new mongoose.Types.ObjectId();

const MOCK_USER = {
    _id: OID(),
    name: 'Refund Test',
    email: 'ref@test.com',
    phone: '08012345678',
    role: 'user',
    accountType: 'retail',
    kycLevel: 2,
};

const PIN_SERVICE = {
    _id: OID(),
    name: 'WAEC Result Checker PIN',
    code: 'WAEC_REG_500',
    category: 'pin',
    price: 5000,
    provider: 'VTPass',
    suggestedRetailPrice: 1050,
};

const PIN_OFFER = {
    _id: OID(),
    serviceId: PIN_SERVICE._id,
    providerId: { _id: OID(), name: 'VTPass', adapterType: 'vtpass' },
    providerCode: 'waec',
    providerServiceCode: 'waec-registration',
    costPrice: 900,
};

const ACTIVE_RULE = {
    _id: OID(),
    markupType: 'percent',
    markupValue: 11.11111111111111,
    priority: 50,
    userRole: 'all',
    status: true,
};

// Originals for per-case override inside a test body
let TxCreate, TxFindById, TxUpdateOne, WalletFindOne, startSession, walletDebit, walletCredit, LedgerFindOne;
let mockTxs = [];
let walletDebits = [];
let walletCredits = [];
let ledgerEntries = [];

const reset = () => {
    mockTxs = [];
    walletDebits = [];
    walletCredits = [];
    ledgerEntries = [];
    startSession = async () => ({
        startTransaction: () => {},
        commitTransaction: async () => {},
        abortTransaction: async () => {},
        endSession: async () => {},
        inTransaction: () => true,
    });
    mongoose.startSession = startSession;
    TxCreate = (doc) => {
        const tx = { ...doc, _id: OID(), transactionId: 'TXN-PCR-1', status: 'pending', isLoss: false, save: async function () { return this; } };
        mockTxs.push(tx);
        return Promise.resolve(tx);
    };
    Transaction.create = TxCreate;
    TxFindById = (id) => {
        const load = async () => {
            const found = mockTxs.find(t => String(t._id) === String(id));
            if (!found) return null;
            found.save = async function () { return this; };
            return found;
        };
        return {
            session: load,
            then(resolve, reject) { return load().then(resolve, reject); },
        };
    };
    Transaction.findById = TxFindById;
    TxUpdateOne = (filter, update) => {
        const found = mockTxs.find(t => {
            if (filter._id && String(t._id) !== String(filter._id)) return false;
            if (filter.isLoss !== undefined && t.isLoss !== filter.isLoss) return false;
            return true;
        });
        if (!found) return Promise.resolve({ modifiedCount: 0 });
        if (update.$set) Object.assign(found, update.$set);
        return Promise.resolve({ modifiedCount: 1 });
    };
    Transaction.updateOne = TxUpdateOne;
    WalletFindOne = async () => ({ balance: 100000 });
    Wallet.findOne = WalletFindOne;
    LedgerFindOne = (filter) => ({
        session: async () => ledgerEntries.find(e => {
            if (filter.transactionId && String(e.transactionId) !== String(filter.transactionId)) return false;
            if (filter.entryType && e.entryType !== filter.entryType) return false;
            return true;
        }) || null,
    });
    WalletLedger.findOne = LedgerFindOne;
    walletDebit = async (userId, amount, ref) => {
        walletDebits.push({ userId, amount, ref });
        ledgerEntries.push({ transactionId: mockTxs.length ? mockTxs[mockTxs.length - 1]._id : OID(), entryType: 'debit', amount });
    };
    walletService.debit = walletDebit;
    walletCredit = async (userId, amount, ref) => { walletCredits.push({ userId, amount, ref }); };
    walletService.credit = walletCredit;
};

// Shared route stubs (modern engine path)
User.findById = () => ({
    select: () => MOCK_USER,
    then: (cb) => Promise.resolve(cb(MOCK_USER)),
});
Service.findOne = async () => PIN_SERVICE;
ServiceIdentity.findOne = async () => null;
Expense.create = async () => [];
PricingRule.find = () => ({
    sort: () => ({
        then: (cb) => Promise.resolve(cb([ACTIVE_RULE])),
        catch: () => Promise.resolve([ACTIVE_RULE]),
    }),
    then: (cb) => Promise.resolve(cb([ACTIVE_RULE])),
    catch: () => Promise.resolve([ACTIVE_RULE]),
});
pinService.verifyPin = async () => true;
procurementService.selectBestOffer = async () => PIN_OFFER;
referral.processLifetimeCommission = async () => 0;
notificationService.notifyPurchaseSuccess = async () => {};
notificationService.notifyPurchaseFailure = async () => {};

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  [PASS] ${name}`);
        passed++;
    } catch (err) {
        console.error(`  [FAIL] ${name}`);
        console.error(`         ${err.message}`);
        failed++;
    }
}

(async () => {
    console.log('====================================================');
    console.log('  HIGH 2: MULTI-PIN FAILURE -> EXACT REFUND (ONCE)');
    console.log('====================================================\n');

    await test('R1. qty=2 debit=2000; provider fails; refund=2000; net=0; replay refunds 0 extra', async () => {
        reset();

        // Provider fails for every call.
        const providerCall = async () => ({
            success: false,
            status: 'failed',
            outcome: 'definitive_failure',
            message: 'Provider explicitly rejected 2 pins',
        });

        const result = await purchaseService.processPurchase(MOCK_USER._id, {
            type: 'pin',
            serviceId: 'WAEC_REG_500',
            canonicalService: PIN_SERVICE,
            amount: 1000,
            pin: '1234',
            expectedPrice: 2000,
            details: { request_id: 'REF-R1', serviceID: 'waec-registration', variation_code: 'WAEC_REG_500', phone: '08012345678', quantity: 2 },
            providerCall,
        });

        // 1) Purchase reports failure after the failed provider call.
        assert.strictEqual(result.success, false, 'purchase must report failure');

        // 2) The committed debit was the full 2-card total.
        const debit = walletDebits[0];
        assert.ok(debit, 'debit must have been recorded');
        assert.strictEqual(debit.amount, 2000, 'debit must be the total 2 * 1000');

        // 3) The persisted transaction.amount is the authority the refund uses.
        const tx = mockTxs[0];
        assert.ok(tx, 'transaction must exist');
        assert.strictEqual(debit.ref, tx.refId, 'debit must use the generated internal reference');
        assert.strictEqual(tx.amount, 2000, 'transaction.amount must be 2000');

        // 4) Refund credits EXACTLY the debited total.
        assert.strictEqual(walletCredits.length, 1, 'exactly one refund credit');
        assert.strictEqual(walletCredits[0].amount, 2000, 'refund = debit = 2000');
        assert.strictEqual(walletCredits[0].ref, `REFUND_${tx.refId}`);

        // 5) Net customer financial effect is zero.
        assert.strictEqual(debit.amount - walletCredits[0].amount, 0, 'net = 0');

        // 6) The transaction is finalised as a loss after the refund.
        assert.strictEqual(tx.isLoss, true, 'translated to isLoss after refund');
        assert.strictEqual(tx.status, 'failed', 'transaction finalised as failed');
    });

    await test('R2. replay of the refund for the SAME failed purchase credits 0 additional', async () => {
        reset();

        const providerCall = async () => ({ success: false, status: 'failed', outcome: 'definitive_failure', message: 'Provider failed' });

        await purchaseService.processPurchase(MOCK_USER._id, {
            type: 'pin',
            serviceId: 'WAEC_REG_500',
            canonicalService: PIN_SERVICE,
            amount: 1000,
            pin: '1234',
            expectedPrice: 2000,
            details: { request_id: 'REF-R2', serviceID: 'waec-registration', variation_code: 'WAEC_REG_500', phone: '08012345678', quantity: 2 },
            providerCall,
        });

        assert.strictEqual(walletCredits.length, 1, 'first refund credited once');
        const firstAmount = walletCredits[0].amount;
        assert.strictEqual(firstAmount, 2000);

        // Replay the refund (as a monitor/cron would): the isLoss claim is now
        // taken, so processRefund must return alreadyRefunded with ZERO credit.
        const tx = mockTxs[0];
        const replayResult = await refundService.processRefund(tx._id, 'Retry');

        assert.strictEqual(walletCredits.length, 1, 'replay must NOT create a second credit');
        assert.strictEqual(replayResult.alreadyRefunded, true, 'replay reports alreadyRefunded');
        assert.strictEqual(replayResult.success, true);
    });

    await test('R3. concurrent replay through the atomic isLoss claim still credits once', async () => {
        reset();

        const providerCall = async () => ({ success: false, status: 'failed', outcome: 'definitive_failure', message: 'Provider failed' });

        await purchaseService.processPurchase(MOCK_USER._id, {
            type: 'pin',
            serviceId: 'WAEC_REG_500',
            canonicalService: PIN_SERVICE,
            amount: 1000,
            pin: '1234',
            expectedPrice: 2000,
            details: { request_id: 'REF-R3', serviceID: 'waec-registration', variation_code: 'WAEC_REG_500', phone: '08012345678', quantity: 2 },
            providerCall,
        });

        const tx = mockTxs[0];
        const [rA, rB] = await Promise.all([
            refundService.processRefund(tx._id, 'A'),
            refundService.processRefund(tx._id, 'B'),
        ]);

        const creditsForThisTx = walletCredits.filter(c => c.ref === `REFUND_${tx.refId}`).length;
        assert.ok(creditsForThisTx <= 1, `concurrent replays produced ${creditsForThisTx} credits (must be <= 1)`);
        assert.strictEqual(walletCredits.length, 1, 'exactly one credit in total');
    });

    await test('R4. refund amount NEVER exceeds the debited total (transaction.amount is authoritative)', async () => {
        reset();

        // Even if the provider response carries a smaller internal amount, the
        // refund is bound to the persisted transaction.amount.
        const providerCall = async () => ({ success: false, status: 'failed', outcome: 'definitive_failure', message: 'fail' });
        await purchaseService.processPurchase(MOCK_USER._id, {
            type: 'pin',
            serviceId: 'WAEC_REG_500',
            canonicalService: PIN_SERVICE,
            amount: 1000,
            pin: '1234',
            expectedPrice: 2000,
            details: { request_id: 'REF-R4', serviceID: 'waec-registration', variation_code: 'WAEC_REG_500', phone: '08012345678', quantity: 2 },
            providerCall,
        });

        const tx = mockTxs[0];
        assert.strictEqual(walletCredits.length, 1);
        assert.ok(walletCredits[0].amount <= tx.amount, 'refund <= transaction.amount');
        assert.strictEqual(walletCredits[0].amount, 2000);
    });

    // ── Restore ──────────────────────────────────────────────────────────
    Transaction.create = ORIG.TxCreate;
    Transaction.findById = ORIG.TxFindById;
    Transaction.updateOne = ORIG.TxUpdateOne;
    User.findById = ORIG.UserFindById;
    Wallet.findOne = ORIG.WalletFindOne;
    Service.findOne = ORIG.ServiceFindOne;
    ServiceIdentity.findOne = ORIG.ServiceIdentityFindOne;
    Expense.create = ORIG.ExpenseCreate;
    WalletLedger.findOne = ORIG.LedgerFindOne;
    PricingRule.find = ORIG.PricingRuleFind;
    mongoose.startSession = ORIG.startSession;
    pinService.verifyPin = ORIG.verifyPin;
    walletService.debit = ORIG.walletDebit;
    walletService.credit = ORIG.walletCredit;
    refundService.processRefund = ORIG.procRefund;
    procurementService.selectBestOffer = ORIG.selectBestOffer;
    referral.processLifetimeCommission = ORIG.commission;

    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
})();
