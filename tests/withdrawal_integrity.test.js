'use strict';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const Withdrawal = require('../models/Withdrawal');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const WalletLedger = require('../models/WalletLedger');
const walletService = require('../services/wallet.service');
const settingsService = require('../services/settings.service');
const notificationService = require('../services/notification.service');
const auditController = require('../controllers/auditController');
const legacyNotificationService = require('../services/notificationService');
const mailer = require('../utils/mailer');

let state;

// Stub the destructured mailer dependency before loading the controller.
mailer.sendEmail = async (...args) => {
    state.emails.push({ args, committed: state.lastCommit > 0 });
    if (state.failNotification) throw new Error('notification unavailable');
};

delete require.cache[require.resolve('../controllers/withdrawalController')];
const controller = require('../controllers/withdrawalController');

const originals = {
    startSession: mongoose.startSession,
    withdrawalCreate: Withdrawal.create,
    withdrawalFindById: Withdrawal.findById,
    withdrawalFindOneAndUpdate: Withdrawal.findOneAndUpdate,
    withdrawalFind: Withdrawal.find,
    userFindById: User.findById,
    walletFindOne: Wallet.findOne,
    ledgerCreate: WalletLedger.create,
    freeze: walletService.freeze,
    unfreeze: walletService.unfreeze,
    debit: walletService.debit,
    getSetting: settingsService.getSetting,
    sendInApp: notificationService.sendInApp,
    notify: notificationService.notify,
    logAction: auditController.logAction,
    notifySuperAdmins: legacyNotificationService.notifySuperAdmins,
    mailerSendEmail: mailer.sendEmail
};

const clone = value => {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
};

const idString = value => String(value && value._id ? value._id : value);

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

function makeRequestBody(overrides = {}) {
    return {
        amount: 1000,
        accountId: 'account-1',
        pin: '1234',
        ...overrides
    };
}

function makeUser() {
    const account = {
        _id: 'account-1',
        bankName: 'Test Bank',
        accountNumber: '0123456789',
        accountName: 'Test User'
    };
    return {
        _id: 'user-1',
        id: 'user-1',
        name: 'Test User',
        phone: '08000000000',
        email: 'user@example.test',
        isPinSet: true,
        transactionPin: bcrypt.hashSync('1234', 4),
        linkedAccounts: {
            id: accountId => idString(accountId) === idString(account._id) ? account : null
        }
    };
}

function createSession() {
    const session = {
        id: ++state.sessionSequence,
        active: false,
        wallet: null,
        ledger: [],
        withdrawals: [],
        reservedReferences: [],
        claim: null,
        startTransaction() {
            this.active = true;
            state.transactionStarts++;
        },
        async commitTransaction() {
            if (state.failCommit) throw new Error('injected commit failure');
            if (this.wallet) state.wallet = clone(this.wallet);
            state.ledger.push(...clone(this.ledger));
            state.withdrawals.push(...this.withdrawals);
            if (this.claim) Object.assign(this.claim.target, this.claim.working);
            this.active = false;
            state.lastCommit++;
            state.commits++;
        },
        async abortTransaction() {
            if (this.claim) Object.assign(this.claim.target, this.claim.original);
            for (const reference of this.reservedReferences) {
                if (!state.withdrawals.some(item => item.reference === reference)) {
                    state.references.delete(reference);
                }
            }
            this.active = false;
            state.aborts++;
        },
        async endSession() {
            state.sessionEnds++;
        }
    };
    state.sessions.push(session);
    return session;
}

