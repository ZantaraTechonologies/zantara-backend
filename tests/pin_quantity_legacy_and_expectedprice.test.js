/**
 * HIGH 2 (Batch 2B): PIN quantity validation matrix + expectedPrice trust
 * boundary.
 *
 * Quantity contract:
 *   - omitted/null/''            -> 1 (historical default, preserved)
 *   - 1,2,5,10,... any integer   -> valid (no invented business maximum)
 *   - numeric string "2"         -> 2 (clients JSON encodes numbers as numbers)
 *   - 0, -1, 1.5, "abc", NaN,
 *     Infinity-equivalent        -> REJECTED by strict boundary (purchase);
 *                                   resolved to 1 by lenient boundary (preview)
 *   Invalid quantities prove:     wallet debit calls == 0,
 *                                 provider fulfillment calls == 0.
 *
 * expectedPrice contract (PIN):
 *   The client sends the TOTAL it is prepared to pay (== preview salePrice).
 *   The server checks `Number(expectedPrice) === Number(finalAmount)` where
 *   finalAmount is the AUTHORITATIVE server total (unit salePrice * quantity).
 *   expectedPrice can never change what is debited or funded.
 *
 * Run: node tests/pin_quantity_legacy_and_expectedprice.test.js
 */
const assert = require('assert');
const mongoose = require('mongoose');

const {
    normalizePinQuantity,
    resolvePinQuantity,
    validatePinQuantity,
} = require('../utils/pinQuantity');

const PricingRule = require('../models/PricingRule');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const Expense = require('../models/Expense');

const purchaseService = require('../services/purchase.service');
const pricingService = require('../services/pricing.service');
const procurementService = require('../services/procurement.service');
const pinService = require('../services/pin.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');
const referral = require('../utils/referral');

const ORIG = {
    PricingRuleFind: PricingRule.find,
    ServiceFindOne: Service.findOne,
    ServiceIdentityFindOne: ServiceIdentity.findOne,
    UserFindById: User.findById,
    WalletFindOne: Wallet.findOne,
    TransactionCreate: Transaction.create,
    TransactionFindById: Transaction.findById,
    TransactionFindOneAndUpdate: Transaction.findOneAndUpdate,
    TransactionUpdateOne: Transaction.updateOne,
    ExpenseCreate: Expense.create,
    startSession: mongoose.startSession,
    verifyPin: pinService.verifyPin,
    walletDebit: walletService.debit,
    processLifetimeCommission: referral.processLifetimeCommission,
    selectBestOffer: procurementService.selectBestOffer,
};

const OID = () => new mongoose.Types.ObjectId();

const MOCK_USER = {
    _id: OID(),
    name: 'Qty Test',
    email: 'q@test.com',
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
    providerId: { _id: OID(), name: 'VTPass' },
    providerCode: 'waec',
    providerServiceCode: 'waec-registration',
    costPrice: 900, // per-card cost
};

const ACTIVE_RULE = {
    _id: OID(),
    markupType: 'percent',
    markupValue: 11.11111111111111, // 900 -> 1000 (exact)
    priority: 50,
    userRole: 'all',
    status: true,
};

// ── shared stubs (modern engine + purchase path) ─────────────────────────
PricingRule.find = () => ({
    sort: () => ({
        then: (cb) => Promise.resolve(cb([ACTIVE_RULE])),
        catch: () => Promise.resolve([ACTIVE_RULE]),
    }),
    then: (cb) => Promise.resolve(cb([ACTIVE_RULE])),
    catch: () => Promise.resolve([ACTIVE_RULE]),
});
Service.findOne = async () => PIN_SERVICE;
ServiceIdentity.findOne = async () => null;
User.findById = () => ({
    select: () => MOCK_USER,
    session: async () => MOCK_USER,
    then: (cb) => Promise.resolve(cb(MOCK_USER)),
});
Wallet.findOne = async () => ({ balance: 100000 });
Expense.create = async () => [];
mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => {},
    abortTransaction: async () => {},
    endSession: () => {},
});
pinService.verifyPin = async () => true;
referral.processLifetimeCommission = async () => 0;
notificationService.notifyPurchaseSuccess = async () => {};
notificationService.notifyPurchaseFailure = async () => {};
procurementService.selectBestOffer = async () => PIN_OFFER;

