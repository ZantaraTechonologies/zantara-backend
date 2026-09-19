/**
 * HIGH 2 (Batch 2B): Multi-PIN quantity / pricing integrity.
 *
 * A PIN service (category === 'pin') is a FIXED-COST unit: providerOffer.costPrice
 * is the cost of ONE card and clients communicate a UNIT amount + a quantity.
 * The pricing engine must scale both the total provider cost and the total
 * customer charge by the quantity so that:
 *   - the wallet is debited the TRUE TOTAL (unit sale price * quantity)
 *   - the provider receives the TRUE TOTAL procurement amount for ALL cards
 *
 * Run: node tests/pin_quantity_pricing.test.js
 */
const assert = require('assert');

// ── Stub surface (no DB, no network) ──────────────────────────────────────
const PricingRule = require('../models/PricingRule');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const Expense = require('../models/Expense');
const mongoose = require('mongoose');

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
    name: 'Multi-Pin Buyer',
    email: 'mp@test.com',
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

const ACTIVE_PERCENT_RULE = {
    _id: OID(),
    markupType: 'percent',
    markupValue: 11.11111111111111, // 900 -> 1000 (exact)
    priority: 50,
    userRole: 'all',
    status: true,
};

// PricingRule.find(query).sort({ priority: -1 }) -> promise with .sort()
PricingRule.find = () => ({
    sort: () => ({
        then: (cb) => Promise.resolve(cb([ACTIVE_PERCENT_RULE])),
        catch: () => Promise.resolve([ACTIVE_PERCENT_RULE]),
    }),
    then: (cb) => Promise.resolve(cb([ACTIVE_PERCENT_RULE])),
    catch: () => Promise.resolve([ACTIVE_PERCENT_RULE]),
});

