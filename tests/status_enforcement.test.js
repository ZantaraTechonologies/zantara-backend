'use strict';

/**
 * CRIT 2 — ACCOUNT STATUS ENFORCEMENT (RED-FIRST regression)
 *
 * Vulnerability: models/User.js:20 defines status: { type: Boolean, default: false },
 * but NOTHING enforces it:
 *   - controllers/authController.js:195 login() mints a token after password
 *     match without checking user.status — a disabled (status:false) account
 *     can log in.
 *   - middlewares/auth.js:3 verifyJWT() trusts the JWT payload only and never
 *     checks the user's live DB status — an existing token for a disabled
 *     account keeps working forever.
 *
 * Fix (minimal, no schema change):
 *   - login: after password match, reject status:false with 401.
 *   - verifyJWT: after jwt.verify, load the user and reject status:false / missing.
 *
 * Mirrors conventions in tests/financial_atomicity.test.js and
 * tests/refund_idempotency.test.js (mock state, restore originals, exit 1 on failure).
 */

const assert = require('assert');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const { verifyJWT } = require('../middlewares/auth');
const { generateAccessToken } = require('../utils/authTokens');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'status-enforcement-test-secret';

async function runStatusEnforcementTests() {
    console.log('=====================================================');
    console.log(' CRIT 2 — ACCOUNT STATUS ENFORCEMENT                 ');
    console.log('=====================================================\n');

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
    let mockUsers = [];

    const origUserFindById = User.findById;

    function makeRes() {
        const res = { statusCode: null, body: null, cookies: {} };
        res.status = function (code) { this.statusCode = code; return this; };
        res.json = function (body) { this.body = body; return this; };
        res.cookie = function (name, value) { this.cookies[name] = value; return this; };
        res.clearCookie = function () { return this; };
        return res;
    }

    function resetMocks() {
        mockUsers = [];
        User.findById = (id) => {
            const found = mockUsers.find(u => String(u._id) === String(id) || u._id === id) || null;
            return { select: async () => found };
        };
    }

    resetMocks();

    const signToken = (id, role) => generateAccessToken({
        _id: id,
        role,
        roles: [role],
        authVersion: 0
    }, '1h');
    const cookies = (token) => ({ token });

    // ─── SECTION A: verifyJWT must enforce user.status from the DB ──

    await test('A1. verifyJWT: active user passes through to next()', async () => {
        resetMocks();
        const userId = 'user-active-1';
        mockUsers.push({ _id: userId, status: true, role: 'user', roles: ['user'] });

        const token = signToken(userId, 'user');
        const req = { cookies: cookies(token) };
        const res = makeRes();
        let nextCalled = false;

        // verifyJWT will now be async (user lookup); await it via a promise
        await new Promise((resolve, reject) => {
            const next = () => { nextCalled = true; resolve(); };
            try {
                const r = verifyJWT(req, res, next);
                if (r && typeof r.then === 'function') r.then(() => resolve(), reject);
                else if (nextCalled) resolve();
                else if (res.statusCode) resolve();
                else resolve();
            } catch (e) { reject(e); }
        });

        assert.strictEqual(res.statusCode, null, 'Should not respond with error status');
        assert.strictEqual(nextCalled, true, 'Active user must be allowed through');
        assert.strictEqual(req.user.id, userId);
    });

    await test('A2. verifyJWT: disabled (status:false) user is REJECTED', async () => {
        resetMocks();
        const userId = 'user-disabled-1';
        mockUsers.push({ _id: userId, status: false, role: 'user', roles: ['user'] });

        const token = signToken(userId, 'user');
        const req = { cookies: cookies(token) };
        const res = makeRes();
        let nextCalled = false;

        await new Promise((resolve) => {
            const next = () => { nextCalled = true; };
            try {
                const r = verifyJWT(req, res, next);
                if (r && typeof r.then === 'function') r.then(() => resolve(), () => resolve());
                else resolve();
            } catch (e) { resolve(); }
        });

        assert.strictEqual(nextCalled, false,
            'CRIT 2 BUG: disabled user must NOT pass verifyJWT');
        assert.ok(res.statusCode === 401 || res.statusCode === 403,
            `Disabled user must be rejected with 401/403, got ${res.statusCode}`);
    });

    await test('A3. verifyJWT: non-existent user (deleted) is REJECTED', async () => {
        resetMocks();
        const userId = 'user-gone-1';
        const token = signToken(userId, 'user');
        const req = { cookies: cookies(token) };
        const res = makeRes();
        let nextCalled = false;

        await new Promise((resolve) => {
            const next = () => { nextCalled = true; };
            try {
                const r = verifyJWT(req, res, next);
                if (r && typeof r.then === 'function') r.then(() => resolve(), () => resolve());
                else resolve();
            } catch (e) { resolve(); }
        });

        assert.strictEqual(nextCalled, false,
            'CRIT 2 BUG: deleted user must NOT pass verifyJWT');
        assert.ok(res.statusCode === 401 || res.statusCode === 403,
            `Deleted user must be rejected with 401/403, got ${res.statusCode}`);
    });

    await test('A4. verifyJWT: invalid signature still rejected (unchanged behavior)', async () => {
        resetMocks();
        const badToken = jwt.sign({ id: 'x', role: 'user', roles: ['user'] }, 'WRONG_SECRET');
        const req = { cookies: cookies(badToken) };
        const res = makeRes();
        let nextCalled = false;

        await new Promise((resolve) => {
            const next = () => { nextCalled = true; };
            try {
                const r = verifyJWT(req, res, next);
                if (r && typeof r.then === 'function') r.then(() => resolve(), () => resolve());
                else resolve();
            } catch (e) { resolve(); }
        });

        assert.strictEqual(nextCalled, false);
        assert.ok(res.statusCode === 401 || res.statusCode === 403);
    });

    await test('A5. verifyJWT: no token still rejected (unchanged behavior)', async () => {
        resetMocks();
        const req = { cookies: {}, headers: {} };
        const res = makeRes();
        let nextCalled = false;
        verifyJWT(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(res.statusCode, 401);
    });

    // ─── SECTION B: login must reject disabled users ──

    await test('B1. login: disabled (status:false) user is REJECTED with 401 and no token minted', async () => {
        resetMocks();
        const userId = 'user-disabled-login';
        mockUsers.push({
            _id: userId, phone: '08011111111', name: 'Disabled', status: false,
            role: 'user', roles: ['user'], isPhoneVerified: true, isPinSet: false,
            save: async function () { return this; }
        });

        // Mock only the DB + non-destructured deps (ActivityLog is a class/
        // model required as a whole, notificationService as a whole). sendToken
        // is destructured inside authController at require-time, so we let the
        // REAL sendToken run and assert on res.statusCode / cookies instead.
        const origUserFindOne = User.findOne || null;
        const origCompare = require('bcryptjs').compare;
        const origActivityCreate = require('../models/ActivityLog').create;
        const origSendInApp = require('../services/notification.service').sendInApp;

        User.findOne = () => ({ ...mockUsers[0], select: async function () { return this; } });
        require('bcryptjs').compare = async () => true; // password matches
        require('../models/ActivityLog').create = async () => ({});
        require('../services/notification.service').sendInApp = async () => {};

        const authController = require('../controllers/authController');
        const res = makeRes();
        await authController.login({
            body: { identifier: '08011111111', password: 'anything' },
            headers: {},
            ip: '127.0.0.1'
        }, res);

        assert.strictEqual(res.statusCode, 401,
            `Disabled user login must return 401, got ${res.statusCode}`);
        assert.ok(!res.cookies.token,
            'CRIT 2 BUG: disabled user must NOT receive a token');
        assert.ok(res.body && res.body.message,
            'Must return an error message');

        // Restore
        if (origUserFindOne) User.findOne = origUserFindOne;
        require('bcryptjs').compare = origCompare;
        require('../models/ActivityLog').create = origActivityCreate;
        require('../services/notification.service').sendInApp = origSendInApp;
    });

    await test('B2. login: active (status:true) user is allowed (unchanged behavior)', async () => {
        resetMocks();
        const userId = 'user-active-login';
        mockUsers.push({
            _id: userId, phone: '08022222222', name: 'Active', status: true,
            role: 'user', roles: ['user'], isPhoneVerified: true, isPinSet: false,
            myReferralCode: 'ACT001', email: 'a@b.com',
            save: async function () { return this; }
        });

        const origUserFindOne = User.findOne || null;
        const origCompare = require('bcryptjs').compare;
        const origActivityCreate = require('../models/ActivityLog').create;
        const origSendInApp = require('../services/notification.service').sendInApp;

        User.findOne = () => ({ ...mockUsers[0], select: async function () { return this; } });
        require('bcryptjs').compare = async () => true;
        require('../models/ActivityLog').create = async () => ({});
        require('../services/notification.service').sendInApp = async () => {};

        const authController = require('../controllers/authController');
        const res = makeRes();
        await authController.login({
            body: { identifier: '08022222222', password: 'anything' },
            headers: {},
            ip: '127.0.0.1'
        }, res);

        assert.strictEqual(res.statusCode, 200,
            `Active user login must succeed with 200, got ${res.statusCode}`);
        assert.ok(res.cookies.token, 'Active user must receive a token');

        if (origUserFindOne) User.findOne = origUserFindOne;
        require('bcryptjs').compare = origCompare;
        require('../models/ActivityLog').create = origActivityCreate;
        require('../services/notification.service').sendInApp = origSendInApp;
    });

    // ─── SECTION C: verifyJWT must hydrate req.user with CURRENT DB roles ──

    await test('C1. verifyJWT hydrates req.user.roles from the live DB, not stale token claims', async () => {
        resetMocks();
        const userId = 'user-compat-1';
        // DB says admin now — the token was minted while the user was 'user'.
        mockUsers.push({ _id: userId, status: true, role: 'admin', roles: ['admin'] });

        const token = signToken(userId, 'user');
        const req = { cookies: cookies(token) };
        const res = makeRes();
        let nextCalled = false;

        await new Promise((resolve, reject) => {
            const next = () => { nextCalled = true; resolve(); };
            try {
                const r = verifyJWT(req, res, next);
                if (r && typeof r.then === 'function') r.then(() => resolve(), reject);
                else if (nextCalled) resolve();
                else resolve();
            } catch (e) { reject(e); }
        });

        assert.strictEqual(nextCalled, true, 'active user must pass through');
        assert.strictEqual(req.user.id, userId, 'identity id preserved from the token');
        assert.deepStrictEqual(req.user.roles, ['admin'],
            'CRIT 2: role checks must use the current DB roles, not stale token claims');
        assert.strictEqual(req.user.role, 'admin', 'singular DB role must also be hydrated');
        assert.strictEqual(req.user.status, true, 'live DB status hydrated onto req.user');
    });

    await test('C2. JWT superAdmin + DB user with no roles → NO superAdmin (fail-closed)', async () => {
        resetMocks();
        const userId = 'user-compat-2';
        mockUsers.push({ _id: userId, status: true }); // no role/roles on DB doc

        const token = signToken(userId, 'superAdmin');
        const req = { cookies: cookies(token) };
        const res = makeRes();
        let nextCalled = false;

        await new Promise((resolve, reject) => {
            const next = () => { nextCalled = true; resolve(); };
            try {
                const r = verifyJWT(req, res, next);
                if (r && typeof r.then === 'function') r.then(() => resolve(), reject);
                else if (nextCalled) resolve();
                else resolve();
            } catch (e) { reject(e); }
        });

        assert.strictEqual(nextCalled, true, 'active user must pass through');
        assert.deepStrictEqual(req.user.roles, [],
            'DB has no roles → empty array; old JWT superAdmin must NOT be resurrected');
        assert.strictEqual(req.user.role, null,
            'DB has no role → null; old JWT role must NOT be resurrected');
    });

    await test('C3. JWT admin + DB empty roles → NO admin (fail-closed)', async () => {
        resetMocks();
        const userId = 'user-compat-3';
        mockUsers.push({ _id: userId, status: true, roles: [], role: null }); // explicitly empty

        const token = signToken(userId, 'admin');
        const req = { cookies: cookies(token) };
        const res = makeRes();
        let nextCalled = false;

        await new Promise((resolve, reject) => {
            const next = () => { nextCalled = true; resolve(); };
            try {
                const r = verifyJWT(req, res, next);
                if (r && typeof r.then === 'function') r.then(() => resolve(), reject);
                else if (nextCalled) resolve();
                else resolve();
            } catch (e) { reject(e); }
        });

        assert.strictEqual(nextCalled, true, 'active user must pass through');
        assert.deepStrictEqual(req.user.roles, [],
            'DB has empty roles → must stay empty; old JWT admin must NOT leak');
    });

    await test('C4. JWT user + DB admin → DB admin recognized', async () => {
        resetMocks();
        const userId = 'user-compat-4';
        mockUsers.push({ _id: userId, status: true, role: 'admin', roles: ['admin'] });

        const token = signToken(userId, 'user'); // old token
        const req = { cookies: cookies(token) };
        const res = makeRes();
        let nextCalled = false;

        await new Promise((resolve, reject) => {
            const next = () => { nextCalled = true; resolve(); };
            try {
                const r = verifyJWT(req, res, next);
                if (r && typeof r.then === 'function') r.then(() => resolve(), reject);
                else if (nextCalled) resolve();
                else resolve();
            } catch (e) { reject(e); }
        });

        assert.strictEqual(nextCalled, true);
        assert.deepStrictEqual(req.user.roles, ['admin'],
            'current DB role must be authoritative');
        assert.strictEqual(req.user.role, 'admin');
    });

    await test('C5. JWT superAdmin + DB ordinary user → ordinary user only', async () => {
        resetMocks();
        const userId = 'user-compat-5';
        mockUsers.push({ _id: userId, status: true, role: 'user', roles: ['user'] });

        const token = signToken(userId, 'superAdmin');
        const req = { cookies: cookies(token) };
        const res = makeRes();
        let nextCalled = false;

        await new Promise((resolve, reject) => {
            const next = () => { nextCalled = true; resolve(); };
            try {
                const r = verifyJWT(req, res, next);
                if (r && typeof r.then === 'function') r.then(() => resolve(), reject);
                else if (nextCalled) resolve();
                else resolve();
            } catch (e) { reject(e); }
        });

        assert.strictEqual(nextCalled, true);
        assert.deepStrictEqual(req.user.roles, ['user'],
            'DB user role must override stale JWT superAdmin');
        assert.strictEqual(req.user.role, 'user');
    });

    await test('C6. disabled DB user + JWT superAdmin → blocked', async () => {
        resetMocks();
        const userId = 'user-compat-6';
        mockUsers.push({ _id: userId, status: false, role: 'admin', roles: ['admin'] });

        const token = signToken(userId, 'superAdmin');
        const req = { cookies: cookies(token) };
        const res = makeRes();
        let nextCalled = false;

        await new Promise((resolve) => {
            const next = () => { nextCalled = true; };
            try {
                const r = verifyJWT(req, res, next);
                if (r && typeof r.then === 'function') r.then(() => resolve(), () => resolve());
                else resolve();
            } catch (e) { resolve(); }
        });

        assert.strictEqual(nextCalled, false, 'disabled user must be blocked');
        assert.ok(res.statusCode === 401 || res.statusCode === 403);
    });

    await test('C7. deleted DB user + JWT superAdmin → blocked', async () => {
        resetMocks();
        // No user in mockUsers → findById returns null

        const token = signToken('user-nonexistent', 'superAdmin');
        const req = { cookies: cookies(token) };
        const res = makeRes();
        let nextCalled = false;

        await new Promise((resolve) => {
            const next = () => { nextCalled = true; };
            try {
                const r = verifyJWT(req, res, next);
                if (r && typeof r.then === 'function') r.then(() => resolve(), () => resolve());
                else resolve();
            } catch (e) { resolve(); }
        });

        assert.strictEqual(nextCalled, false, 'deleted user must be blocked');
        assert.ok(res.statusCode === 401 || res.statusCode === 403);
    });

    // ─── RESTORE ───────────────────────────────────────────────────────────────
    User.findById = origUserFindById;

    // ─── SUMMARY ───────────────────────────────────────────────────────────────
    console.log('\n-----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('-----------------------------------------------------\n');

    process.exit(failed > 0 ? 1 : 0);
}

runStatusEnforcementTests().catch(err => {
    console.error('[FATAL TEST ERROR]', err);
    process.exit(1);
});