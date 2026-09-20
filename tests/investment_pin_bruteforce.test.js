'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const pinService = require('../services/pin.service');
const requireTransactionPin = require('../middlewares/requireTransactionPin');
const { pinLimiter } = require('../middlewares/limiter');
const investmentRouter = require('../routes/investment');

const { MAX_FAILED_ATTEMPTS, LOCK_DURATION_MS } = pinService.PIN_SECURITY;
const verifyInvestmentPin = (userId, pin) =>
    pinService.verifyPin(userId, pin, { enforceLockout: true });
const originals = {
    findOne: User.findOne,
    findOneAndUpdate: User.findOneAndUpdate,
    updateOne: User.updateOne,
    compare: bcrypt.compare
};

const accounts = new Map();
let passed = 0;
let failed = 0;

const cloneAccount = account => account ? {
    ...account,
    transactionPinLockedUntil: account.transactionPinLockedUntil
        ? new Date(account.transactionPinLockedUntil)
        : null
} : null;

const addAccount = (id, overrides = {}) => {
    accounts.set(id, {
        _id: id,
        status: true,
        transactionPin: 'HASH:1234',
        transactionPinFailedAttempts: 0,
        transactionPinLockedUntil: null,
        ...overrides
    });
    return accounts.get(id);
};

const accountFor = filter => {
    const account = accounts.get(String(filter._id));
    if (!account || !account.status || filter.status !== true) return null;
    if (filter.transactionPin && filter.transactionPin !== account.transactionPin) return null;
    return account;
};

const installAtomicUserMock = () => {
    User.findOne = filter => ({
        select: async () => cloneAccount(accountFor(filter))
    });

    User.findOneAndUpdate = async (filter, update) => {
        const account = accountFor(filter);
        if (!account) return null;
        const now = Date.now();
        if (account.transactionPinLockedUntil && account.transactionPinLockedUntil.getTime() > now) return null;
        if (account.transactionPinFailedAttempts >= MAX_FAILED_ATTEMPTS) return null;

        account.transactionPinFailedAttempts += 1;
        if (account.transactionPinFailedAttempts >= MAX_FAILED_ATTEMPTS) {
            account.transactionPinLockedUntil = new Date(
                update[0].$set.transactionPinLockedUntil.$cond[1]
            );
        }
        return cloneAccount(account);
    };

    User.updateOne = async (filter, update) => {
        const account = accountFor(filter);
        if (!account) return { matchedCount: 0, modifiedCount: 0 };

        if (filter.transactionPinLockedUntil) {
            const expectedLock = new Date(filter.transactionPinLockedUntil).getTime();
            if (!account.transactionPinLockedUntil ||
                account.transactionPinLockedUntil.getTime() !== expectedLock) {
                return { matchedCount: 0, modifiedCount: 0 };
            }
        } else {
            const expectedFailures = filter.$expr?.$eq?.[1];
            if (account.transactionPinLockedUntil ||
                account.transactionPinFailedAttempts !== expectedFailures) {
                return { matchedCount: 0, modifiedCount: 0 };
            }
        }

        if (update.$set?.transactionPinFailedAttempts !== undefined) {
            account.transactionPinFailedAttempts = update.$set.transactionPinFailedAttempts;
        }
        if (update.$unset?.transactionPinLockedUntil) {
            account.transactionPinLockedUntil = null;
        }
        return { matchedCount: 1, modifiedCount: 1 };
    };

    bcrypt.compare = async (pin, hash) => pin === hash.replace('HASH:', '');
};

const makeResponse = () => ({
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
});

const invokeMiddleware = async ({ userId = 'USER_A', pin, ip = '127.0.0.1', body = {} }) => {
    const req = { user: { id: userId }, body: { ...body }, ip, headers: {} };
    if (pin !== undefined) req.body.pin = pin;
    const res = makeResponse();
    let nextCalled = false;
    await requireTransactionPin(req, res, () => { nextCalled = true; });
    return { req, res, nextCalled };
};

const test = async (name, operation) => {
    accounts.clear();
    installAtomicUserMock();
    try {
        await operation();
        console.log(`[PASS] ${name}`);
        passed += 1;
    } catch (error) {
        console.error(`[FAIL] ${name}`);
        console.error(`       ${error.stack || error.message}`);
        failed += 1;
    }
};

const expectRejectedCode = async (operation, code) => {
    await assert.rejects(operation, error => error.code === code);
};

