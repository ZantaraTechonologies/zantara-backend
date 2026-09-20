'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'investment-pin-test-secret';

const assert = require('assert');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const PaymentGateway = require('../models/PaymentGateway');
const TransactionStatus = require('../models/TransactionStatus');
const ShareExitRequest = require('../models/ShareExitRequest');
const ShareExitQuota = require('../models/ShareExitQuota');
const InvestmentWithdrawal = require('../models/InvestmentWithdrawal');
const investmentService = require('../services/investment.service');
const paymentGatewayService = require('../services/paymentGateway.service');
const walletService = require('../services/wallet.service');
const pinService = require('../services/pin.service');
const investmentRouter = require('../routes/investment');

const originals = {
    startSession: mongoose.startSession,
    userFindById: User.findById,
    userFindOne: User.findOne,
    userFindOneAndUpdate: User.findOneAndUpdate,
    userCountDocuments: User.countDocuments,
    exitCountDocuments: ShareExitRequest.countDocuments,
    exitCreate: ShareExitRequest.create,
    quotaUpdateOne: ShareExitQuota.updateOne,
    withdrawalCreate: InvestmentWithdrawal.create,
    getInvestmentSettings: investmentService.getInvestmentSettings,
    assertShareCapacity: investmentService.assertShareCapacity,
    walletDebit: walletService.debit,
    walletCredit: walletService.credit,
    verifyPin: pinService.verifyPin,
    bcryptCompare: bcrypt.compare,
    gatewayCountDocuments: PaymentGateway.countDocuments,
    gatewayFindOne: PaymentGateway.findOne,
    transactionStatusCreate: TransactionStatus.create,
    collectionFindOne: User.collection.findOne,
    gatewayInitialize: paymentGatewayService.adapters.paystack.prototype.initializePayment
};

let passed = 0;
let failed = 0;
let mutationCalls = [];
let callOrder = [];

const makeResponse = () => ({
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
});

const makeSession = () => ({
    active: false,
    startTransaction() { this.active = true; },
    inTransaction() { return this.active; },
    async commitTransaction() { this.active = false; },
    async abortTransaction() { this.active = false; },
    async withTransaction(operation) {
        this.startTransaction();
        try {
            const result = await operation();
            await this.commitTransaction();
            return result;
        } catch (error) {
            if (this.active) await this.abortTransaction();
            throw error;
        }
    },
    endSession() { this.active = false; }
});

const settings = {
    investmentEnabled: true,
    sharePrice: 100,
    minSharesPerPurchase: 1,
    maxSharesPerUser: 20,
    totalSharesAvailable: 200,
    shareLockPeriodMonths: 1,
    shareExitFee: 5,
    maxMonthlyExitPercent: 10,
    dividendReinvestFee: 0,
    dividendRedeemFee: 0,
    dividendWithdrawalFee: 1.5
};

const queryResult = value => ({
    select() { return this; },
    session: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
});

const mutationStop = (name, args = []) => {
    callOrder.push('mutation');
    mutationCalls.push({ name, args });
    const error = new Error(`TEST_MUTATION_BOUNDARY:${name}`);
    error.statusCode = 503;
    throw error;
};

const resetFlowMocks = () => {
    mutationCalls = [];
    callOrder = [];
    mongoose.startSession = async () => makeSession();
    investmentService.getInvestmentSettings = async () => ({ ...settings });
    User.countDocuments = () => queryResult(100);
    ShareExitRequest.countDocuments = async () => 0;

    const userDocument = {
        _id: 'AUTHENTICATED_OWNER',
        status: true,
        isShareholder: true,
        sharesOwned: 5,
        frozenShares: 0,
        dividendBalance: 1000,
        referralBalance: 1000,
        firstSharePurchasedAt: new Date('2020-01-01T00:00:00.000Z'),
        save: async (...args) => mutationStop('User.save', args)
    };
    User.findById = () => queryResult(userDocument);
    User.findOneAndUpdate = async (...args) => mutationStop('User.findOneAndUpdate', args);
    investmentService.assertShareCapacity = async (...args) => mutationStop('assertShareCapacity', args);
    walletService.debit = async (...args) => mutationStop('walletService.debit', args);
    walletService.credit = async (...args) => mutationStop('walletService.credit', args);
    ShareExitRequest.create = async (...args) => mutationStop('ShareExitRequest.create', args);
    ShareExitQuota.updateOne = async (...args) => mutationStop('ShareExitQuota.updateOne', args);
    InvestmentWithdrawal.create = async (...args) => mutationStop('InvestmentWithdrawal.create', args);
};