function makeWithdrawalDocument(data, session = null) {
    const document = { ...data };
    document._id = document._id || `withdrawal-${++state.withdrawalSequence}`;
    document.createdAt = document.createdAt || new Date().toISOString();
    document.updatedAt = document.updatedAt || document.createdAt;
    document.toObject = () => {
        const plain = { ...document };
        delete plain.save;
        delete plain.toObject;
        return plain;
    };
    document.save = async options => {
        if (state.failWithdrawalSave) throw new Error('injected withdrawal save failure');
        const saveSession = options && options.session;
        if (saveSession && saveSession.claim) {
            saveSession.claim.working = document;
            return document;
        }
        const existing = state.withdrawals.find(item => idString(item._id) === idString(document._id));
        if (existing) Object.assign(existing, document);
        return document;
    };
    if (session && session.claim) session.claim.working = document;
    return document;
}

function walletFor(session) {
    if (!session) return state.wallet;
    if (!session.wallet) session.wallet = clone(state.wallet);
    return session.wallet;
}

function ledgerFor(session) {
    return session ? session.ledger : state.ledger;
}

async function freezeMock(userId, amount, reference, source, existingSession = null) {
    state.freezeCalls.push({ userId, amount, reference, source, session: existingSession });
    if (state.failFreeze) throw new Error('injected freeze failure');
    const wallet = walletFor(existingSession);
    if (!wallet || wallet.balance < amount) throw new Error('Insufficient balance to freeze');
    const balanceBefore = wallet.balance;
    wallet.balance -= amount;
    wallet.frozen += amount;
    ledgerFor(existingSession).push({ reference, entryType: 'debit', source: `${source}_freeze`, amount, balanceBefore, balanceAfter: wallet.balance });
    return { balance: wallet.balance, frozen: wallet.frozen };
}

async function unfreezeMock(userId, amount, reference, source, existingSession = null) {
    state.unfreezeCalls.push({ userId, amount, reference, source, session: existingSession });
    const wallet = walletFor(existingSession);
    if (!wallet || wallet.frozen < amount) throw new Error('Insufficient frozen funds');
    const balanceBefore = wallet.balance;
    wallet.frozen -= amount;
    wallet.balance += amount;
    ledgerFor(existingSession).push({ reference, entryType: 'credit', source: `${source}_unfreeze`, amount, balanceBefore, balanceAfter: wallet.balance });
    return { balance: wallet.balance, frozen: wallet.frozen };
}

async function debitMock(userId, amount, reference, source, transactionId = null, existingSession = null) {
    state.debitCalls.push({ userId, amount, reference, source, transactionId, session: existingSession });
    const wallet = walletFor(existingSession);
    if (!wallet || wallet.balance < amount) throw new Error('Insufficient wallet balance');
    const balanceBefore = wallet.balance;
    wallet.balance -= amount;
    ledgerFor(existingSession).push({ reference, entryType: 'debit', source, amount, balanceBefore, balanceAfter: wallet.balance });
    return { balance: wallet.balance };
}

