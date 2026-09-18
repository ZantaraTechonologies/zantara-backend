'use strict';

const assert = require('assert');
const mongoose = require('mongoose');

const User = require('../models/User');
const Wallet = require('../models/Wallet');
const WalletLedger = require('../models/WalletLedger');
const Transaction = require('../models/Transaction');
const Setting = require('../models/Setting');
const InvestmentWithdrawal = require('../models/InvestmentWithdrawal');
const ShareExitRequest = require('../models/ShareExitRequest');
const ShareIssuanceLock = require('../models/ShareIssuanceLock');
const investmentService = require('../services/investment.service');
const { allocateDividendPool } = require('../utils/dividendCron');
const notificationService = require('../services/notification.service');
const legacyNotificationService = require('../services/notificationService');
const auditController = require('../controllers/auditController');
const controller = require('../controllers/investmentController');

let state;

const originals = {
    startSession: mongoose.startSession,
    userFindById: User.findById,
    userFindOneAndUpdate: User.findOneAndUpdate,
    userAggregate: User.aggregate,
    userCountDocuments: User.countDocuments,
    walletFindOne: Wallet.findOne,
    ledgerCreate: WalletLedger.create,
    transactionCreate: Transaction.create,
    transactionFindOne: Transaction.findOne,
    settingFind: Setting.find,
    shareLockUpdateOne: ShareIssuanceLock.updateOne,
    withdrawalCreate: InvestmentWithdrawal.create,
    withdrawalFindById: InvestmentWithdrawal.findById,
    withdrawalFindOneAndUpdate: InvestmentWithdrawal.findOneAndUpdate,
    exitCreate: ShareExitRequest.create,
    exitFindById: ShareExitRequest.findById,
    exitFindOneAndUpdate: ShareExitRequest.findOneAndUpdate,
    exitCountDocuments: ShareExitRequest.countDocuments,
    sendInApp: notificationService.sendInApp,
    notifySuperAdmins: legacyNotificationService.notifySuperAdmins,
    logAction: auditController.logAction
};

function clone(value) {
    if (value == null || typeof value !== 'object') return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(clone);
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'function') copy[key] = clone(item);
    }
    return copy;
}

function idOf(value) {
    return String(value && value._id ? value._id : value);
}

function makeResponse() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

function makeQuery(load) {
    return {
        session(session) {
            return Promise.resolve(load(session));
        },
        then(resolve, reject) {
            return Promise.resolve(load(null)).then(resolve, reject);
        }
    };
}

function makeDocument(kind, value, session) {
    const document = clone(value);
    document.save = async options => {
        const owningSession = (options && options.session) || session;
        const plain = clone(document);
        if (!owningSession) {
            if (kind === 'user' || kind === 'wallet') {
                state[kind] = plain;
                state.versions[kind]++;
            } else {
                const collection = kind === 'withdrawal' ? state.withdrawals : state.exits;
                const index = collection.findIndex(item => idOf(item._id) === idOf(plain._id));
                if (index >= 0) collection[index] = plain;
            }
            return document;
        }

        if (kind === 'user' || kind === 'wallet') {
            owningSession.stageEntity(kind, plain);
        } else {
            owningSession.stageRecord(kind, plain);
        }
        return document;
    };
    return document;
}