const bodyFor = (path, source = 'dividend') => {
    if (path === '/buy' || path === '/exit' || path === '/reinvest') return { qty: 1 };
    if (path === '/redeem') return { amount: 100, source };
    return {
        amount: 100,
        source,
        bankName: 'Test Bank',
        accountNumber: '0123456789',
        accountName: 'Test Investor'
    };
};

const routeHandlers = path => {
    const layer = investmentRouter.stack.find(item => item.route && item.route.path === path && item.route.methods.post);
    assert.ok(layer, `POST ${path} route must exist`);
    // Authentication and legal-compliance behavior are covered separately. Start
    // at the H4 authorization boundary and execute the real downstream controller.
    return layer.route.stack.map(item => item.handle).slice(2);
};

const dispatch = async (handlers, index, req, res) => {
    if (index >= handlers.length) return;
    const handler = handlers[index];
    let downstream;
    let nextCalled = false;
    const next = error => {
        nextCalled = true;
        downstream = error
            ? Promise.reject(error)
            : dispatch(handlers, index + 1, req, res);
        return downstream;
    };
    await Promise.resolve(handler(req, res, next));
    if (nextCalled) await downstream;
};

const invoke = async (path, body, userId = 'AUTHENTICATED_OWNER') => {
    const req = {
        user: { id: userId },
        body: { ...body },
        headers: {},
        ip: '127.0.0.1'
    };
    const res = makeResponse();
    await dispatch(routeHandlers(path), 0, req, res);
    return { req, res };
};

const test = async (name, operation) => {
    resetFlowMocks();
    try {
        await operation();
        console.log(`[PASS] ${name}`);
        passed++;
    } catch (error) {
        console.error(`[FAIL] ${name}`);
        console.error(`  ${error.message}`);
        failed++;
    }
};

const assertMissingPinBlocked = async (path, source) => {
    let verifierCalls = 0;
    pinService.verifyPin = async () => { verifierCalls++; };
    const { res } = await invoke(path, bodyFor(path, source));
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.message, /PIN is required/i);
    assert.strictEqual(verifierCalls, 0);
    assert.deepStrictEqual(mutationCalls, []);
};

