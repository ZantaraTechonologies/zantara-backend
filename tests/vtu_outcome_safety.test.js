'use strict';

const assert = require('assert');
const mongoose = require('mongoose');
const axios = require('axios');

const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const WalletLedger = require('../models/WalletLedger');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
const Provider = require('../models/Provider');
const ProviderOffer = require('../models/ProviderOffer');
const PricingRule = require('../models/PricingRule');
const Expense = require('../models/Expense');
const Pin = require('../models/Pin');
const Setting = require('../models/Setting');

const purchaseService = require('../services/purchase.service');
const refundService = require('../services/refund.service');
const providerService = require('../services/provider.service');
const procurementService = require('../services/procurement.service');
const walletService = require('../services/wallet.service');
const pinService = require('../services/pin.service');
const notificationService = require('../services/notification.service');
const referral = require('../utils/referral');
const servicesController = require('../controllers/servicesController');
const VTPassAdapter = require('../adapters/vtpass.adapter');
const Vas2NetsAdapter = require('../adapters/vas2nets.adapter');
const { normalizeProviderOutcome } = require('../utils/providerOutcome');

const originals = {
    startSession: mongoose.startSession,
    axiosPost: axios.post,
    transactionCreate: Transaction.create,
    transactionFindById: Transaction.findById,
    transactionFindOne: Transaction.findOne,
    transactionFindOneAndUpdate: Transaction.findOneAndUpdate,
    transactionUpdateOne: Transaction.updateOne,
    userFindById: User.findById,
    walletFindOne: Wallet.findOne,
    ledgerFindOne: WalletLedger.findOne,
    serviceFindOne: Service.findOne,
    identityFindOne: ServiceIdentity.findOne,
    providerFindOne: Provider.findOne,
    offerFindOne: ProviderOffer.findOne,
    pricingRuleFind: PricingRule.find,
    expenseCreate: Expense.create,
    pinCreate: Pin.create,
    settingFindOne: Setting.findOne,
    selectBestOffer: procurementService.selectBestOffer,
    walletDebit: walletService.debit,
    walletCredit: walletService.credit,
    verifyPin: pinService.verifyPin,
    notifySuccess: notificationService.notifyPurchaseSuccess,
    notifyFailure: notificationService.notifyPurchaseFailure,
    commission: referral.processLifetimeCommission,
    processPurchase: purchaseService.processPurchase,
    queryTransaction: providerService.queryTransaction,
    getAdapterInstance: providerService.getAdapterInstance,
};

const userId = new mongoose.Types.ObjectId();
const serviceId = new mongoose.Types.ObjectId();
const providerId = new mongoose.Types.ObjectId();
const offerId = new mongoose.Types.ObjectId();

const user = {
    _id: userId,
    name: 'H5 Test Customer',
    email: 'h5@example.test',
    phone: '08000000000',
    role: 'user',
    accountType: 'retail',
    kycLevel: 2,
};

const service = {
    _id: serviceId,
    code: 'H5_AIRTIME',
    category: 'airtime',
    identityId: { providerCode: 'airtime' },
};

const offer = {
    _id: offerId,
    serviceId,
    providerId: { _id: providerId, name: 'SelectedProvider', status: 'active', adapterType: 'universal' },
    providerCode: 'selected-airtime',
    costPrice: 100,
};

let transactions;
let ledgerEntries;
let walletCredits;
let walletDebits;
let expenses;
let commissions;

const matches = (doc, filter) => Object.entries(filter || {}).every(([key, expected]) => {
    if (key === '$or') return expected.some(candidate => matches(doc, candidate));
    if (key === '_id') return String(doc._id) === String(expected);
    if (expected && typeof expected === 'object' && '$ne' in expected) return doc[key] !== expected.$ne;
    if (expected && typeof expected === 'object' && '$in' in expected) return expected.$in.includes(doc[key] ?? null);
    if (doc[key] && expected && (typeof doc[key] === 'object' || typeof expected === 'object')) {
        return String(doc[key]) === String(expected);
    }
    return doc[key] === expected;
});

const makeSession = () => ({
    startTransaction() {},
    async commitTransaction() {},
    async abortTransaction() {},
    endSession() {},
    inTransaction() { return true; },
});