// ── purchase.service stubs ────────────────────────────────────────────────
Service.findOne = async () => PIN_SERVICE;
ServiceIdentity.findOne = async () => null;
User.findById = () => ({
    select: () => MOCK_USER,
    session: async () => MOCK_USER,
    then: (cb) => Promise.resolve(cb(MOCK_USER)),
});
Wallet.findOne = async () => ({ balance: 100000 });
const mockTransactions = [];
const makeTx = (doc, transactionId) => {
    const tx = {
        ...doc,
        _id: OID(),
        transactionId,
        isLoss: Boolean(doc.isLoss),
        resolutionState: doc.resolutionState || 'unresolved',
        save: async function () { return this; },
    };
    mockTransactions.push(tx);
    return tx;
};
Transaction.create = async (doc) => makeTx(doc, 'TXN-MP-1');
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
Expense.create = async () => [];
mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => {},
    abortTransaction: async () => {},
    endSession: () => {},
});
pinService.verifyPin = async () => true;
walletService.debit = async () => {};
referral.processLifetimeCommission = async () => 0;
notificationService.notifyPurchaseSuccess = async () => {};
notificationService.notifyPurchaseFailure = async () => {};
// Force the MODERN pricing engine path (not the legacy fallback): the purchase
// service asks the procurement engine for the winning offer for the service.
procurementService.selectBestOffer = async () => PIN_OFFER;

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
    console.log('  HIGH 2: MULTI-PIN QUANTITY / PRICING INTEGRITY');
    console.log('====================================================\n');

    // ── P1. Pricing preview: quantity=2 report the TOTAL customer charge ─
    await test('P1. resolvePricing(pin, qty=2) salePrice is the TOTAL for 2 cards (expect 2000, not 1000)', async () => {
        const pricing = await pricingService.resolvePricing(MOCK_USER, PIN_SERVICE, PIN_OFFER, 1000, 2);
        assert.strictEqual(pricing.salePrice, 2000, `salePrice must be unit(1000) * 2 = 2000, got ${pricing.salePrice}`);
    });

    // ── P2. Provider cost basis is also the batch total ─────────────────
    await test('P2. resolvePricing(pin, qty=2) baseCostPrice is TOTAL provider cost (expect 1800, not 900)', async () => {
        const pricing = await pricingService.resolvePricing(MOCK_USER, PIN_SERVICE, PIN_OFFER, 1000, 2);
        assert.strictEqual(pricing.baseCostPrice, 1800, `baseCostPrice must be unit(900) * 2 = 1800, got ${pricing.baseCostPrice}`);
    });

    // ── P3. Purchase: wallet is debited the TOTAL 2000 ──────────────────
    await test('P3. processPurchase debit amount == total sale price (2000) for qty=2', async () => {
        const captured = [];
        walletService.debit = async (userId, amount, ref, type) => { captured.push({ amount }); };
        let savedTx = null;
        Transaction.create = async (doc) => { savedTx = makeTx(doc, 'TXN-MP-3'); return savedTx; };

        await purchaseService.processPurchase(MOCK_USER._id, {
            type: 'pin',
            serviceId: 'WAEC_REG_500',
            canonicalService: PIN_SERVICE,
            amount: 1000,            // unit amount
            quantity: 2,
            pin: '1234',
            expectedPrice: 2000,     // preview total (web/mobile contract)
            details: { request_id: 'REF-MP-3', serviceID: 'waec-registration', variation_code: 'WAEC_REG_500', phone: '08012345678', quantity: 2 },
            providerCall: async () => ({ success: true, status: 'success', message: 'ok', transactionId: 'VTP-1', raw: { code: '000' } }),
        });

        assert.strictEqual(captured.length, 1, 'one debit expected');
        assert.strictEqual(captured[0].amount, 2000, `debit must be the TOTAL (2 * 1000), got ${captured[0].amount}`);
        assert.strictEqual(savedTx.amount, 2000, `transaction.amount must be TOTAL 2000, got ${savedTx && savedTx.amount}`);
    });

    // ── P4. Provider receives the TOTAL procurement amount (2 * 900) ────
    await test('P4. providerCall receives TOTAL provider cost 1800 for qty=2', async () => {
        let providerAmount = null;
        walletService.debit = async () => {};
        Transaction.create = async (doc) => makeTx(doc, 'TXN-MP-4');

        await purchaseService.processPurchase(MOCK_USER._id, {
            type: 'pin',
            serviceId: 'WAEC_REG_500',
            canonicalService: PIN_SERVICE,
            amount: 1000,
            quantity: 2,
            pin: '1234',
            expectedPrice: 2000,
            details: { request_id: 'REF-MP-4', serviceID: 'waec-registration', variation_code: 'WAEC_REG_500', phone: '08012345678', quantity: 2 },
            providerCall: async (refId, resolvedCost) => { providerAmount = resolvedCost; return { success: true, status: 'success', message: 'ok', transactionId: 'VTP-2', raw: { code: '000' } }; },
        });

        assert.strictEqual(providerAmount, 1800, `provider must get unit provider cost(900) * 2 = 1800, got ${providerAmount}`);
    });

    // ── P5. expectedPrice manipulation cannot shrink the debit ───────────
    await test('P5. expectedPrice=2000 is NOT reduced when client sends a total of 2*1000 (already true)', async () => {
        let captured = null;
        walletService.debit = async (userId, amount) => { captured = amount; };
        Transaction.create = async (doc) => makeTx(doc, 'TXN-MP-5');

        await purchaseService.processPurchase(MOCK_USER._id, {
            type: 'pin',
            serviceId: 'WAEC_REG_500',
            canonicalService: PIN_SERVICE,
            amount: 1000,
            quantity: 2,
            pin: '1234',
            expectedPrice: 2000,
            details: { request_id: 'REF-MP-5', serviceID: 'waec-registration', variation_code: 'WAEC_REG_500', phone: '08012345678', quantity: 2 },
            providerCall: async () => ({ success: true, status: 'success', message: 'ok', transactionId: 'VTP-3', raw: { code: '000' } }),
        });

        assert.strictEqual(captured, 2000, `debit must stay 2000 regardless of expectedPrice, got ${captured}`);
    });

    // ── P6. quantity=1 preserves today's pricing exactly ─────────────────
    await test('P6. resolvePricing(pin, qty=1) is unchanged (1000 / 900)', async () => {
        const pricing = await pricingService.resolvePricing(MOCK_USER, PIN_SERVICE, PIN_OFFER, 1000, 1);
        assert.strictEqual(pricing.salePrice, 1000);
        assert.strictEqual(pricing.baseCostPrice, 900);
    });

    // ─────────────────────────────────────────────────────────────────────
    // SECTION: RULE-VARIANT SEMANTICS (per-unit math, then × qty)
    // ─────────────────────────────────────────────────────────────────────
    const withRule = (rule) => {
        PricingRule.find = () => ({
            sort: () => ({
                then: (cb) => Promise.resolve(cb([rule])),
                catch: () => Promise.resolve([rule]),
            }),
            then: (cb) => Promise.resolve(cb([rule])),
            catch: () => Promise.resolve([rule]),
        });
    };
    const resetRule = () => {
        PricingRule.find = () => ({
            sort: () => ({
                then: (cb) => Promise.resolve(cb([ACTIVE_PERCENT_RULE])),
                catch: () => Promise.resolve([ACTIVE_PERCENT_RULE]),
            }),
            then: (cb) => Promise.resolve(cb([ACTIVE_PERCENT_RULE])),
            catch: () => Promise.resolve([ACTIVE_PERCENT_RULE]),
        });
    };

    await test('R5. percent rule: unit = cost*(1+pct); qty=2 total = unit*2 (900*1.1111..=1000 -> 2000)', async () => {
        // provider unit cost = 900, percent 11.11111111111111% => unit sale 1000
        const p = await pricingService.resolvePricing(MOCK_USER, PIN_SERVICE, PIN_OFFER, 1000, 2);
        assert.strictEqual(p.salePrice, 2000, 'unit 1000 * 2');
        assert.strictEqual(p.baseCostPrice, 1800, 'unit 900 * 2');
        assert.strictEqual(p.profit, 200, 'total profit 200 = 2000 - 1800');
    });

    await test('R6. fixed rule: unit = cost + fixed; qty=2 total = unit*2 (900+40=940 -> 1880)', async () => {
        withRule({ _id: OID(), markupType: 'fixed', markupValue: 40, priority: 5, userRole: 'all', status: true });
        const p = await pricingService.resolvePricing(MOCK_USER, PIN_SERVICE, PIN_OFFER, 1000, 2);
        assert.strictEqual(p.salePrice, 1880, 'fixed markup per unit 940 * 2');
        assert.strictEqual(p.baseCostPrice, 1800);
        assert.strictEqual(p.profit, 80, 'unit profit 40 * 2');
        resetRule();
    });

    await test('R7. role-specific rule: per-unit selected for the role, then scaled (agent 5%)', async () => {
        withRule({ _id: OID(), markupType: 'percent', markupValue: 5, priority: 100, userRole: 'agent', status: true });
        const agentUser = { ...MOCK_USER, roles: ['agent'], role: 'user', accountType: 'retail' };
        const p = await pricingService.resolvePricing(agentUser, PIN_SERVICE, PIN_OFFER, 1000, 2);
        assert.strictEqual(p.salePrice, 1890, 'unit 900*1.05=945 -> round 945*2=1890');
        assert.strictEqual(p.baseCostPrice, 1800);
        assert.strictEqual(p.userRole, 'agent');
        resetRule();
    });

    await test('R8. no-rule fallback (percent_fallback 1.5%): qty=2 scales exactly', async () => {
        PricingRule.find = () => ({
            sort: () => ({
                then: (cb) => Promise.resolve(cb([])),
                catch: () => Promise.resolve([]),
            }),
            then: (cb) => Promise.resolve(cb([])),
            catch: () => Promise.resolve([]),
        });
        const p = await pricingService.resolvePricing(MOCK_USER, PIN_SERVICE, PIN_OFFER, 1000, 2);
        assert.strictEqual(p.salePrice, Math.round(900 * 1.015) * 2, 'fallback unit ~914 * 2');
        assert.strictEqual(p.baseCostPrice, 1800);
        resetRule();
    });

    // ── P7. Non-pin categories must not be quantity-scaled ───────────────
    await test('P7. airtime requested 5000 with quantity present is NOT multiplied', async () => {
        const airtimeService = { ...PIN_SERVICE, category: 'airtime', suggestedRetailPrice: undefined };
        const q1 = await pricingService.resolvePricing(MOCK_USER, airtimeService, PIN_OFFER, 5000, 1);
        const q2 = await pricingService.resolvePricing(MOCK_USER, airtimeService, PIN_OFFER, 5000, 2);
        // The airtime amount IS the total request amount; a stray quantity must
        // not change the customer charge or the provider cost.
        assert.strictEqual(q2.salePrice, q1.salePrice, `airtime qty must be ignored, got ${q2.salePrice} vs ${q1.salePrice}`);
        assert.strictEqual(q2.baseCostPrice, q1.baseCostPrice);
    });

    await test('P8. data (fixed plan) quantity never scales the plan cost', async () => {
        const dataCost = 950; // one plan
        const dataOffer = { ...PIN_OFFER, costPrice: dataCost };
        const dataService = { ...PIN_SERVICE, category: 'data' };
        const q1 = await pricingService.resolvePricing(MOCK_USER, dataService, dataOffer, 1000, 1);
        const q3 = await pricingService.resolvePricing(MOCK_USER, dataService, dataOffer, 1000, 3);
        assert.strictEqual(q1.salePrice, q3.salePrice, 'data must be quantity-blind');
        assert.strictEqual(q1.baseCostPrice, dataCost);
        assert.strictEqual(q3.baseCostPrice, dataCost);
    });

    await test('P9. electricity (variable) quantity never scales the meter amount', async () => {
        const elecService = { ...PIN_SERVICE, category: 'electricity', suggestedRetailPrice: undefined };
        const q1 = await pricingService.resolvePricing(MOCK_USER, elecService, PIN_OFFER, 2000, 1);
        const q4 = await pricingService.resolvePricing(MOCK_USER, elecService, PIN_OFFER, 2000, 4);
        assert.strictEqual(q1.salePrice, q4.salePrice, 'electricity must be quantity-blind');
        assert.strictEqual(q1.baseCostPrice, 2000);
        assert.strictEqual(q4.baseCostPrice, 2000);
    });

    await test('P10. cable (tv, fixed plan) quantity never scales the package cost', async () => {
        const cableCost = 1500;
        const cableOffer = { ...PIN_OFFER, costPrice: cableCost };
        const cableService = { ...PIN_SERVICE, category: 'tv' };
        const q1 = await pricingService.resolvePricing(MOCK_USER, cableService, cableOffer, 1900, 2);
        // engine ignores quantity for tv: per-unit = 1500 * 1.1111.. ~ round 1667
        const expectedUnit = Math.round(cableCost * (1 + (ACTIVE_PERCENT_RULE.markupValue / 100)));
        assert.strictEqual(q1.salePrice, expectedUnit, 'cable is a single package; qty=2 must not double it');
        assert.strictEqual(q1.baseCostPrice, cableCost);
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