const assertWrongPinBlocked = async (path, source) => {
    pinService.verifyPin = async () => {
        callOrder.push('pin');
        throw new Error('Invalid transaction PIN');
    };
    const { res } = await invoke(path, { ...bodyFor(path, source), pin: '0000' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.message, 'Invalid transaction PIN');
    assert.deepStrictEqual(mutationCalls, []);
    assert.deepStrictEqual(callOrder, ['pin']);
};

const assertCorrectPinReachesFlow = async (path, source) => {
    pinService.verifyPin = async (userId, pin) => {
        assert.strictEqual(userId, 'AUTHENTICATED_OWNER');
        assert.strictEqual(pin, '1234');
        callOrder.push('pin');
    };
    const { req } = await invoke(path, { ...bodyFor(path, source), pin: '1234' });
    assert.strictEqual(mutationCalls.length, 1);
    assert.deepStrictEqual(callOrder, ['pin', 'mutation']);
    assert.strictEqual(req.body.pin, undefined, 'raw PIN must be removed before the controller');
};

async function run() {
    console.log('=====================================================');
    console.log(' BATCH 4B H4 INVESTMENT PIN ENFORCEMENT TESTS');
    console.log('=====================================================\n');

    await test('investment_internal_buy_rejects_missing_transaction_PIN', () => assertMissingPinBlocked('/buy'));
    await test('investment_internal_buy_rejects_incorrect_transaction_PIN', () => assertWrongPinBlocked('/buy'));
    await test('investment_internal_buy_accepts_correct_transaction_PIN', () => assertCorrectPinReachesFlow('/buy'));

    await test('investment_exit_rejects_missing_PIN_before_share_reservation', () => assertMissingPinBlocked('/exit'));
    await test('investment_exit_rejects_wrong_PIN_before_share_reservation', () => assertWrongPinBlocked('/exit'));
    await test('investment_exit_correct_PIN_reaches_existing_atomic_flow', () => assertCorrectPinReachesFlow('/exit'));

    await test('investment_reinvest_rejects_missing_PIN_before_balance_mutation', () => assertMissingPinBlocked('/reinvest'));
    await test('investment_reinvest_rejects_wrong_PIN_before_balance_mutation', () => assertWrongPinBlocked('/reinvest'));
    await test('investment_reinvest_correct_PIN_reaches_existing_atomic_flow', () => assertCorrectPinReachesFlow('/reinvest'));

    for (const source of ['dividend', 'referral']) {
        await test(`investment_redeem_${source}_rejects_missing_PIN`, () => assertMissingPinBlocked('/redeem', source));
        await test(`investment_redeem_${source}_rejects_wrong_PIN`, () => assertWrongPinBlocked('/redeem', source));
        await test(`investment_redeem_${source}_correct_PIN_reaches_existing_atomic_flow`, () => assertCorrectPinReachesFlow('/redeem', source));
    }

    for (const source of ['dividend', 'referral']) {
        await test(`investment_withdraw_${source}_rejects_missing_PIN_before_reservation`, () => assertMissingPinBlocked('/withdraw', source));
        await test(`investment_withdraw_${source}_rejects_wrong_PIN_before_reservation`, () => assertWrongPinBlocked('/withdraw', source));
        await test(`investment_withdraw_${source}_correct_PIN_reaches_existing_atomic_flow`, () => assertCorrectPinReachesFlow('/withdraw', source));
    }

    await test('investment_PIN_is_verified_for_authenticated_owner_not_body_userId', async () => {
        let verifiedOwner;
        pinService.verifyPin = async userId => {
            verifiedOwner = userId;
            callOrder.push('pin');
        };
        await invoke('/buy', { qty: 1, pin: '1234', userId: 'ATTACKER_SELECTED_USER' });
        assert.strictEqual(verifiedOwner, 'AUTHENTICATED_OWNER');
    });

    await test('investment_PIN_is_removed_before_investment_record_boundary', async () => {
        pinService.verifyPin = async () => { callOrder.push('pin'); };
        const { req } = await invoke('/exit', { qty: 1, pin: '7391' });
        assert.strictEqual(req.body.pin, undefined);
        assert.ok(!JSON.stringify(mutationCalls).includes('7391'));
    });

    await test('investment_PIN_is_removed_before_ledger_boundary', async () => {
        pinService.verifyPin = async () => { callOrder.push('pin'); };
        const { req } = await invoke('/buy', { qty: 1, pin: '7391' });
        assert.strictEqual(req.body.pin, undefined);
        assert.ok(!JSON.stringify(mutationCalls).includes('7391'));
    });

    await test('qualifying_operation_without_existing_PIN_fails_closed', async () => {
        pinService.verifyPin = originals.verifyPin;
        User.findOne = () => ({ select: async () => ({ _id: 'AUTHENTICATED_OWNER', status: true, transactionPin: null }) });
        const { res } = await invoke('/buy', { qty: 1, pin: '1234' });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.message, 'Transaction PIN not set');
        assert.deepStrictEqual(mutationCalls, []);
    });

    await test('inactive_user_cannot_mutate_investment_value_even_with_correct_PIN', async () => {
        pinService.verifyPin = originals.verifyPin;
        User.findOne = () => ({ select: async () => null });
        const { res } = await invoke('/reinvest', { qty: 1, pin: '1234' });
        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(mutationCalls, []);
    });

    await test('PIN_value_is_not_logged_on_failure', async () => {
        const rawPin = '9087';
        pinService.verifyPin = async () => { throw new Error('Invalid transaction PIN'); };
        const captured = [];
        const originalLog = console.log;
        const originalError = console.error;
        console.log = (...args) => captured.push(args.map(String).join(' '));
        console.error = (...args) => captured.push(args.map(String).join(' '));
        try {
            const { res } = await invoke('/withdraw', { ...bodyFor('/withdraw'), pin: rawPin });
            assert.strictEqual(res.statusCode, 400);
        } finally {
            console.log = originalLog;
            console.error = originalError;
        }
        assert.ok(!captured.join('\n').includes(rawPin));
        assert.deepStrictEqual(mutationCalls, []);
    });

    await test('client_cannot_bypass_PIN_using_funding_or_source_flags', async () => {
        pinService.verifyPin = async () => { throw new Error('PIN verifier should not receive a missing PIN'); };
        for (const [path, source] of [['/redeem', 'referral'], ['/withdraw', 'referral']]) {
            mutationCalls = [];
            const { res } = await invoke(path, {
                ...bodyFor(path, source),
                requiresPin: false,
                fundingSource: 'external',
                paymentMethod: 'gateway'
            });
            assert.strictEqual(res.statusCode, 400);
            assert.deepStrictEqual(mutationCalls, []);
        }
    });

    await test('investment_external_gateway_buy_does_not_gain_unnecessary_PIN_requirement', async () => {
        const created = [];
        PaymentGateway.countDocuments = async () => 1;
        PaymentGateway.findOne = () => ({
            then(resolve, reject) {
                return Promise.resolve({
                    _id: 'gateway',
                    code: 'paystack',
                    name: 'Paystack',
                    adapterType: 'paystack',
                    status: 'active',
                    isDefault: true,
                    supportedChannels: ['card']
                }).then(resolve, reject);
            }
        });
        TransactionStatus.create = async record => { created.push(record); return record; };
        User.collection.findOne = async () => ({ sharesOwned: 0, isShareholder: false });
        investmentService.getInvestmentSettings = async () => ({ ...settings });
        paymentGatewayService.adapters.paystack.prototype.initializePayment = async ({ reference }) => ({
            success: true,
            authorizationUrl: 'https://checkout.example.test',
            reference
        });

        const result = await paymentGatewayService.initializeFunding({
            gatewayCode: 'paystack',
            user: { _id: 'AUTHENTICATED_OWNER', email: 'owner@example.test' },
            amount: 100,
            metadata: { type: 'investment_buy' }
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(created.length, 1);
        assert.strictEqual(created[0].type, 'investment_buy');
    });

    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    mongoose.startSession = originals.startSession;
    User.findById = originals.userFindById;
    User.findOne = originals.userFindOne;
    User.findOneAndUpdate = originals.userFindOneAndUpdate;
    User.countDocuments = originals.userCountDocuments;
    ShareExitRequest.countDocuments = originals.exitCountDocuments;
    ShareExitRequest.create = originals.exitCreate;
    ShareExitQuota.updateOne = originals.quotaUpdateOne;
    InvestmentWithdrawal.create = originals.withdrawalCreate;
    investmentService.getInvestmentSettings = originals.getInvestmentSettings;
    investmentService.assertShareCapacity = originals.assertShareCapacity;
    walletService.debit = originals.walletDebit;
    walletService.credit = originals.walletCredit;
    pinService.verifyPin = originals.verifyPin;
    bcrypt.compare = originals.bcryptCompare;
    PaymentGateway.countDocuments = originals.gatewayCountDocuments;
    PaymentGateway.findOne = originals.gatewayFindOne;
    TransactionStatus.create = originals.transactionStatusCreate;
    User.collection.findOne = originals.collectionFindOne;
    paymentGatewayService.adapters.paystack.prototype.initializePayment = originals.gatewayInitialize;
});