const makeTransaction = doc => ({
    ...doc,
    _id: doc._id || new mongoose.Types.ObjectId(),
    transactionId: doc.transactionId || `H5-${transactions.length + 1}`,
    status: doc.status || 'pending',
    isLoss: Boolean(doc.isLoss),
    async save() { return this; },
});

const queryResult = value => ({
    session: async () => value,
    select() { return this; },
    populate() { return this; },
    sort() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
});

function resetMocks() {
    transactions = [];
    ledgerEntries = [];
    walletCredits = [];
    walletDebits = [];
    expenses = [];
    commissions = [];

    mongoose.startSession = async () => makeSession();
    pinService.verifyPin = async () => true;
    User.findById = () => queryResult(user);
    Wallet.findOne = async () => ({ balance: 100000 });
    Service.findOne = () => queryResult(service);
    ServiceIdentity.findOne = async () => null;
    Setting.findOne = async () => null;
    procurementService.selectBestOffer = async () => offer;
    PricingRule.find = () => queryResult([]);
    notificationService.notifyPurchaseSuccess = async () => {};
    notificationService.notifyPurchaseFailure = async () => {};
    providerService.queryTransaction = originals.queryTransaction;
    providerService.getAdapterInstance = originals.getAdapterInstance;
    referral.processLifetimeCommission = async () => { commissions.push('commission'); return 0; };
    Expense.create = async docs => { expenses.push(...docs); return docs; };

    Transaction.create = async doc => {
        const tx = makeTransaction(doc);
        transactions.push(tx);
        return tx;
    };
    Transaction.findById = id => queryResult(transactions.find(tx => String(tx._id) === String(id)) || null);
    Transaction.findOne = filter => queryResult(transactions.find(tx => matches(tx, filter)) || null);
    Transaction.updateOne = async (filter, update) => {
        const tx = transactions.find(item => matches(item, filter));
        if (!tx) return { modifiedCount: 0 };
        if (update.$set) Object.assign(tx, update.$set);
        if (update.$unset) Object.keys(update.$unset).forEach(key => delete tx[key]);
        return { modifiedCount: 1 };
    };
    Transaction.findOneAndUpdate = async (filter, update) => {
        const tx = transactions.find(item => matches(item, filter));
        if (!tx) return null;
        if (update.$set) Object.assign(tx, update.$set);
        return tx;
    };
    WalletLedger.findOne = filter => queryResult(ledgerEntries.find(entry => matches(entry, filter)) || null);

    walletService.debit = async (owner, amount, reference, source, transactionId) => {
        walletDebits.push({ owner, amount, reference, source, transactionId });
        ledgerEntries.push({ transactionId, entryType: 'debit', amount, userId: owner });
    };
    walletService.credit = async (owner, amount, reference, source, transactionId) => {
        walletCredits.push({ owner, amount, reference, source, transactionId });
    };
}

async function buyWith(providerCall, overrides = {}) {
    return purchaseService.processPurchase(userId, {
        type: 'airtime',
        serviceId: service.code,
        canonicalService: overrides.canonicalService || service,
        amount: 100,
        pin: '1234',
        expectedPrice: 101,
        provider: 'ControllerProvider',
        providerPreflight: overrides.providerPreflight,
        details: { request_id: overrides.reference || `REF-${transactions.length + 1}`, phone: user.phone },
        providerCall,
    });
}

const makeResponse = () => ({
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
});