function makeSession() {
    const session = {
        id: ++state.sessionSequence,
        active: false,
        reads: {},
        entityWrites: {},
        recordReads: new Map(),
        recordWrites: new Map(),
        newWithdrawals: [],
        newExits: [],
        newTransactions: [],
        newLedger: [],
        startTransaction() {
            this.active = true;
            state.starts++;
        },
        inTransaction() {
            return this.active;
        },
        readEntity(kind) {
            if (this.reads[kind] === undefined) this.reads[kind] = state.versions[kind];
            return clone(this.entityWrites[kind] || state[kind]);
        },
        stageEntity(kind, value) {
            if (this.reads[kind] === undefined) this.reads[kind] = state.versions[kind];
            this.entityWrites[kind] = clone(value);
        },
        readRecord(kind, id) {
            const collection = kind === 'withdrawal' ? state.withdrawals : state.exits;
            const found = collection.find(item => idOf(item._id) === idOf(id));
            if (!found) return null;
            const key = `${kind}:${idOf(id)}`;
            if (!this.recordReads.has(key)) this.recordReads.set(key, state.recordVersions.get(key) || 0);
            return clone(found);
        },
        stageRecord(kind, value) {
            const key = `${kind}:${idOf(value._id)}`;
            if (!this.recordReads.has(key)) this.recordReads.set(key, state.recordVersions.get(key) || 0);
            this.recordWrites.set(key, clone(value));
        },
        async commitTransaction() {
            for (const kind of Object.keys(this.entityWrites)) {
                if (this.reads[kind] !== state.versions[kind]) {
                    throw new Error(`write conflict on ${kind}`);
                }
            }
            for (const [key] of this.recordWrites) {
                if (this.recordReads.get(key) !== (state.recordVersions.get(key) || 0)) {
                    throw new Error(`write conflict on ${key}`);
                }
            }

            for (const [kind, value] of Object.entries(this.entityWrites)) {
                state[kind] = clone(value);
                state.versions[kind]++;
            }
            for (const [key, value] of this.recordWrites) {
                const collection = key.startsWith('withdrawal:') ? state.withdrawals : state.exits;
                const index = collection.findIndex(item => idOf(item._id) === idOf(value._id));
                if (index >= 0) collection[index] = clone(value);
                state.recordVersions.set(key, (state.recordVersions.get(key) || 0) + 1);
            }
            state.withdrawals.push(...clone(this.newWithdrawals));
            state.exits.push(...clone(this.newExits));
            state.transactions.push(...clone(this.newTransactions));
            state.ledger.push(...clone(this.newLedger));
            this.active = false;
            state.commits++;
        },
        async abortTransaction() {
            this.active = false;
            state.aborts++;
        },
        endSession() {
            if (this.active) state.endedActive++;
            this.active = false;
            state.ends++;
        }
    };
    state.sessions.push(session);
    return session;
}