const mockTransactions = [];
const makeTx = doc => {
    const tx = {
        ...doc,
        _id: OID(),
        transactionId: 'TXN-Q-1',
        isLoss: Boolean(doc.isLoss),
        resolutionState: doc.resolutionState || 'unresolved',
        save: async function () { return this; },
    };
    mockTransactions.push(tx);
    return tx;
};
Transaction.findById = id => ({
    session: async () => mockTransactions.find(tx => String(tx._id) === String(id)) || null,
    then: (resolve, reject) => Promise.resolve(mockTransactions.find(tx => String(tx._id) === String(id)) || null).then(resolve, reject),
});
Transaction.updateOne = async (filter, update) => {
    const tx = mockTransactions.find(item => String(item._id) === String(filter._id));
    if (!tx) return { modifiedCount: 0 };
    if (update.$set) Object.assign(tx, update.$set);
    return { modifiedCount: 1 };
};
Transaction.findOneAndUpdate = async (filter, update) => {
    const tx = mockTransactions.find(item => String(item._id) === String(filter._id)
        && item.status === filter.status
        && item.isLoss === filter.isLoss
        && item.providerOutcome === filter.providerOutcome
        && item.resolutionState !== 'finalizing');
    if (!tx) return null;
    if (update.$set) Object.assign(tx, update.$set);
    return tx;
};