async function assertCategoryProviderBinding(category) {
    const categoryName = category === 'cable' ? 'tv' : category;
    const categoryService = {
        ...service,
        code: `H6_${category.toUpperCase()}_PRODUCT`,
        category: categoryName,
        provider: 'LegacyProvider',
        identityId: { providerCode: `legacy-${category}-root` },
    };
    const categoryOffer = {
        ...offer,
        providerCode: `selected-${category}-product`,
        providerServiceCode: `selected-${category}-root`,
    };
    Service.findOne = () => queryResult(categoryService);
    procurementService.selectBestOffer = async () => categoryOffer;

    let providerCall;
    const pending = payload => {
        providerCall = payload;
        return {
            outcome: 'pending',
            success: false,
            status: 'pending',
            message: 'Processing',
            raw: { status: 'pending' },
        };
    };
    const adapter = {
        purchaseAirtime: pending,
        purchaseData: pending,
        purchaseElectricity: pending,
        purchaseCable: pending,
        purchaseExamPin: pending,
    };
    providerService.getAdapterInstance = async selectedProvider => {
        assert.strictEqual(selectedProvider, 'SelectedProvider');
        return adapter;
    };

    const req = {
        user: { _id: userId, id: String(userId), roles: ['user'] },
        body: {
            network: categoryService.code.toLowerCase(),
            serviceID: `client-${category}-root`,
            phone: user.phone,
            billersCode: category === 'electricity' ? '12345678901' : user.phone,
            meter_number: '12345678901',
            meter_type: 'prepaid',
            variation_code: categoryService.code.toLowerCase(),
            amount: 100,
            quantity: 1,
            pin: '1234',
        },
    };
    const res = makeResponse();
    const controllers = {
        airtime: servicesController.purchaseAirtime,
        data: servicesController.purchaseData,
        electricity: servicesController.payElectricityBill,
        cable: servicesController.rechargeCable,
        pin: servicesController.purchaseExamPin,
    };

    await controllers[category](req, res);

    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(providerCall.serviceID, categoryOffer.providerServiceCode);
    if (['data', 'cable', 'pin'].includes(category)) {
        assert.strictEqual(providerCall.variation_code, categoryOffer.providerCode);
    }
    assert.strictEqual(transactions.length, 1);
    assert.strictEqual(transactions[0].provider, 'SelectedProvider');
    assert.strictEqual(String(transactions[0].providerOfferId), String(categoryOffer._id));

    let requeryArgs;
    providerService.queryTransaction = async (reference, selectedProvider) => {
        requeryArgs = { reference, provider: selectedProvider };
        return pending({ status: 'pending' });
    };
    const requeryRes = makeResponse();
    await servicesController.checkTransaction({
        body: { refId: transactions[0].transactionId },
        user: { id: String(userId) },
    }, requeryRes);
    assert.deepStrictEqual(requeryArgs, {
        reference: transactions[0].refId,
        provider: 'SelectedProvider',
    });
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
    resetMocks();
    try {
        await fn();
        console.log(`[PASS] ${name}`);
        passed++;
    } catch (error) {
        console.error(`[FAIL] ${name}`);
        console.error(`  ${error.message}`);
        failed++;
    }
}