function resetState(overrides = {}) {
    state = {
        user: {
            _id: 'user-1',
            id: 'user-1',
            name: 'Investor',
            isShareholder: true,
            sharesOwned: 5,
            frozenShares: 0,
            dividendBalance: 1000,
            referralBalance: 500,
            firstSharePurchasedAt: new Date('2024-01-01T00:00:00.000Z')
        },
        wallet: { _id: 'wallet-1', userId: 'user-1', balance: 50000, frozen: 0 },
        settings: {
            investmentEnabled: true,
            sharePrice: 10000,
            maxSharesPerUser: 20,
            totalSharesAvailable: 200,
            minSharesPerPurchase: 1,
            dividendWithdrawalFee: 1.5,
            dividendReinvestFee: 0,
            dividendRedeemFee: 0,
            shareLockPeriodMonths: 6,
            shareExitFee: 5,
            maxMonthlyExitPercent: 10,
            investorAllocationPercent: 20,
            dividendPayoutDay: 1
        },
        withdrawals: [],
        exits: [],
        transactions: [],
        ledger: [],
        sessions: [],
        versions: { user: 0, wallet: 0 },
        recordVersions: new Map(),
        sessionSequence: 0,
        withdrawalSequence: 0,
        exitSequence: 0,
        starts: 0,
        commits: 0,
        aborts: 0,
        ends: 0,
        endedActive: 0
    };

    if (overrides.user) Object.assign(state.user, clone(overrides.user));
    if (overrides.wallet) Object.assign(state.wallet, clone(overrides.wallet));
    if (overrides.settings) Object.assign(state.settings, clone(overrides.settings));

    mongoose.startSession = async () => makeSession();
    ShareIssuanceLock.updateOne = async () => ({ matchedCount: 1, modifiedCount: 1 });

    User.findById = id => makeQuery(session => {
        if (idOf(id) !== idOf(state.user._id)) return null;
        const value = session ? session.readEntity('user') : state.user;
        return makeDocument('user', value, session);
    });
    User.findOneAndUpdate = async (filter, update, options = {}) => {
        const session = options.session;
        const value = session ? session.readEntity('user') : clone(state.user);
        if (filter._id && idOf(filter._id) !== idOf(value._id)) return null;
        for (const [key, condition] of Object.entries(filter)) {
            if (key === '_id') continue;
            if (condition && Object.prototype.hasOwnProperty.call(condition, '$gte') && Number(value[key] || 0) < condition.$gte) return null;
        }
        for (const [key, amount] of Object.entries(update.$inc || {})) value[key] = Number(value[key] || 0) + amount;
        const document = makeDocument('user', value, session);
        if (session) session.stageEntity('user', value);
        else state.user = clone(value);
        return document;
    };
    User.aggregate = () => ({
        session: async () => [{ _id: null, total: state.user.sharesOwned }],
        then(resolve, reject) {
            return Promise.resolve([{ _id: null, total: state.user.sharesOwned }]).then(resolve, reject);
        }
    });
    User.countDocuments = async filter => filter && filter.isShareholder ? 100 : 1;

    Wallet.findOne = filter => makeQuery(session => {
        if (filter && filter.userId && idOf(filter.userId) !== idOf(state.wallet.userId)) return null;
        const value = session ? session.readEntity('wallet') : state.wallet;
        return makeDocument('wallet', value, session);
    });

    WalletLedger.create = async (rows, options = {}) => {
        const documents = Array.isArray(rows) ? rows : [rows];
        if (options.session) options.session.newLedger.push(...clone(documents));
        else state.ledger.push(...clone(documents));
        return clone(documents);
    };

    Transaction.findOne = filter => makeQuery(() => state.transactions.find(item =>
        (!filter.refId || item.refId === filter.refId) &&
        (!filter.type || item.type === filter.type) &&
        (!filter.userId || idOf(item.userId) === idOf(filter.userId))
    ) || null);
    Transaction.create = async (rows, options = {}) => {
        const documents = (Array.isArray(rows) ? rows : [rows]).map(item => ({
            _id: `transaction-${state.transactions.length + (options.session ? options.session.newTransactions.length : 0) + 1}`,
            ...clone(item)
        }));
        if (options.session) options.session.newTransactions.push(...documents);
        else state.transactions.push(...documents);
        return Array.isArray(rows) ? documents : documents[0];
    };

    Setting.find = filter => {
        const keys = filter && filter.key && filter.key.$in ? filter.key.$in : Object.keys(state.settings);
        const records = keys.filter(key => Object.prototype.hasOwnProperty.call(state.settings, key))
            .map(key => ({ key, value: clone(state.settings[key]) }));
        return {
            session: async () => records,
            then(resolve, reject) {
                return Promise.resolve(records).then(resolve, reject);
            }
        };
    };

    InvestmentWithdrawal.create = async (rows, options = {}) => {
        const documents = (Array.isArray(rows) ? rows : [rows]).map(item => ({
            _id: `withdrawal-${++state.withdrawalSequence}`,
            status: 'pending',
            ...clone(item)
        }));
        if (options.session) options.session.newWithdrawals.push(...documents);
        else state.withdrawals.push(...documents);
        return Array.isArray(rows) ? documents : documents[0];
    };
    InvestmentWithdrawal.findById = id => makeQuery(session => {
        const value = session
            ? session.readRecord('withdrawal', id)
            : state.withdrawals.find(item => idOf(item._id) === idOf(id));
        return value ? makeDocument('withdrawal', value, session) : null;
    });
    InvestmentWithdrawal.findOneAndUpdate = async (filter, update, options = {}) => {
        const session = options.session;
        const value = session
            ? session.readRecord('withdrawal', filter._id)
            : state.withdrawals.find(item => idOf(item._id) === idOf(filter._id));
        if (!value || (filter.status && value.status !== filter.status)) return null;
        Object.assign(value, clone(update.$set || {}));
        const document = makeDocument('withdrawal', value, session);
        if (session) session.stageRecord('withdrawal', value);
        else {
            const index = state.withdrawals.findIndex(item => idOf(item._id) === idOf(value._id));
            if (index >= 0) state.withdrawals[index] = clone(value);
        }
        return document;
    };

    ShareExitRequest.create = async (rows, options = {}) => {
        const documents = (Array.isArray(rows) ? rows : [rows]).map(item => ({
            _id: `exit-${++state.exitSequence}`,
            status: 'pending',
            ...clone(item)
        }));
        if (options.session) options.session.newExits.push(...documents);
        else state.exits.push(...documents);
        return Array.isArray(rows) ? documents : documents[0];
    };
    ShareExitRequest.findById = id => makeQuery(session => {
        const value = session
            ? session.readRecord('exit', id)
            : state.exits.find(item => idOf(item._id) === idOf(id));
        return value ? makeDocument('exit', value, session) : null;
    });
    ShareExitRequest.findOneAndUpdate = async (filter, update, options = {}) => {
        const session = options.session;
        const value = session
            ? session.readRecord('exit', filter._id)
            : state.exits.find(item => idOf(item._id) === idOf(filter._id));
        if (!value || (filter.status && value.status !== filter.status)) return null;
        Object.assign(value, clone(update.$set || {}));
        const document = makeDocument('exit', value, session);
        if (session) session.stageRecord('exit', value);
        else {
            const index = state.exits.findIndex(item => idOf(item._id) === idOf(value._id));
            if (index >= 0) state.exits[index] = clone(value);
        }
        return document;
    };
    ShareExitRequest.countDocuments = async filter => {
        return state.exits.filter(item => !filter.status || item.status === filter.status).length;
    };

    notificationService.sendInApp = async () => ({ _id: 'notification-1' });
    legacyNotificationService.notifySuperAdmins = async () => {};
    auditController.logAction = async () => {};
}