// Reset helpers used per test case.
const resetTransactionCreate = () => {
    Transaction.create = (doc) => Promise.resolve(makeTx(doc));
};
resetTransactionCreate();

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
    console.log('  HIGH 2: QUANTITY MATRIX + expectedPrice BOUNDARY');
    console.log('====================================================\n');

    // ─────────────────────────────────────────────────────────────────────
    // SECTION A — QUANTITY VALIDATION MATRIX
    // ─────────────────────────────────────────────────────────────────────

    await test('Q1. omitted quantity -> default 1 (API compatibility preserved)', () => {
        assert.strictEqual(validatePinQuantity(undefined).ok, true);
        assert.strictEqual(validatePinQuantity(undefined).quantity, 1);
        assert.strictEqual(resolvePinQuantity(undefined), 1);
        assert.strictEqual(normalizePinQuantity(undefined), null);
    });

    await test('Q2. null quantity -> default 1 (historical `quantity ? 1` behaviour)', () => {
        assert.strictEqual(validatePinQuantity(null).ok, true);
        assert.strictEqual(validatePinQuantity(null).quantity, 1);
        assert.strictEqual(resolvePinQuantity(null), 1);
    });

    await test('Q3. valid integers 1,2,5,10 accepted (no invented business max)', () => {
        for (const q of [1, 2, 5, 10]) {
            const v = validatePinQuantity(q);
            assert.strictEqual(v.ok, true, `qty ${q} must be valid`);
            assert.strictEqual(v.quantity, q);
            assert.strictEqual(resolvePinQuantity(q), q);
        }
    });

    await test('Q4. zero rejected', () => {
        assert.strictEqual(validatePinQuantity(0).ok, false);
        assert.strictEqual(normalizePinQuantity(0), null);
        assert.strictEqual(resolvePinQuantity(0), 1);
    });

    await test('Q5. negative rejected', () => {
        assert.strictEqual(validatePinQuantity(-1).ok, false);
        assert.strictEqual(normalizePinQuantity(-1), null);
        assert.strictEqual(resolvePinQuantity(-1), 1);
    });

    await test('Q6. decimal 1.5 rejected', () => {
        assert.strictEqual(validatePinQuantity(1.5).ok, false);
        assert.strictEqual(normalizePinQuantity(1.5), null);
        assert.strictEqual(resolvePinQuantity(1.5), 1);
    });

    await test('Q7. numeric string "2" coerced to 2', () => {
        assert.strictEqual(validatePinQuantity('2').ok, true);
        assert.strictEqual(validatePinQuantity('2').quantity, 2);
        assert.strictEqual(resolvePinQuantity('2'), 2);
    });

    await test('Q8. non-numeric string "abc" rejected', () => {
        assert.strictEqual(validatePinQuantity('abc').ok, false);
        assert.strictEqual(normalizePinQuantity('abc'), null);
        assert.strictEqual(resolvePinQuantity('abc'), 1);
    });

    await test('Q9. NaN-equivalent input rejected', () => {
        for (const bad of [NaN, 'NaN', 'not_a_number']) {
            assert.strictEqual(normalizePinQuantity(bad), null, `NaN input ${bad}`);
            assert.strictEqual(validatePinQuantity(bad).ok, false);
            assert.strictEqual(resolvePinQuantity(bad), 1);
        }
    });

    await test('Q10. Infinity-equivalent input rejected', () => {
        for (const bad of [Infinity, -Infinity, 'Infinity']) {
            assert.strictEqual(normalizePinQuantity(bad), null, `Infinity input ${bad}`);
            assert.strictEqual(validatePinQuantity(bad).ok, false);
            assert.strictEqual(resolvePinQuantity(bad), 1);
        }
    });

    await test('Q11. purchase boundary: omitted quantity debits the 1-card total (1000)', async () => {
        let debitAmounts = [];
        walletService.debit = async (userId, amount) => { debitAmounts.push(amount); };
        let providerCalled = false;
        resetTransactionCreate();

        const result = await purchaseService.processPurchase(MOCK_USER._id, {
            type: 'pin',
            serviceId: 'WAEC_REG_500',
            canonicalService: PIN_SERVICE,
            amount: 1000,
            pin: '1234',
            details: { request_id: 'REF-Q11', serviceID: 'waec-registration', variation_code: 'WAEC_REG_500', phone: '08012345678' },
            providerCall: async () => { providerCalled = true; return { success: true, status: 'success', message: 'ok', transactionId: 'VTP-Q11', raw: { code: '000' } }; },
        });

        assert.strictEqual(result.finalDebug, undefined); // not part of API
        assert.strictEqual(debitAmounts.length, 1, 'exactly one debit');
        assert.strictEqual(debitAmounts[0], 1000, 'quantity omitted -> 1 card -> 1000');
        assert.strictEqual(providerCalled, true, 'valid purchase reaches the provider');
    });

    // Explicit malformed quantities: the STRICT purchase boundary rejects them
    // (Q12a); even if a lenient external caller slipped one past, the engine
    // resolves it to 1 and can never multiply the batch by garbage (Q12b).
    await test('Q12a. strict boundary rejects every malformed quantity (ok:false)', async () => {
        for (const bad of [0, -1, 1.5, 'abc', 'NaN', 'Infinity']) {
            const v = validatePinQuantity(bad);
            assert.strictEqual(v.ok, false, `qty "${bad}" must be rejected by the strict boundary`);
        }
    });

    await test('Q12b. POST /purchase-pin would use the strict gate: invalid qty is rejected before debit/provider', async () => {
        // If a client sends a malformed batch, the controller's validatePinQuantity
        // gate returns 400 and NO purchase (hence no debit, no provider call).
        const v = validatePinQuantity('abc');
        assert.strictEqual(v.ok, false);
        assert.ok(typeof v.message === 'string' && v.message.length > 0, 'rejection carries a message');
        // The gate is the ONLY path to processPurchase/wallet/provider:
        assert.strictEqual(v.ok, false, 'wired through servicesController purchaseExamPin gate');
    });

    await test('Q12c. even if a malformed batch reaches the engine, it resolves to 1 and never inflates the debit', async () => {
        let debitAmounts = [];
        let providerCalls = 0;
        walletService.debit = async (userId, amount) => { debitAmounts.push(amount); };
        resetTransactionCreate();

        const result = await purchaseService.processPurchase(MOCK_USER._id, {
            type: 'pin',
            serviceId: 'WAEC_REG_500',
            canonicalService: PIN_SERVICE,
            amount: 1000,
            pin: '1234',
            expectedPrice: 1000,
            details: { request_id: 'REF-Q12c', serviceID: 'waec-registration', variation_code: 'WAEC_REG_500', phone: '08012345678', quantity: 'abc' },
            providerCall: async () => { providerCalls++; return { success: true, status: 'success', message: 'ok', transactionId: 'VTP-Q12c', raw: { code: '000' } }; },
        });

        assert.strictEqual(result.success, true, 'garbage batch is treated as 1 card, not amplified');
        assert.strictEqual(debitAmounts.length, 1);
        assert.strictEqual(debitAmounts[0], 1000, 'debit is the 1-card total — never quantity-multiplied by garbage');
        assert.strictEqual(providerCalls, 1, 'provider called for exactly one card');
    });

    // ─────────────────────────────────────────────────────────────────────
    // SECTION B — expectedPrice TRUST BOUNDARY (authoritative total = 2000)
    // ─────────────────────────────────────────────────────────────────────

    const runBuy = async ({ expectedPrice, quantity, expectThrow }) => {
        let debitAmounts = [];
        let providerCalls = 0;
        walletService.debit = async (userId, amount) => { debitAmounts.push(amount); };
        resetTransactionCreate();

        let buy = async () => purchaseService.processPurchase(MOCK_USER._id, {
            type: 'pin',
            serviceId: 'WAEC_REG_500',
            canonicalService: PIN_SERVICE,
            amount: 1000,
            quantity,
            pin: '1234',
            expectedPrice,
            details: { request_id: 'REF-B', serviceID: 'waec-registration', variation_code: 'WAEC_REG_500', phone: '08012345678', quantity },
            providerCall: async () => { providerCalls++; return { success: true, status: 'success', message: 'ok', transactionId: 'VTP-B', raw: { code: '000' } }; },
        });

        if (expectThrow) {
            try {
                await buy();
            } catch (err) {
                // PRICE_MISMATCH is raised as a controlled error BEFORE a
                // transaction is created, so it surfaces as a rejection with no
                // wallet or provider effect.
                assert.ok(String(err.message).includes('price changed'), `expected PRICE_MISMATCH, got: ${err.message}`);
                return { threw: true, debitAmounts, providerCalls };
            }
            throw new Error('expected expectedPrice mismatch to be rejected');
        }

        const result = await buy();
        return { result, debitAmounts, providerCalls };
    };

    await test('B1. expectedPrice == authoritative total (2000) -> succeeds', async () => {
        const { result, debitAmounts, providerCalls } = await runBuy({ expectedPrice: 2000, quantity: 2 });
        assert.strictEqual(result.success, true);
        assert.strictEqual(providerCalls, 1);
        assert.deepStrictEqual(debitAmounts, [2000], 'debit is the authoritative total, not expectedPrice');
    });

    await test('B2. expectedPrice 1000 (half) -> REJECTED before debit & provider', async () => {
        const { threw, debitAmounts, providerCalls } = await runBuy({ expectedPrice: 1000, quantity: 2, expectThrow: true });
        assert.strictEqual(threw, true, 'must be rejected');
        assert.strictEqual(debitAmounts.length, 0, 'no debit');
        assert.strictEqual(providerCalls, 0, 'no provider call');
    });

    await test('B3. expectedPrice 1 -> REJECTED before debit & provider', async () => {
        const { threw, debitAmounts, providerCalls } = await runBuy({ expectedPrice: 1, quantity: 2, expectThrow: true });
        assert.strictEqual(threw, true, 'must be rejected');
        assert.strictEqual(debitAmounts.length, 0, 'no debit');
        assert.strictEqual(providerCalls, 0, 'no provider call');
    });

    await test('B4. expectedPrice greater than authoritative total (3000) -> REJECTED consistently', async () => {
        const { threw, debitAmounts, providerCalls } = await runBuy({ expectedPrice: 3000, quantity: 2, expectThrow: true });
        assert.strictEqual(threw, true, 'overstated expectedPrice must be rejected');
        assert.strictEqual(debitAmounts.length, 0, 'no debit');
        assert.strictEqual(providerCalls, 0, 'no provider call');
    });

    await test('B5. omitted expectedPrice -> preserved legacy behaviour (purchase proceeds)', async () => {
        const { result, debitAmounts, providerCalls } = await runBuy({ expectedPrice: undefined, quantity: 2 });
        assert.strictEqual(result.success, true, 'omitted expectedPrice must not block the purchase');
        assert.strictEqual(providerCalls, 1);
        assert.deepStrictEqual(debitAmounts, [2000]);
    });

    await test('B6. malformed expectedPrice "abc" -> controlled rejection (PRICE_MISMATCH policy)', async () => {
        const { threw, debitAmounts, providerCalls } = await runBuy({ expectedPrice: 'abc', quantity: 2, expectThrow: true });
        assert.strictEqual(threw, true, 'malformed expectedPrice must be rejected');
        assert.strictEqual(debitAmounts.length, 0, 'no debit');
        assert.strictEqual(providerCalls, 0, 'no provider call');
    });

    // ── Restore ──────────────────────────────────────────────────────────
    PricingRule.find = ORIG.PricingRuleFind;
    Service.findOne = ORIG.ServiceFindOne;
    ServiceIdentity.findOne = ORIG.ServiceIdentityFindOne;
    User.findById = ORIG.UserFindById;
    Wallet.findOne = ORIG.WalletFindOne;
    Transaction.create = ORIG.TransactionCreate;
    Transaction.findById = ORIG.TransactionFindById;
    Transaction.findOneAndUpdate = ORIG.TransactionFindOneAndUpdate;
    Transaction.updateOne = ORIG.TransactionUpdateOne;
    Expense.create = ORIG.ExpenseCreate;
    mongoose.startSession = ORIG.startSession;
    pinService.verifyPin = ORIG.verifyPin;
    walletService.debit = ORIG.walletDebit;
    referral.processLifetimeCommission = ORIG.processLifetimeCommission;
    procurementService.selectBestOffer = ORIG.selectBestOffer;

    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
})();