async function run() {
    await test('A. correct PIN succeeds below threshold', async () => {
        const account = addAccount('USER_A', { transactionPinFailedAttempts: 2 });
        assert.strictEqual(await verifyInvestmentPin('USER_A', '1234'), true);
        assert.strictEqual(account.transactionPinFailedAttempts, 0);
    });

    await test('B. wrong PIN increments account-bound failure state', async () => {
        const account = addAccount('USER_A');
        await assert.rejects(() => verifyInvestmentPin('USER_A', '0000'), /Invalid transaction PIN/);
        assert.strictEqual(account.transactionPinFailedAttempts, 1);
    });

    await test('C. attempts are shared across every investment PIN endpoint', async () => {
        const account = addAccount('USER_A');
        const paths = ['/buy', '/exit', '/reinvest', '/redeem', '/withdraw'];
        for (const routePath of paths) {
            const layer = investmentRouter.stack.find(item => item.route?.path === routePath);
            const handlers = layer.route.stack.map(item => item.handle.name);
            assert.ok(handlers.includes('requireTransactionPin'), routePath);
            const result = await invokeMiddleware({ userId: 'USER_A', pin: '0000' });
            assert.strictEqual(result.nextCalled, false);
        }
        assert.strictEqual(account.transactionPinFailedAttempts, MAX_FAILED_ATTEMPTS);
        assert.ok(account.transactionPinLockedUntil > new Date());
    });

    await test('D. threshold triggers a temporary PIN lock', async () => {
        const account = addAccount('USER_A');
        for (let attempt = 1; attempt <= MAX_FAILED_ATTEMPTS; attempt++) {
            const result = await invokeMiddleware({ userId: 'USER_A', pin: '0000' });
            assert.strictEqual(result.res.statusCode, attempt === MAX_FAILED_ATTEMPTS ? 429 : 400);
        }
        assert.strictEqual(account.transactionPinFailedAttempts, MAX_FAILED_ATTEMPTS);
        assert.ok(account.transactionPinLockedUntil.getTime() > Date.now());
    });

    await test('E. correct PIN during active lock cannot bypass it', async () => {
        addAccount('USER_A', {
            transactionPinFailedAttempts: MAX_FAILED_ATTEMPTS,
            transactionPinLockedUntil: new Date(Date.now() + LOCK_DURATION_MS)
        });
        await expectRejectedCode(() => verifyInvestmentPin('USER_A', '1234'), 'TRANSACTION_PIN_LOCKED');
    });

    await test('F. lock automatically expires', async () => {
        const account = addAccount('USER_A', {
            transactionPinFailedAttempts: MAX_FAILED_ATTEMPTS,
            transactionPinLockedUntil: new Date(Date.now() - 1000)
        });
        await assert.rejects(() => verifyInvestmentPin('USER_A', '0000'), /Invalid transaction PIN/);
        assert.strictEqual(account.transactionPinFailedAttempts, 1);
        assert.strictEqual(account.transactionPinLockedUntil, null);
    });

    await test('G. correct PIN after expiry succeeds', async () => {
        const account = addAccount('USER_A', {
            transactionPinFailedAttempts: MAX_FAILED_ATTEMPTS,
            transactionPinLockedUntil: new Date(Date.now() - 1000)
        });
        assert.strictEqual(await verifyInvestmentPin('USER_A', '1234'), true);
        assert.strictEqual(account.transactionPinFailedAttempts, 0);
        assert.strictEqual(account.transactionPinLockedUntil, null);
    });

    await test('H. successful PIN verification resets failure state', async () => {
        const account = addAccount('USER_A', { transactionPinFailedAttempts: 4 });
        await verifyInvestmentPin('USER_A', '1234');
        assert.strictEqual(account.transactionPinFailedAttempts, 0);
    });

    await test('I. omitted PIN does not count as an incorrect attempt', async () => {
        const account = addAccount('USER_A', { transactionPinFailedAttempts: 2 });
        const result = await invokeMiddleware({ userId: 'USER_A' });
        assert.strictEqual(result.res.statusCode, 400);
        assert.match(result.res.body.message, /required/i);
        assert.strictEqual(account.transactionPinFailedAttempts, 2);
    });

    await test('J. malformed business request does not create a failed PIN attempt', async () => {
        const account = addAccount('USER_A');
        const result = await invokeMiddleware({
            userId: 'USER_A',
            pin: '1234',
            body: { qty: 'not-a-number' }
        });
        assert.strictEqual(result.nextCalled, true);
        assert.strictEqual(account.transactionPinFailedAttempts, 0);
    });

    await test('K. parallel wrong-PIN attempts cannot bypass threshold', async () => {
        const account = addAccount('USER_A');
        const outcomes = await Promise.all(Array.from({ length: 10 }, () =>
            verifyInvestmentPin('USER_A', '0000').then(
                () => 'success',
                error => error.code || error.message
            )
        ));
        assert.ok(!outcomes.includes('success'));
        assert.strictEqual(account.transactionPinFailedAttempts, MAX_FAILED_ATTEMPTS);
        assert.ok(account.transactionPinLockedUntil.getTime() > Date.now());
    });

    await test('L. rotating IP addresses cannot bypass account-bound protection', async () => {
        const account = addAccount('USER_A');
        for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt++) {
            await invokeMiddleware({
                userId: 'USER_A',
                pin: '0000',
                ip: `198.51.100.${attempt + 1}`
            });
        }
        assert.strictEqual(account.transactionPinFailedAttempts, MAX_FAILED_ATTEMPTS);
        assert.ok(account.transactionPinLockedUntil);
    });

    await test('M. different users maintain independent counters', async () => {
        const first = addAccount('USER_A');
        const second = addAccount('USER_B');
        await assert.rejects(() => verifyInvestmentPin('USER_A', '0000'));
        await assert.rejects(() => verifyInvestmentPin('USER_B', '0000'));
        assert.strictEqual(first.transactionPinFailedAttempts, 1);
        assert.strictEqual(second.transactionPinFailedAttempts, 1);
    });

    await test("N. one user's lock does not lock another user", async () => {
        addAccount('USER_A', {
            transactionPinFailedAttempts: MAX_FAILED_ATTEMPTS,
            transactionPinLockedUntil: new Date(Date.now() + LOCK_DURATION_MS)
        });
        addAccount('USER_B');
        await expectRejectedCode(() => verifyInvestmentPin('USER_A', '1234'), 'TRANSACTION_PIN_LOCKED');
        assert.strictEqual(await verifyInvestmentPin('USER_B', '1234'), true);
    });

    await test('O. transaction PIN is absent from logs and controlled errors', async () => {
        addAccount('USER_A');
        assert.strictEqual(User.schema.path('transactionPinFailedAttempts').options.select, false);
        assert.strictEqual(User.schema.path('transactionPinLockedUntil').options.select, false);
        const rawPin = '9876';
        const captured = [];
        const originalError = console.error;
        const originalLog = console.log;
        console.error = (...args) => captured.push(args.join(' '));
        console.log = (...args) => captured.push(args.join(' '));
        try {
            const result = await invokeMiddleware({ userId: 'USER_A', pin: rawPin });
            assert.strictEqual(result.res.statusCode, 400);
            assert.ok(!JSON.stringify(result.res.body).includes(rawPin));
        } finally {
            console.error = originalError;
            console.log = originalLog;
        }
        assert.ok(!captured.join('\n').includes(rawPin));
    });

    await test('P. H4 middleware remains on every investment mutation route', async () => {
        for (const routePath of ['/buy', '/exit', '/reinvest', '/redeem', '/withdraw']) {
            const layer = investmentRouter.stack.find(item => item.route?.path === routePath);
            const handlers = layer.route.stack.map(item => item.handle);
            const names = handlers.map(handler => handler.name);
            assert.ok(names.includes('requireTransactionPin'), routePath);
            assert.ok(handlers.includes(pinLimiter), `${routePath} must retain PIN IP defense`);
        }
    });

    await test('Q. generic withdrawal PIN implementation is not modified', async () => {
        const source = fs.readFileSync(path.join(__dirname, '../controllers/withdrawalController.js'), 'utf8');
        assert.match(source, /bcrypt\.compare\(pin, user\.transactionPin\)/);
    });

    await test('R. a correct request cannot clear a concurrently established lock', async () => {
        const account = addAccount('USER_A', { transactionPinFailedAttempts: MAX_FAILED_ATTEMPTS - 1 });
        let releaseCorrect;
        const correctWaiting = new Promise(resolve => { releaseCorrect = resolve; });
        let correctReachedCompare;
        const reachedCompare = new Promise(resolve => { correctReachedCompare = resolve; });
        bcrypt.compare = async (pin, hash) => {
            if (pin === '1234') {
                correctReachedCompare();
                await correctWaiting;
                return true;
            }
            return pin === hash.replace('HASH:', '');
        };

        const correct = verifyInvestmentPin('USER_A', '1234');
        await reachedCompare;
        await expectRejectedCode(() => verifyInvestmentPin('USER_A', '0000'), 'TRANSACTION_PIN_LOCKED');
        releaseCorrect();
        await expectRejectedCode(() => correct, 'TRANSACTION_PIN_LOCKED');
        assert.strictEqual(account.transactionPinFailedAttempts, MAX_FAILED_ATTEMPTS);
        assert.ok(account.transactionPinLockedUntil);
    });

    await test('S. non-investment verifier compatibility remains unchanged', async () => {
        const account = addAccount('USER_A', { transactionPinFailedAttempts: 2 });
        await assert.rejects(() => pinService.verifyPin('USER_A', '0000'), /Invalid transaction PIN/);
        assert.strictEqual(account.transactionPinFailedAttempts, 2);
        assert.strictEqual(account.transactionPinLockedUntil, null);
    });

    console.log('\n----------------------------------------------------');
    console.log(`BATCH 7A INVESTMENT PIN BRUTE FORCE: ${passed} PASSED, ${failed} FAILED.`);
    console.log('----------------------------------------------------');
    if (failed > 0) process.exitCode = 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    User.findOne = originals.findOne;
    User.findOneAndUpdate = originals.findOneAndUpdate;
    User.updateOne = originals.updateOne;
    bcrypt.compare = originals.compare;
});