function resetState() {
    state = {
        wallet: { _id: 'wallet-1', userId: 'user-1', balance: 5000, frozen: 0 },
        withdrawals: [],
        ledger: [],
        notifications: [],
        emails: [],
        freezeCalls: [],
        unfreezeCalls: [],
        debitCalls: [],
        sessions: [],
        references: new Set(),
        sessionSequence: 0,
        withdrawalSequence: 0,
        transactionStarts: 0,
        commits: 0,
        aborts: 0,
        sessionEnds: 0,
        lastCommit: 0,
        feeConfig: { type: 'flat', value: 100 },
        failCreate: false,
        failFreeze: false,
        failWithdrawalSave: false,
        failCommit: false,
        failNotification: false
    };

    mongoose.startSession = async () => createSession();
    settingsService.getSetting = async () => clone(state.feeConfig);
    walletService.freeze = freezeMock;
    walletService.unfreeze = unfreezeMock;
    walletService.debit = debitMock;

    User.findById = () => {
        const user = makeUser();
        const query = {
            select: async () => user,
            then(resolve, reject) {
                return Promise.resolve(user).then(resolve, reject);
            }
        };
        return query;
    };

    Withdrawal.create = async (input, options = {}) => {
        if (state.failCreate) throw new Error('injected withdrawal create failure');
        const documents = Array.isArray(input) ? input : [input];
        const created = documents.map(data => {
            if (state.references.has(data.reference)) {
                const error = new Error('E11000 duplicate withdrawal reference');
                error.code = 11000;
                throw error;
            }
            state.references.add(data.reference);
            const document = makeWithdrawalDocument(data);
            if (options.session) {
                options.session.withdrawals.push(document);
                options.session.reservedReferences.push(data.reference);
            } else {
                state.withdrawals.push(document);
            }
            return document;
        });
        return Array.isArray(input) ? created : created[0];
    };

    Withdrawal.findById = id => {
        const found = state.withdrawals.find(item => idString(item._id) === idString(id));
        const value = found ? makeWithdrawalDocument(clone(found)) : null;
        return {
            populate() { return this; },
            then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
        };
    };

    Withdrawal.findOneAndUpdate = async (filter, update, options = {}) => {
        const target = state.withdrawals.find(item =>
            idString(item._id) === idString(filter._id) && item.status === filter.status
        );
        if (!target) return null;
        const original = clone(target);
        Object.assign(target, update.$set || {});
        const working = makeWithdrawalDocument(clone(target), options.session);
        if (options.session) options.session.claim = { target, original, working };
        return working;
    };

    Withdrawal.find = filter => {
        const rows = state.withdrawals.filter(item => !filter.userId || idString(item.userId) === idString(filter.userId));
        return {
            populate() { return this; },
            sort: async () => rows.map(item => makeWithdrawalDocument(clone(item)))
        };
    };

    notificationService.sendInApp = async (userId, payload, eventKey) => {
        state.notifications.push({ method: 'sendInApp', userId, payload, eventKey, committed: state.lastCommit > 0, wallet: clone(state.wallet) });
        if (state.failNotification) throw new Error('notification unavailable');
        return { _id: `notification-${state.notifications.length}` };
    };
    notificationService.notify = async (user, payload) => {
        state.notifications.push({ method: 'notify', userId: user && user._id, payload, eventKey: payload.eventKey, committed: state.lastCommit > 0, wallet: clone(state.wallet) });
        if (state.failNotification) throw new Error('notification unavailable');
        return { _id: `notification-${state.notifications.length}` };
    };
    auditController.logAction = async () => {};
    legacyNotificationService.notifySuperAdmins = async () => {};
}

function seedPending(overrides = {}) {
    state.wallet = { _id: 'wallet-1', userId: 'user-1', balance: 3900, frozen: 1100 };
    state.ledger = [{ reference: 'WTH-seeded', entryType: 'debit', source: 'withdrawal_request_freeze', amount: 1100 }];
    const record = makeWithdrawalDocument({
        _id: 'withdrawal-seeded',
        userId: 'user-1',
        amount: 1000,
        fee: 100,
        totalDebit: 1100,
        bankName: 'Test Bank',
        accountNumber: '0123456789',
        accountName: 'Test User',
        reference: 'WTH-seeded',
        status: 'pending',
        ...overrides
    });
    state.withdrawals.push(record);
    state.references.add(record.reference);
    return record;
}

async function requestWithdrawal(body = makeRequestBody()) {
    const req = { body, user: { id: 'user-1' }, headers: {}, ip: '127.0.0.1' };
    const res = makeResponse();
    await controller.requestWithdrawal(req, res);
    return res;
}

async function processWithdrawal(body, adminId = 'admin-1', withdrawalId = 'withdrawal-seeded') {
    const req = {
        body,
        params: { id: withdrawalId },
        user: { id: adminId, name: `Admin ${adminId}` },
        headers: {},
        ip: '127.0.0.1'
    };
    const res = makeResponse();
    await controller.processWithdrawal(req, res);
    return res;
}