function seedWithdrawal(overrides = {}) {
    const source = overrides.source === undefined ? 'dividend' : overrides.source;
    const amount = overrides.amount === undefined ? 200 : overrides.amount;
    const withdrawal = {
        _id: `withdrawal-${++state.withdrawalSequence}`,
        userId: 'user-1',
        amount,
        feePercent: 1.5,
        feeCharged: 3,
        netAmount: 197,
        source,
        bankName: 'Test Bank',
        accountNumber: '0123456789',
        accountName: 'Investor',
        refId: `DIVW-${state.withdrawalSequence}`,
        status: 'pending',
        reservationVersion: 1,
        reservedAmountKobo: overrides.reservedAmountKobo === undefined && typeof amount === 'number' && Number.isFinite(amount)
            ? Math.round(amount * 100)
            : overrides.reservedAmountKobo,
        reservedSource: overrides.reservedSource === undefined ? source : overrides.reservedSource,
        ...clone(overrides)
    };
    state.withdrawals.push(withdrawal);
    return withdrawal;
}

function seedExit(overrides = {}) {
    const exit = {
        _id: `exit-${++state.exitSequence}`,
        userId: 'user-1',
        sharesRequested: 1,
        sharePrice: 10000,
        grossAmount: 10000,
        exitFeePercent: 5,
        exitFeeCharged: 500,
        netAmount: 9500,
        refId: `EXIT-${state.exitSequence}`,
        status: 'pending',
        reservationVersion: 1,
        reservedShares: 1,
        firstPurchasedAt: new Date('2024-01-01T00:00:00.000Z'),
        lockPeriodMonths: 6,
        lockExpiresAt: new Date('2024-07-01T00:00:00.000Z'),
        ...clone(overrides)
    };
    state.exits.push(exit);
    return exit;
}

async function requestWithdrawal(amount, overrides = {}) {
    const req = {
        user: { id: 'user-1' },
        body: {
            amount,
            bankName: 'Test Bank',
            accountNumber: '0123456789',
            accountName: 'Investor',
            source: 'dividend',
            ...overrides
        }
    };
    const res = makeResponse();
    await controller.requestDividendWithdrawal(req, res);
    return res;
}

async function redeem(amount, overrides = {}) {
    const req = { user: { id: 'user-1' }, body: { amount, source: 'dividend', ...overrides } };
    const res = makeResponse();
    await controller.redeemToMainWallet(req, res);
    return res;
}

async function buy(qty) {
    const res = makeResponse();
    await controller.buyShares({ user: { id: 'user-1' }, body: { qty } }, res);
    return res;
}

async function reinvest(qty) {
    const res = makeResponse();
    await controller.reinvestDividends({ user: { id: 'user-1' }, body: { qty } }, res);
    return res;
}

async function requestExit(qty) {
    const res = makeResponse();
    await controller.requestShareExit({ user: { id: 'user-1' }, body: { qty } }, res);
    return res;
}

async function processWithdrawal(id, action, admin = 'admin-1') {
    const req = {
        params: { id },
        body: { action, adminNote: action },
        user: { id: admin, name: admin },
        headers: {},
        ip: '127.0.0.1'
    };
    const res = makeResponse();
    await controller.processDividendWithdrawal(req, res);
    return res;
}

async function processExit(id, action, admin = 'admin-1') {
    const req = {
        params: { id },
        body: { action, adminNote: action },
        user: { id: admin, name: admin },
        headers: {},
        ip: '127.0.0.1'
    };
    const res = makeResponse();
    await controller.processShareExit(req, res);
    return res;
}

function mutationSnapshot() {
    return {
        dividendBalance: state.user.dividendBalance,
        referralBalance: state.user.referralBalance,
        walletBalance: state.wallet.balance,
        sharesOwned: state.user.sharesOwned,
        frozenShares: state.user.frozenShares,
        withdrawals: state.withdrawals.length,
        exits: state.exits.length,
        transactions: state.transactions.length,
        ledger: state.ledger.length
    };
}