async function run() {
    console.log('=====================================================');
    console.log(' H5 VTU OUTCOME SAFETY + CORE H6 PROVIDER BINDING');
    console.log('=====================================================\n');

    await test('VTPass 099 is PENDING and does not refund', async () => {
        const adapter = new VTPassAdapter({ baseUrl: 'https://provider.test' });
        const result = await buyWith(async () => adapter.mapResponse({ code: '099', response_description: 'TRANSACTION IS PROCESSING' }));
        assert.strictEqual(result.status, 'pending');
        assert.strictEqual(result.providerOutcome, 'pending');
        assert.strictEqual(walletCredits.length, 0);
        assert.strictEqual(transactions[0].status, 'pending');
    });

    await test('transport timeout after dispatch is UNKNOWN and does not refund', async () => {
        axios.post = async () => { const error = new Error('timeout of 30000ms exceeded'); error.code = 'ETIMEDOUT'; throw error; };
        const adapter = new VTPassAdapter({ baseUrl: 'https://provider.test' });
        const result = await buyWith((ref, amount, selection) => adapter.purchaseAirtime({
            request_id: ref,
            serviceID: selection.providerCode,
            phone: user.phone,
            amount,
        }));
        assert.strictEqual(result.status, 'pending');
        assert.strictEqual(result.providerOutcome, 'unknown');
        assert.strictEqual(walletCredits.length, 0);
    });

    await test('ECONNRESET after dispatch is UNKNOWN and does not refund', async () => {
        axios.post = async () => { const error = new Error('socket hang up'); error.code = 'ECONNRESET'; throw error; };
        const adapter = new VTPassAdapter({ baseUrl: 'https://provider.test' });
        const result = await buyWith((ref, amount, selection) => adapter.purchaseAirtime({
            request_id: ref,
            serviceID: selection.providerCode,
            phone: user.phone,
            amount,
        }));
        assert.strictEqual(result.providerOutcome, 'unknown');
        assert.strictEqual(walletCredits.length, 0);
    });

    await test('malformed provider response is UNKNOWN and does not refund', async () => {
        const adapter = new VTPassAdapter({ baseUrl: 'https://provider.test' });
        const result = await buyWith(async () => adapter.mapResponse({ unexpected: true }));
        assert.strictEqual(result.providerOutcome, 'unknown');
        assert.strictEqual(result.status, 'pending');
        assert.strictEqual(walletCredits.length, 0);
    });

    await test('adapter-proven DEFINITIVE_FAILURE refunds exactly once', async () => {
        const result = await buyWith(async () => ({
            success: false,
            status: 'failed',
            outcome: 'definitive_failure',
            message: 'Provider rejected transaction permanently',
            raw: { status: 'failed' },
        }));
        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.refunded, true);
        assert.strictEqual(walletCredits.length, 1);
        await refundService.processRefund(transactions[0]._id, 'Replay', { mode: 'provider_failure' });
        assert.strictEqual(walletCredits.length, 1);
    });

    await test('refund outage never downgrades persisted DEFINITIVE_FAILURE evidence', async () => {
        const originalRefund = refundService.processRefund;
        refundService.processRefund = async () => { throw new Error('refund database unavailable'); };
        try {
            const result = await buyWith(async () => ({
                success: false,
                status: 'failed',
                outcome: 'definitive_failure',
                message: 'Provider rejected transaction permanently',
                raw: { status: 'failed' },
            }));
            assert.strictEqual(result.status, 'pending');
            assert.strictEqual(result.providerOutcome, 'definitive_failure');
            assert.strictEqual(transactions[0].providerOutcome, 'definitive_failure');
            assert.strictEqual(walletCredits.length, 0);
        } finally {
            refundService.processRefund = originalRefund;
        }
    });

    await test('explicit SUCCESS finalizes without refund', async () => {
        const result = await buyWith(async () => ({
            success: true,
            status: 'success',
            outcome: 'success',
            message: 'Delivered',
            transactionId: 'PROVIDER-SUCCESS-1',
            raw: { code: '000' },
        }));
        assert.strictEqual(result.success, true);
        assert.strictEqual(transactions[0].status, 'success');
        assert.strictEqual(walletCredits.length, 0);
        assert.strictEqual(expenses.length, 1);
        assert.strictEqual(commissions.length, 1);
    });

    await test('provider SUCCESS plus local finalization failure never refunds', async () => {
        mongoose.startSession = async () => { throw new Error('local Mongo unavailable'); };
        let refundCalls = 0;
        const originalRefund = refundService.processRefund;
        refundService.processRefund = async () => { refundCalls++; };
        try {
            const result = await buyWith(async () => ({
                success: true,
                status: 'success',
                outcome: 'success',
                message: 'Delivered',
                transactionId: 'PROVIDER-SUCCESS-2',
                raw: { code: '000' },
            }));
            assert.strictEqual(result.status, 'pending');
            assert.strictEqual(result.providerOutcome, 'success');
            assert.strictEqual(refundCalls, 0);
        } finally {
            refundService.processRefund = originalRefund;
        }
    });

    await test('late requery SUCCESS finalizes the local transaction exactly once', async () => {
        const tx = makeTransaction({
            userId,
            refId: 'REQ-LATE-SUCCESS',
            type: 'airtime',
            service: service.code,
            amount: 102,
            costPrice: 100,
            profit: 2,
            provider: 'SelectedProvider',
            dispatchState: 'dispatched',
            providerOutcome: 'pending',
            details: { phone: user.phone },
        });
        transactions.push(tx);
        const response = { outcome: 'success', success: true, status: 'success', transactionId: 'P-LATE', raw: { status: 'success' } };
        const first = await purchaseService.resolveExistingTransaction(tx._id, response);
        const second = await purchaseService.resolveExistingTransaction(tx._id, response);
        assert.strictEqual(first.status, 'success');
        assert.strictEqual(second.status, 'success');
        assert.strictEqual(expenses.length, 1);
        assert.strictEqual(commissions.length, 1);
        assert.strictEqual(walletCredits.length, 0);
    });

    await test('late requery DEFINITIVE_FAILURE refunds exactly once', async () => {
        const tx = makeTransaction({
            userId,
            refId: 'REQ-LATE-FAIL',
            type: 'airtime',
            service: service.code,
            amount: 102,
            provider: 'SelectedProvider',
            dispatchState: 'dispatched',
            providerOutcome: 'pending',
        });
        transactions.push(tx);
        ledgerEntries.push({ transactionId: tx._id, entryType: 'debit', amount: 102 });
        const response = { outcome: 'definitive_failure', success: false, status: 'failed', message: 'Rejected', raw: { status: 'failed' } };
        await purchaseService.resolveExistingTransaction(tx._id, response);
        await purchaseService.resolveExistingTransaction(tx._id, response);
        assert.strictEqual(walletCredits.length, 1);
        assert.strictEqual(tx.status, 'failed');
        assert.strictEqual(tx.isLoss, true);
    });

    await test('concurrent repeated SUCCESS resolution has one set of financial effects', async () => {
        const tx = makeTransaction({
            userId,
            refId: 'REQ-CONCURRENT',
            type: 'airtime',
            service: service.code,
            amount: 102,
            costPrice: 100,
            profit: 2,
            provider: 'SelectedProvider',
            dispatchState: 'dispatched',
            providerOutcome: 'pending',
            details: {},
        });
        transactions.push(tx);
        const response = { outcome: 'success', success: true, status: 'success', transactionId: 'P-CONCURRENT', raw: { status: 'success' } };
        await Promise.all([
            purchaseService.resolveExistingTransaction(tx._id, response),
            purchaseService.resolveExistingTransaction(tx._id, response),
        ]);
        assert.strictEqual(expenses.length, 1);
        assert.strictEqual(commissions.length, 1);
        assert.strictEqual(tx.status, 'success');
    });

    await test('procurement-selected provider is persisted and actually called', async () => {
        let calledSelection;
        await buyWith(async (reference, amount, selection) => {
            calledSelection = { reference, amount, ...selection };
            return { outcome: 'pending', success: false, status: 'pending', message: 'Processing', raw: { status: 'pending' } };
        }, { reference: 'REQ-BINDING' });
        assert.strictEqual(calledSelection.provider, 'SelectedProvider');
        assert.strictEqual(calledSelection.providerCode, 'selected-airtime');
        assert.strictEqual(transactions[0].provider, 'SelectedProvider');
        assert.strictEqual(transactions[0].refId, calledSelection.reference);
    });

    await test('mixed-case canonical service cannot bypass authoritative offer selection', async () => {
        Service.findOne = () => queryResult(null);
        let calledSelection;
        const result = await purchaseService.processPurchase(userId, {
            type: 'airtime',
            serviceId: service.code.toLowerCase(),
            canonicalService: service,
            amount: 100,
            pin: '1234',
            provider: 'ControllerProvider',
            details: { request_id: 'REQ-CANONICAL-MIXED-CASE', phone: user.phone },
            providerCall: async (reference, resolvedCost, selection) => {
                calledSelection = selection;
                return { outcome: 'pending', success: false, status: 'pending', raw: {} };
            },
        });
        assert.strictEqual(result.status, 'pending');
        assert.strictEqual(calledSelection.provider, 'SelectedProvider');
        assert.strictEqual(transactions[0].provider, 'SelectedProvider');
        assert.strictEqual(String(transactions[0].providerOfferId), String(offer._id));
    });

    await test('missing offer cannot dispatch through default VTPass', async () => {
        Service.findOne = () => queryResult(null);
        procurementService.selectBestOffer = async () => null;
        let providerCalled = false;
        await assert.rejects(
            purchaseService.processPurchase(userId, {
                type: 'airtime',
                serviceId: service.code.toLowerCase(),
                canonicalService: service,
                amount: 100,
                pin: '1234',
                details: { request_id: 'REQ-NO-DEFAULT', phone: user.phone },
                providerCall: async () => {
                    providerCalled = true;
                    return { outcome: 'pending', success: false, status: 'pending', raw: {} };
                },
            }),
            /No active provider offer/
        );
        assert.strictEqual(providerCalled, false);
        assert.strictEqual(transactions.length, 0);
        assert.strictEqual(walletDebits.length, 0);
    });

    await test('airtime uses the selected offer provider and provider service code', async () => {
        await assertCategoryProviderBinding('airtime');
    });

    await test('data uses the selected offer provider, root code, and product code', async () => {
        await assertCategoryProviderBinding('data');
    });

    await test('electricity uses the selected offer provider and provider service code', async () => {
        await assertCategoryProviderBinding('electricity');
    });

    await test('cable uses the selected offer provider, root code, and product code', async () => {
        await assertCategoryProviderBinding('cable');
    });

    await test('exam PIN uses the selected offer provider, root code, and product code', async () => {
        await assertCategoryProviderBinding('pin');
    });

    await test('alternate provider without a provider service code fails before side effects', async () => {
        const dataService = {
            ...service,
            category: 'data',
            provider: 'LegacyProvider',
            identityId: { providerCode: 'legacy-provider-root' },
        };
        procurementService.selectBestOffer = async () => ({
            ...offer,
            providerCode: 'selected-data-product',
        });
        let providerCalled = false;
        await assert.rejects(
            purchaseService.processPurchase(userId, {
                type: 'data',
                serviceId: dataService.code,
                canonicalService: dataService,
                amount: 100,
                pin: '1234',
                details: { request_id: 'REQ-MISSING-ROOT-CODE', phone: user.phone },
                providerCall: async () => {
                    providerCalled = true;
                    return { outcome: 'pending', success: false, status: 'pending', raw: {} };
                },
            }),
            /no provider service code/
        );
        assert.strictEqual(providerCalled, false);
        assert.strictEqual(transactions.length, 0);
        assert.strictEqual(walletDebits.length, 0);
    });

    await test('normalized service without an active ProviderOffer fails before debit', async () => {
        procurementService.selectBestOffer = async () => null;
        let providerCalled = false;
        await assert.rejects(
            buyWith(async () => { providerCalled = true; }),
            /No active provider offer/
        );
        assert.strictEqual(providerCalled, false);
        assert.strictEqual(transactions.length, 0);
        assert.strictEqual(walletDebits.length, 0);
    });

    await test('provider preflight failure occurs before transaction creation and debit', async () => {
        let providerCalled = false;
        await assert.rejects(
            buyWith(
                async () => { providerCalled = true; },
                { providerPreflight: async () => { throw new Error('Invalid provider configuration'); } }
            ),
            /Invalid provider configuration/
        );
        assert.strictEqual(providerCalled, false);
        assert.strictEqual(transactions.length, 0);
        assert.strictEqual(walletDebits.length, 0);
    });

    await test('persisted SUCCESS evidence cannot be downgraded by an unknown requery', async () => {
        const tx = makeTransaction({
            userId,
            refId: 'REQ-SUCCESS-NO-DOWNGRADE',
            type: 'airtime',
            service: service.code,
            amount: 102,
            costPrice: 100,
            profit: 2,
            provider: 'SelectedProvider',
            dispatchState: 'dispatched',
            providerOutcome: 'success',
            providerEvidence: {
                outcome: 'success',
                success: true,
                status: 'success',
                transactionId: 'PROVIDER-SUCCESS-STORED',
                raw: { code: '000' },
            },
            details: {},
        });
        transactions.push(tx);
        mongoose.startSession = async () => { throw new Error('local Mongo unavailable'); };

        const result = await purchaseService.resolveExistingTransaction(tx._id, {
            outcome: 'unknown',
            success: false,
            status: 'unknown',
            message: 'Requery timed out',
            raw: {},
        }, { isRequery: true });

        assert.strictEqual(result.status, 'pending');
        assert.strictEqual(result.providerOutcome, 'success');
        assert.strictEqual(tx.providerOutcome, 'success');
        assert.strictEqual(walletCredits.length, 0);
    });

    await test('requery uses the original exact provider and reference and resolves locally', async () => {
        const tx = makeTransaction({
            userId,
            refId: 'ORIGINAL-REFERENCE',
            type: 'airtime',
            amount: 102,
            provider: 'ExactProvider',
            dispatchState: 'dispatched',
            providerOutcome: 'pending',
        });
        transactions.push(tx);
        let queryArgs;
        providerService.queryTransaction = async (reference, provider) => {
            queryArgs = { reference, provider };
            return { outcome: 'pending', success: false, status: 'pending', message: 'Still processing', raw: {} };
        };
        const res = makeResponse();
        await servicesController.checkTransaction({ body: { refId: tx.transactionId }, user: { id: String(userId) } }, res);
        assert.deepStrictEqual(queryArgs, { reference: 'ORIGINAL-REFERENCE', provider: 'ExactProvider' });
        assert.strictEqual(res.statusCode, 202);
        assert.strictEqual(res.body.success, false);
        assert.strictEqual(res.body.data.status, 'pending');
    });

    await test('terminal local transaction is returned without another provider requery', async () => {
        const tx = makeTransaction({
            userId,
            refId: 'TERMINAL-REFERENCE',
            type: 'airtime',
            amount: 102,
            provider: 'ExactProvider',
            status: 'success',
            dispatchState: 'dispatched',
            providerOutcome: 'success',
            providerEvidence: {
                outcome: 'success',
                success: true,
                status: 'success',
                transactionId: 'TERMINAL-PROVIDER-REF',
                raw: { status: 'success' },
            },
        });
        transactions.push(tx);
        providerService.queryTransaction = async () => { throw new Error('terminal transaction must not be requeried'); };
        const res = makeResponse();
        await servicesController.checkTransaction({ body: { refId: tx.transactionId }, user: { id: String(userId) } }, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.data.status, 'success');
    });

    await test('unknown provider never silently falls back to VTPass', async () => {
        Provider.findOne = async () => null;
        await assert.rejects(
            providerService.getAdapterInstance('UnknownProvider'),
            /not found|unsupported|unavailable/i
        );
    });

    await test('Vas2Nets contradictory success code and failed status is UNKNOWN', async () => {
        const adapter = new Vas2NetsAdapter({ baseUrl: 'https://provider.test' });
        const mapped = adapter.mapResponse({ code: '000', status: 'failed' });
        const normalized = normalizeProviderOutcome(mapped);
        assert.strictEqual(mapped.outcome, 'unknown');
        assert.strictEqual(normalized.outcome, 'unknown');
        assert.strictEqual(normalized.success, false);
    });

    await test('Vas2Nets contradictory success code and cancelled status is UNKNOWN', async () => {
        const adapter = new Vas2NetsAdapter({ baseUrl: 'https://provider.test' });
        assert.strictEqual(adapter.mapResponse({ code: '000', status: 'cancelled' }).outcome, 'unknown');
    });

    await test('Vas2Nets contradictory success status and failure code is UNKNOWN', async () => {
        const adapter = new Vas2NetsAdapter({ baseUrl: 'https://provider.test' });
        assert.strictEqual(adapter.mapResponse({ code: '400', status: 'success' }).outcome, 'unknown');
    });

    await test('Vas2Nets contradictory pending code and terminal status is UNKNOWN', async () => {
        const adapter = new Vas2NetsAdapter({ baseUrl: 'https://provider.test' });
        const mapped = adapter.mapResponse({ code: '099', status: 'cancelled' });
        assert.strictEqual(mapped.outcome, 'unknown');
        assert.strictEqual(normalizeProviderOutcome(mapped).outcome, 'unknown');
    });

    await test('Vas2Nets contradictory pending and success signals are UNKNOWN', async () => {
        const adapter = new Vas2NetsAdapter({ baseUrl: 'https://provider.test' });
        assert.strictEqual(adapter.mapResponse({ code: '099', status: 'success' }).outcome, 'unknown');
    });

    await test('generic normalization never restores contradictory success evidence', async () => {
        const normalized = normalizeProviderOutcome({
            outcome: 'success',
            success: true,
            status: 'failed',
            raw: { code: '000', status: 'failed' },
        });
        assert.strictEqual(normalized.outcome, 'unknown');
        assert.strictEqual(normalized.success, false);
    });

    await test('Vas2Nets clear success remains SUCCESS', async () => {
        const adapter = new Vas2NetsAdapter({ baseUrl: 'https://provider.test' });
        assert.strictEqual(adapter.mapResponse({ code: '000', status: 'success' }).outcome, 'success');
    });

    await test('Vas2Nets clear pending remains PENDING', async () => {
        const adapter = new Vas2NetsAdapter({ baseUrl: 'https://provider.test' });
        assert.strictEqual(adapter.mapResponse({ code: '099', status: 'processing' }).outcome, 'pending');
    });

    await test('Vas2Nets clear terminal failure remains DEFINITIVE_FAILURE', async () => {
        const adapter = new Vas2NetsAdapter({ baseUrl: 'https://provider.test' });
        assert.strictEqual(adapter.mapResponse({ code: '400', status: 'failed' }).outcome, 'definitive_failure');
    });

    await test('Vas2Nets exam PIN forwards the selected provider service code', async () => {
        let dispatchedPayload;
        axios.post = async (url, payload) => {
            dispatchedPayload = payload;
            return { data: { code: '099', status: 'processing' } };
        };
        const adapter = new Vas2NetsAdapter({ baseUrl: 'https://provider.test' });
        await adapter.purchaseExamPin({
            request_id: 'REQ-VAS-PIN-ROOT',
            serviceID: 'selected-pin-root',
            variation_code: 'selected-pin-product',
            amount: 100,
            quantity: 1,
            phone: user.phone,
        });
        assert.strictEqual(dispatchedPayload.serviceID, 'selected-pin-root');
        assert.strictEqual(dispatchedPayload.variation_code, 'selected-pin-product');
    });

    await test('exam PIN post-success local persistence failure remains unresolved, not falsely failed', async () => {
        purchaseService.processPurchase = async () => ({
            success: true,
            status: 'success',
            providerOutcome: 'success',
            reference: 'PIN-LOCAL-REF',
            transactionId: 'LOCAL-TX-ID',
            data: { token: '1234-5678', transactionId: 'PROVIDER-PIN-REF' },
        });
        Service.findOne = () => ({ populate: async () => service });
        ProviderOffer.findOne = () => ({ sort: async () => offer });
        Pin.create = async () => { throw new Error('local PIN inventory write failed'); };
        const res = makeResponse();
        await servicesController.purchaseExamPin({
            user: { id: String(userId), roles: ['user'] },
            body: { serviceID: 'waec', variation_code: service.code, amount: 100, quantity: 1, phone: user.phone, pin: '1234' },
        }, res);
        assert.strictEqual(res.statusCode, 202);
        assert.strictEqual(res.body.success, false);
        assert.strictEqual(res.body.data.status, 'pending');
        assert.strictEqual(res.body.data.reference, 'PIN-LOCAL-REF');
        assert.strictEqual(walletCredits.length, 0);
    });

    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    mongoose.startSession = originals.startSession;
    axios.post = originals.axiosPost;
    Transaction.create = originals.transactionCreate;
    Transaction.findById = originals.transactionFindById;
    Transaction.findOne = originals.transactionFindOne;
    Transaction.findOneAndUpdate = originals.transactionFindOneAndUpdate;
    Transaction.updateOne = originals.transactionUpdateOne;
    User.findById = originals.userFindById;
    Wallet.findOne = originals.walletFindOne;
    WalletLedger.findOne = originals.ledgerFindOne;
    Service.findOne = originals.serviceFindOne;
    ServiceIdentity.findOne = originals.identityFindOne;
    Provider.findOne = originals.providerFindOne;
    ProviderOffer.findOne = originals.offerFindOne;
    PricingRule.find = originals.pricingRuleFind;
    Expense.create = originals.expenseCreate;
    Pin.create = originals.pinCreate;
    Setting.findOne = originals.settingFindOne;
    procurementService.selectBestOffer = originals.selectBestOffer;
    walletService.debit = originals.walletDebit;
    walletService.credit = originals.walletCredit;
    pinService.verifyPin = originals.verifyPin;
    notificationService.notifyPurchaseSuccess = originals.notifySuccess;
    notificationService.notifyPurchaseFailure = originals.notifyFailure;
    referral.processLifetimeCommission = originals.commission;
    purchaseService.processPurchase = originals.processPurchase;
    providerService.queryTransaction = originals.queryTransaction;
    providerService.getAdapterInstance = originals.getAdapterInstance;
});