async function run() {
    console.log('=====================================================');
    console.log(' WITHDRAWAL INTEGRITY TEST SUITE');
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

    await test('W1 reference uniqueness under rapid concurrent generation', async () => {
        state.wallet.balance = 50000;
        const originalNow = Date.now;
        Date.now = () => 1700000000000;
        try {
            const responses = await Promise.all(Array.from({ length: 20 }, () => requestWithdrawal()));
            assert.ok(responses.every(res => res.statusCode === 200), 'every independent request must succeed');
            const references = state.withdrawals.map(item => item.reference);
            assert.strictEqual(references.length, 20);
            assert.strictEqual(new Set(references).size, 20, 'references must remain unique within the same millisecond');
            assert.ok(references.every(reference => /^WTH-[0-9a-f-]{32,}$/i.test(reference)), 'references must retain WTH prefix and strong random material');
        } finally {
            Date.now = originalNow;
        }
    });

    await test('W2 record creation failure after attempted freeze leaves no stranded funds', async () => {
        state.failCreate = true;
        const res = await requestWithdrawal();
        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(state.freezeCalls.length, 1, 'failure must be injected after freeze was attempted');
        assert.deepStrictEqual(state.wallet, { _id: 'wallet-1', userId: 'user-1', balance: 5000, frozen: 0 });
        assert.strictEqual(state.withdrawals.length, 0);
        assert.strictEqual(state.ledger.length, 0);
        assert.strictEqual(state.aborts, 1);
    });

    await test('W3 successful request creates one pending record, correct freeze, and one ledger', async () => {
        const res = await requestWithdrawal();
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(state.withdrawals.length, 1);
        assert.strictEqual(state.withdrawals[0].status, 'pending');
        assert.strictEqual(state.withdrawals[0].amount, 1000);
        assert.strictEqual(state.withdrawals[0].fee, 100);
        assert.strictEqual(state.withdrawals[0].totalDebit, 1100);
        assert.strictEqual(state.wallet.balance, 3900);
        assert.strictEqual(state.wallet.frozen, 1100);
        assert.strictEqual(state.ledger.length, 1);
        assert.strictEqual(state.ledger[0].amount, 1100);
        assert.strictEqual(state.ledger[0].source, 'withdrawal_request_freeze');
    });

    await test('W4 rapid independent requests have unique references and independent freezes', async () => {
        state.wallet.balance = 10000;
        const responses = await Promise.all([
            requestWithdrawal(makeRequestBody({ amount: 500 })),
            requestWithdrawal(makeRequestBody({ amount: 700 })),
            requestWithdrawal(makeRequestBody({ amount: 900 }))
        ]);
        assert.ok(responses.every(res => res.statusCode === 200));
        assert.strictEqual(state.withdrawals.length, 3);
        assert.strictEqual(new Set(state.withdrawals.map(item => item.reference)).size, 3);
        assert.strictEqual(state.wallet.frozen, 2400);
        assert.strictEqual(state.wallet.balance, 7600);
        assert.deepStrictEqual(state.ledger.map(item => item.amount).sort((a, b) => a - b), [600, 800, 1000]);
    });

    await test('W5 approval completes exactly once', async () => {
        seedPending();
        const first = await processWithdrawal({ action: 'approve', adminNote: 'Paid' });
        const second = await processWithdrawal({ action: 'approve', adminNote: 'Paid again' }, 'admin-2');
        assert.strictEqual(first.statusCode, 200);
        assert.ok([400, 409].includes(second.statusCode));
        assert.strictEqual(state.withdrawals[0].status, 'completed');
        assert.strictEqual(state.wallet.balance, 3900);
        assert.strictEqual(state.wallet.frozen, 0);
        assert.strictEqual(state.ledger.filter(item => item.source === 'withdrawal_approval_unfreeze').length, 1);
        assert.strictEqual(state.ledger.filter(item => item.source === 'withdrawal_payout').length, 1);
    });

    await test('W6 rejection completes exactly once', async () => {
        seedPending();
        const first = await processWithdrawal({ action: 'reject', adminNote: 'Account mismatch' });
        const second = await processWithdrawal({ action: 'reject', adminNote: 'Again' }, 'admin-2');
        assert.strictEqual(first.statusCode, 200);
        assert.ok([400, 409].includes(second.statusCode));
        assert.strictEqual(state.withdrawals[0].status, 'rejected');
        assert.strictEqual(state.wallet.balance, 5000);
        assert.strictEqual(state.wallet.frozen, 0);
        assert.strictEqual(state.ledger.filter(item => item.source === 'withdrawal_rejection_unfreeze').length, 1);
    });

    await test('W7 concurrent double approval has one financial winner', async () => {
        seedPending();
        const responses = await Promise.all([
            processWithdrawal({ action: 'approve', adminNote: 'A' }, 'admin-1'),
            processWithdrawal({ action: 'approve', adminNote: 'B' }, 'admin-2')
        ]);
        assert.strictEqual(responses.filter(res => res.statusCode === 200).length, 1);
        assert.strictEqual(responses.filter(res => [400, 409].includes(res.statusCode)).length, 1);
        assert.strictEqual(state.wallet.balance, 3900);
        assert.strictEqual(state.wallet.frozen, 0);
        assert.strictEqual(state.ledger.filter(item => item.source === 'withdrawal_payout').length, 1);
    });

    await test('W8 concurrent double rejection unfreezes exactly once', async () => {
        seedPending();
        const responses = await Promise.all([
            processWithdrawal({ action: 'reject', adminNote: 'A' }, 'admin-1'),
            processWithdrawal({ action: 'reject', adminNote: 'B' }, 'admin-2')
        ]);
        assert.strictEqual(responses.filter(res => res.statusCode === 200).length, 1);
        assert.strictEqual(responses.filter(res => [400, 409].includes(res.statusCode)).length, 1);
        assert.strictEqual(state.wallet.balance, 5000);
        assert.strictEqual(state.wallet.frozen, 0);
        assert.strictEqual(state.ledger.filter(item => item.source === 'withdrawal_rejection_unfreeze').length, 1);
    });

    await test('W9 approval versus rejection race has one terminal outcome', async () => {
        seedPending();
        const responses = await Promise.all([
            processWithdrawal({ action: 'approve', adminNote: 'Approve' }, 'admin-1'),
            processWithdrawal({ action: 'reject', adminNote: 'Reject' }, 'admin-2')
        ]);
        assert.strictEqual(responses.filter(res => res.statusCode === 200).length, 1);
        assert.strictEqual(responses.filter(res => [400, 409].includes(res.statusCode)).length, 1);
        assert.ok(['completed', 'rejected'].includes(state.withdrawals[0].status));
        const processingEffects = state.ledger.filter(item => item.source !== 'withdrawal_request_freeze');
        assert.ok(processingEffects.length === 1 || processingEffects.length === 2);
        assert.strictEqual(state.wallet.frozen, 0);
    });

    await test('W10 injected DB failure during approval rolls back and remains retryable', async () => {
        seedPending();
        state.failWithdrawalSave = true;
        const res = await processWithdrawal({ action: 'approve', adminNote: 'Paid' });
        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(state.withdrawals[0].status, 'pending');
        assert.strictEqual(state.wallet.balance, 3900);
        assert.strictEqual(state.wallet.frozen, 1100);
        assert.strictEqual(state.ledger.length, 1);
        assert.strictEqual(state.aborts, 1);
    });

    await test('W11 injected DB failure during rejection rolls back and remains retryable', async () => {
        seedPending();
        state.failWithdrawalSave = true;
        const res = await processWithdrawal({ action: 'reject', adminNote: 'Rejected' });
        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(state.withdrawals[0].status, 'pending');
        assert.strictEqual(state.wallet.balance, 3900);
        assert.strictEqual(state.wallet.frozen, 1100);
        assert.strictEqual(state.ledger.length, 1);
        assert.strictEqual(state.aborts, 1);
    });

    await test('W12 adminNote and processedBy persist in the processing transaction', async () => {
        seedPending();
        const res = await processWithdrawal({ action: 'approved', adminNote: 'Bank transfer confirmed' }, 'admin-42');
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(state.withdrawals[0].adminNote, 'Bank transfer confirmed');
        assert.strictEqual(idString(state.withdrawals[0].processedBy), 'admin-42');
        assert.ok(state.withdrawals[0].processedAt);
        assert.ok(Withdrawal.schema.path('adminNote'), 'active Withdrawal schema must persist adminNote');
    });

    await test('W13 fee is server-authoritative and client fee is ignored', async () => {
        state.feeConfig = { type: 'percentage', value: '10' };
        const res = await requestWithdrawal(makeRequestBody({ amount: '1000', fee: -9999, totalDebit: 1 }));
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(state.withdrawals[0].amount, 1000);
        assert.strictEqual(state.withdrawals[0].fee, 100);
        assert.strictEqual(state.withdrawals[0].totalDebit, 1100);
        assert.strictEqual(state.freezeCalls[0].amount, 1100);
    });

    await test('W14 malformed and non-finite amounts are rejected before financial mutation', async () => {
        const invalidAmounts = ['abc', 'NaN', 'Infinity', NaN, Infinity, -Infinity, 0, -1];
        for (const amount of invalidAmounts) {
            resetState();
            const res = await requestWithdrawal(makeRequestBody({ amount }));
            assert.strictEqual(res.statusCode, 400, `expected 400 for ${String(amount)}`);
            assert.strictEqual(state.freezeCalls.length, 0, `must not freeze for ${String(amount)}`);
            assert.strictEqual(state.withdrawals.length, 0);
            assert.strictEqual(state.wallet.balance, 5000);
            assert.strictEqual(state.wallet.frozen, 0);
        }
    });

    await test('W15 notification failure after commit does not alter successful request or approval', async () => {
        state.failNotification = true;
        const requestRes = await requestWithdrawal();
        assert.strictEqual(requestRes.statusCode, 200);
        assert.strictEqual(state.withdrawals[0].status, 'pending');
        assert.strictEqual(state.wallet.balance, 3900);
        assert.strictEqual(state.wallet.frozen, 1100);
        assert.ok(state.notifications.every(item => item.committed), 'request notification must be dispatched after commit');

        state.failNotification = true;
        const processRes = await processWithdrawal({ action: 'approve', adminNote: 'Paid' }, 'admin-1', state.withdrawals[0]._id);
        assert.strictEqual(processRes.statusCode, 200);
        assert.strictEqual(state.withdrawals[0].status, 'completed');
        assert.strictEqual(state.wallet.balance, 3900);
        assert.strictEqual(state.wallet.frozen, 0);
        const processedNotification = state.notifications.find(item => item.method === 'notify');
        assert.ok(processedNotification.committed);
        assert.strictEqual(processedNotification.eventKey, 'withdrawal_processed:withdrawal-1:completed');
    });

    await test('W16 invalid admin action returns 400 without financial or notification effects', async () => {
        seedPending();
        const res = await processWithdrawal({ action: 'banana', adminNote: 'Invalid' });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(state.withdrawals[0].status, 'pending');
        assert.strictEqual(state.wallet.balance, 3900);
        assert.strictEqual(state.wallet.frozen, 1100);
        assert.strictEqual(state.ledger.length, 1);
        assert.strictEqual(state.notifications.length, 0);
        assert.strictEqual(state.sessions.length, 0, 'invalid action must be rejected before opening a session');

        const missingActionRes = await processWithdrawal(undefined);
        assert.strictEqual(missingActionRes.statusCode, 400);
        assert.strictEqual(state.sessions.length, 0);
    });

    await test('customer responses use a masked withdrawal-specific allowlist', async () => {
        const postRes = await requestWithdrawal();
        assert.strictEqual(postRes.statusCode, 200);
        const postBody = postRes.body.request;
        assert.strictEqual(postBody.maskedAccountNumber, '******6789');
        for (const forbidden of ['accountNumber', 'userId', 'processedBy', 'adminNote', 'notes']) {
            assert.ok(!(forbidden in postBody), `POST response must not expose ${forbidden}`);
        }

        const historyRes = makeResponse();
        await controller.getMyWithdrawals({ user: { id: 'user-1' } }, historyRes);
        assert.strictEqual(historyRes.statusCode, 200);
        assert.strictEqual(historyRes.body.data[0].maskedAccountNumber, '******6789');
        assert.ok(!('accountNumber' in historyRes.body.data[0]));
        assert.ok(!('processedBy' in historyRes.body.data[0]));
    });

    await test('standalone freeze and unfreeze retain caller-owned session compatibility', async () => {
        const actualFreeze = originals.freeze;
        const actualUnfreeze = originals.unfreeze;
        let standaloneWallet = { _id: 'wallet-real', userId: 'user-1', balance: 5000, frozen: 0 };
        const ledger = [];
        const lifecycle = { starts: 0, commits: 0, aborts: 0, ends: 0 };

        Wallet.findOne = () => ({
            session: async () => ({
                ...standaloneWallet,
                async save() {
                    standaloneWallet.balance = this.balance;
                    standaloneWallet.frozen = this.frozen;
                }
            })
        });
        WalletLedger.create = async (rows, options) => {
            assert.ok(options.session);
            ledger.push(...rows);
        };
        mongoose.startSession = async () => ({
            startTransaction() { lifecycle.starts++; },
            async commitTransaction() { lifecycle.commits++; },
            async abortTransaction() { lifecycle.aborts++; },
            endSession() { lifecycle.ends++; }
        });

        await actualFreeze('user-1', 1100, 'WTH-standalone', 'withdrawal_request');
        assert.deepStrictEqual({ balance: standaloneWallet.balance, frozen: standaloneWallet.frozen }, { balance: 3900, frozen: 1100 });
        await actualUnfreeze('user-1', 1100, 'WTH-standalone', 'withdrawal_rejection');
        assert.deepStrictEqual({ balance: standaloneWallet.balance, frozen: standaloneWallet.frozen }, { balance: 5000, frozen: 0 });
        assert.deepStrictEqual(lifecycle, { starts: 2, commits: 2, aborts: 0, ends: 2 });
        assert.strictEqual(ledger.length, 2);

        const callerSession = { marker: 'caller-owned' };
        await actualFreeze('user-1', 500, 'WTH-owned', 'withdrawal_request', callerSession);
        await actualUnfreeze('user-1', 500, 'WTH-owned', 'withdrawal_rejection', callerSession);
        assert.deepStrictEqual(lifecycle, { starts: 2, commits: 2, aborts: 0, ends: 2 }, 'service must not manage caller-owned lifecycle');
    });

    console.log(`\nTest Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    if (failed > 0) process.exitCode = 1;
}

run().catch(error => {
    console.error('[FATAL TEST ERROR]', error);
    process.exitCode = 1;
}).finally(() => {
    mongoose.startSession = originals.startSession;
    Withdrawal.create = originals.withdrawalCreate;
    Withdrawal.findById = originals.withdrawalFindById;
    Withdrawal.findOneAndUpdate = originals.withdrawalFindOneAndUpdate;
    Withdrawal.find = originals.withdrawalFind;
    User.findById = originals.userFindById;
    Wallet.findOne = originals.walletFindOne;
    WalletLedger.create = originals.ledgerCreate;
    walletService.freeze = originals.freeze;
    walletService.unfreeze = originals.unfreeze;
    walletService.debit = originals.debit;
    settingsService.getSetting = originals.getSetting;
    notificationService.sendInApp = originals.sendInApp;
    notificationService.notify = originals.notify;
    auditController.logAction = originals.logAction;
    legacyNotificationService.notifySuperAdmins = originals.notifySuperAdmins;
});