function assertCleanRejection(before, label, allowedStatuses = [400]) {
    assert.deepStrictEqual(mutationSnapshot(), before, `${label}: rejection changed financial state`);
    assert.strictEqual(state.commits, 0, `${label}: rejected operation committed`);
    assert.ok(state.starts === 0 || state.aborts === state.starts, `${label}: opened transaction was not aborted`);
    assert.strictEqual(state.endedActive, 0, `${label}: session ended with an active transaction`);
    assert.ok(allowedStatuses.includes(state.lastStatus), `${label}: expected ${allowedStatuses.join('/')} but got ${state.lastStatus}`);
}

async function run() {
    console.log('=====================================================');
    console.log(' C2 R11-R24 INVESTMENT FINANCIAL INTEGRITY TEST SUITE');
    console.log('=====================================================\n');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        resetState();
        try {
            await fn();
            console.log(`[PASS] ${name}`);
            passed++;
        } catch (error) {
            console.error(`[FAIL] ${name}`);
            console.error(`  ${error.message}`);
            if (process.env.VERBOSE) console.error(error.stack);
            failed++;
        }
    }

    await test('R11 negative and zero money, as numbers or strings, are rejected at the controller boundary', async () => {
        const violations = [];
        for (const amount of [-1, '-1', 0, '0']) {
            resetState();
            const before = mutationSnapshot();
            const res = await requestWithdrawal(amount);
            state.lastStatus = res.statusCode;
            try {
                assertCleanRejection(before, JSON.stringify(amount));
            } catch (error) {
                violations.push(error.message);
            }
        }
        assert.deepStrictEqual(violations, [], violations.join('; '));
    });

    await test('R12 a valid decimal string is normalized once and amounts with more than two decimals are rejected', async () => {
        const valid = await requestWithdrawal('125.50');
        assert.strictEqual(valid.statusCode, 200);
        assert.strictEqual(state.commits, 1);
        assert.strictEqual(state.withdrawals.length, 1);
        assert.strictEqual(typeof state.withdrawals[0].amount, 'number', 'stored amount must be normalized to a number');
        assert.strictEqual(state.withdrawals[0].amount, 125.5);
        assert.strictEqual(state.user.dividendBalance, 874.5);

        resetState();
        const before = mutationSnapshot();
        const excessivePrecision = await requestWithdrawal('10.001');
        state.lastStatus = excessivePrecision.statusCode;
        assertCleanRejection(before, '10.001');
    });

    await test('R13 NaN, nonnumeric, Infinity-like, arrays, objects, and booleans cannot reach financial mutation', async () => {
        const invalid = [NaN, Infinity, -Infinity, 'NaN', 'abc', 'Infinity', '-Infinity', '1e3', [], [100], {}, true, false, null];
        const violations = [];
        for (const amount of invalid) {
            resetState();
            const before = mutationSnapshot();
            const res = await requestWithdrawal(amount);
            state.lastStatus = res.statusCode;
            try {
                assertCleanRejection(before, `${typeof amount}:${String(amount)}`);
            } catch (error) {
                violations.push(error.message);
            }
        }
        assert.deepStrictEqual(violations, [], violations.join('; '));
    });

    await test('R14 money whose kobo representation is not a safe integer is rejected', async () => {
        const violations = [];
        for (const amount of [90071992547409.92, '90071992547409.92']) {
            resetState({ user: { dividendBalance: Number.MAX_VALUE } });
            const before = mutationSnapshot();
            const res = await requestWithdrawal(amount);
            state.lastStatus = res.statusCode;
            try {
                assertCleanRejection(before, `unsafe-kobo:${String(amount)}`);
            } catch (error) {
                violations.push(error.message);
            }
        }
        assert.deepStrictEqual(violations, [], violations.join('; '));
    });

    await test('R15 withdrawal and redemption reject an unknown balance source without falling back to dividends', async () => {
        const violations = [];
        for (const invoke of [
            () => requestWithdrawal(100, { source: 'cashback' }),
            () => redeem(100, { source: 'cashback' })
        ]) {
            resetState();
            const before = mutationSnapshot();
            const res = await invoke();
            state.lastStatus = res.statusCode;
            try {
                assertCleanRejection(before, 'unknown source');
            } catch (error) {
                violations.push(error.message);
            }
        }
        assert.deepStrictEqual(violations, [], violations.join('; '));
    });

    await test('R16 malformed server fee configuration fails closed and aborts without mutation', async () => {
        state.settings.dividendWithdrawalFee = 'not-a-fee';
        const before = mutationSnapshot();
        const res = await requestWithdrawal(100);
        state.lastStatus = res.statusCode;
        assertCleanRejection(before, 'malformed withdrawal fee', [500, 503]);

        resetState({ settings: { dividendRedeemFee: Infinity } });
        const redeemBefore = mutationSnapshot();
        const redeemRes = await redeem(100);
        state.lastStatus = redeemRes.statusCode;
        assertCleanRejection(redeemBefore, 'malformed redemption fee', [500, 503]);
    });

    await test('R17 insufficient source balance is unchanged and the transaction is aborted', async () => {
        state.user.dividendBalance = 99;
        const before = mutationSnapshot();
        const res = await requestWithdrawal('100.00');
        state.lastStatus = res.statusCode;
        assertCleanRejection(before, 'insufficient dividend balance');
    });

    await test('R18 concurrent reservations cannot both spend the same dividend balance', async () => {
        state.user.dividendBalance = 1000;
        const responses = await Promise.all([
            requestWithdrawal(700, { accountNumber: '0000000001' }),
            requestWithdrawal(700, { accountNumber: '0000000002' })
        ]);
        assert.strictEqual(responses.filter(res => res.statusCode === 200).length, 1, 'exactly one reservation must win');
        assert.strictEqual(responses.filter(res => [400, 409].includes(res.statusCode)).length, 1, 'loser must receive a balance/conflict response');
        assert.strictEqual(state.user.dividendBalance, 300);
        assert.strictEqual(state.withdrawals.length, 1);
        assert.strictEqual(state.commits, 1);
        assert.strictEqual(state.aborts, 1);
    });

    await test('R19 rejected withdrawals refund the recorded referral or dividend source only', async () => {
        state.user.dividendBalance = 700;
        state.user.referralBalance = 100;
        const referral = seedWithdrawal({ source: 'referral', amount: 200 });
        const referralRes = await processWithdrawal(referral._id, 'rejected');
        assert.strictEqual(referralRes.statusCode, 200);
        assert.strictEqual(state.user.referralBalance, 300);
        assert.strictEqual(state.user.dividendBalance, 700);

        resetState({ user: { dividendBalance: 700, referralBalance: 100 } });
        const dividend = seedWithdrawal({ source: 'dividend', amount: 200 });
        const dividendRes = await processWithdrawal(dividend._id, 'rejected');
        assert.strictEqual(dividendRes.statusCode, 200);
        assert.strictEqual(state.user.dividendBalance, 900);
        assert.strictEqual(state.user.referralBalance, 100);
    });

    await test('R20 malformed historical withdrawal records cannot mint balances during rejection', async () => {
        const malformed = [
            { amount: '-500', source: 'dividend' },
            { amount: NaN, source: 'dividend' },
            { amount: Infinity, source: 'referral' },
            { amount: 200, source: 'cashback' }
        ];
        const violations = [];
        for (const fields of malformed) {
            resetState();
            const record = seedWithdrawal(fields);
            const before = mutationSnapshot();
            const res = await processWithdrawal(record._id, 'rejected');
            const unchanged = mutationSnapshot();
            if (![409, 422].includes(res.statusCode) || unchanged.dividendBalance !== before.dividendBalance ||
                unchanged.referralBalance !== before.referralBalance || state.withdrawals[0].status !== 'manual_review' ||
                state.commits !== 0 || state.aborts !== 1) {
                violations.push(`${JSON.stringify(fields)} returned ${res.statusCode} and changed state to ${JSON.stringify(unchanged)}`);
            }
        }
        assert.deepStrictEqual(violations, [], violations.join('; '));
    });

    await test('R21 concurrent admin approval and rejection have one terminal financial winner', async () => {
        state.user.dividendBalance = 800;
        const pending = seedWithdrawal({ amount: 200, netAmount: 197, source: 'dividend' });
        const responses = await Promise.all([
            processWithdrawal(pending._id, 'approved', 'admin-a'),
            processWithdrawal(pending._id, 'rejected', 'admin-b')
        ]);
        assert.strictEqual(responses.filter(res => res.statusCode === 200).length, 1);
        assert.strictEqual(responses.filter(res => [404, 409].includes(res.statusCode)).length, 1, 'losing admin must receive already-processed/conflict');
        assert.ok(['approved', 'rejected'].includes(state.withdrawals[0].status));
        if (state.withdrawals[0].status === 'approved') {
            assert.strictEqual(state.user.dividendBalance, 800);
            assert.strictEqual(state.transactions.filter(item => item.type === 'dividend_withdrawal').length, 1);
        } else {
            assert.strictEqual(state.user.dividendBalance, 1000);
            assert.strictEqual(state.transactions.filter(item => item.type === 'dividend_withdrawal').length, 0);
        }
        assert.strictEqual(state.commits, 1);
        assert.strictEqual(state.aborts, 1);
    });

    await test('R22 malformed historical share exits cannot mint wallet funds or consume shares', async () => {
        const malformed = [
            { netAmount: Infinity },
            { netAmount: '9500' },
            { netAmount: 90071992547409.92 },
            { sharesRequested: -2, netAmount: 9500 }
        ];
        const violations = [];
        for (const fields of malformed) {
            resetState();
            const record = seedExit(fields);
            const before = mutationSnapshot();
            const res = await processExit(record._id, 'approved');
            const after = mutationSnapshot();
            if (![409, 422].includes(res.statusCode) || after.walletBalance !== before.walletBalance ||
                after.sharesOwned !== before.sharesOwned || after.frozenShares !== before.frozenShares ||
                state.exits[0].status !== 'manual_review' || state.ledger.length !== 0 || state.commits !== 0 || state.aborts !== 1) {
                violations.push(`${JSON.stringify(fields)} returned ${res.statusCode} and changed state to ${JSON.stringify(after)}`);
            }
        }
        assert.deepStrictEqual(violations, [], violations.join('; '));
    });

    await test('R23 share quantities are strict positive safe integers in every controller and the fulfillment service', async () => {
        const invalid = [1.5, '1.5', '1share', [1], true, Infinity, Number.MAX_SAFE_INTEGER + 1];
        const endpoints = [
            ['buy', buy],
            ['reinvest', reinvest],
            ['exit', requestExit]
        ];
        const violations = [];

        for (const [name, invoke] of endpoints) {
            for (const qty of invalid) {
                resetState({ user: { dividendBalance: 1000000 }, wallet: { balance: 1000000 } });
                const before = mutationSnapshot();
                const res = await invoke(qty);
                if (res.statusCode !== 400 || JSON.stringify(mutationSnapshot()) !== JSON.stringify(before) ||
                    state.commits !== 0 || (state.starts > 0 && state.aborts !== state.starts) || state.endedActive !== 0) {
                    violations.push(`${name} accepted ${typeof qty}:${String(qty)} (status ${res.statusCode})`);
                }
            }
        }

        for (const qty of [1.5, [1], true, Number.MAX_SAFE_INTEGER + 1]) {
            resetState();
            let rejected = false;
            try {
                await investmentService.fulfillSharePurchase('user-1', qty, `STRICT-${String(qty)}`, false);
            } catch (error) {
                rejected = true;
            }
            if (!rejected || state.commits !== 0 || state.user.sharesOwned !== 5) {
                violations.push(`service accepted ${typeof qty}:${String(qty)}`);
            }
        }

        assert.deepStrictEqual(violations, [], violations.join('; '));
    });

    await test('R24 buy, redeem, and approved exit each produce exactly one matching wallet ledger mutation', async () => {
        const results = {};

        resetState({ wallet: { balance: 50000 } });
        const buyRes = await buy(1);
        results.buy = { status: buyRes.statusCode, balance: state.wallet.balance, ledger: clone(state.ledger), commits: state.commits };

        resetState({ user: { dividendBalance: 1000 }, wallet: { balance: 50000 } });
        const redeemRes = await redeem('100.00');
        results.redeem = { status: redeemRes.statusCode, balance: state.wallet.balance, ledger: clone(state.ledger), commits: state.commits };

        resetState({ user: { sharesOwned: 5, frozenShares: 1 }, wallet: { balance: 50000 } });
        const exit = seedExit({ sharesRequested: 1, netAmount: 9500 });
        const exitRes = await processExit(exit._id, 'approved');
        results.exit = { status: exitRes.statusCode, balance: state.wallet.balance, ledger: clone(state.ledger), commits: state.commits };

        assert.deepStrictEqual(
            { buy: results.buy.status, redeem: results.redeem.status, exit: results.exit.status },
            { buy: 200, redeem: 200, exit: 200 }
        );
        assert.strictEqual(results.buy.balance, 40000);
        assert.strictEqual(results.buy.ledger.length, 1, 'buy must create one ledger debit');
        assert.strictEqual(results.buy.ledger[0].entryType, 'debit');
        assert.strictEqual(results.buy.ledger[0].amount, 10000);
        assert.strictEqual(results.redeem.balance, 50100);
        assert.strictEqual(results.redeem.ledger.length, 1, 'redeem must create one ledger credit');
        assert.strictEqual(results.redeem.ledger[0].entryType, 'credit');
        assert.strictEqual(results.redeem.ledger[0].amount, 100);
        assert.strictEqual(results.exit.balance, 59500);
        assert.strictEqual(results.exit.ledger.length, 1, 'exit approval must create one ledger credit');
        assert.strictEqual(results.exit.ledger[0].entryType, 'credit');
        assert.strictEqual(results.exit.ledger[0].amount, 9500);
        assert.deepStrictEqual([results.buy.commits, results.redeem.commits, results.exit.commits], [1, 1, 1]);
    });

    await test('R25 dividend allocation never distributes more kobo than the authoritative pool', async () => {
        const allocations = allocateDividendPool([
            { _id: 'user-a', sharesOwned: 1 },
            { _id: 'user-b', sharesOwned: 1 },
            { _id: 'user-c', sharesOwned: 1 }
        ], 2);
        assert.strictEqual(allocations.reduce((sum, item) => sum + item.amountKobo, 0), 2);
        assert.deepStrictEqual(allocations.map(item => item.amountKobo).sort(), [0, 1, 1]);
    });

    await test('R26 malformed persisted share balances cannot enter dividend allocation', async () => {
        assert.throws(() => allocateDividendPool([{ _id: 'bad-user', sharesOwned: -1 }], 100), /positive/);
        assert.throws(() => allocateDividendPool([{ _id: 'bad-user', sharesOwned: 1.5 }], 100), /integer/);
    });

    await test('R27 a colliding historical share audit must match owner, quantity, and amount', async () => {
        resetState();
        state.transactions.push({
            userId: 'other-user',
            refId: 'AUDIT-COLLISION',
            type: 'share_purchase',
            status: 'success',
            amount: 20000,
            details: { sharesQty: 2 }
        });
        await assert.rejects(
            () => investmentService.fulfillSharePurchase('user-1', 1, 'AUDIT-COLLISION'),
            /does not reconcile/
        );
        assert.strictEqual(state.user.sharesOwned, 5);
        assert.strictEqual(state.commits, 0);
        assert.strictEqual(state.aborts, 1);
    });

    await test('R28 reinvestment cannot bypass the global share supply cap', async () => {
        resetState({
            user: { sharesOwned: 5, dividendBalance: 100000 },
            settings: { totalSharesAvailable: 5 }
        });
        const before = mutationSnapshot();
        const res = await reinvest(1);
        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(mutationSnapshot(), before);
        assert.strictEqual(state.commits, 0);
        assert.strictEqual(state.aborts, 1);
    });

    console.log(`\nTest Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    if (failed > 0) process.exitCode = 1;
}

run().catch(error => {
    console.error('[FATAL TEST ERROR]', error);
    process.exitCode = 1;
}).finally(() => {
    mongoose.startSession = originals.startSession;
    User.findById = originals.userFindById;
    User.findOneAndUpdate = originals.userFindOneAndUpdate;
    User.aggregate = originals.userAggregate;
    User.countDocuments = originals.userCountDocuments;
    Wallet.findOne = originals.walletFindOne;
    WalletLedger.create = originals.ledgerCreate;
    Transaction.create = originals.transactionCreate;
    Transaction.findOne = originals.transactionFindOne;
    Setting.find = originals.settingFind;
    ShareIssuanceLock.updateOne = originals.shareLockUpdateOne;
    InvestmentWithdrawal.create = originals.withdrawalCreate;
    InvestmentWithdrawal.findById = originals.withdrawalFindById;
    InvestmentWithdrawal.findOneAndUpdate = originals.withdrawalFindOneAndUpdate;
    ShareExitRequest.create = originals.exitCreate;
    ShareExitRequest.findById = originals.exitFindById;
    ShareExitRequest.findOneAndUpdate = originals.exitFindOneAndUpdate;
    ShareExitRequest.countDocuments = originals.exitCountDocuments;
    notificationService.sendInApp = originals.sendInApp;
    legacyNotificationService.notifySuperAdmins = originals.notifySuperAdmins;
    auditController.logAction = originals.logAction;
});
