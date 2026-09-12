/**
 * SECURITY REGRESSION TESTS
 * Privilege self-escalation prevention:
 *   - Ordinary users must NOT be able to self-set role/roles/accountType/status
 *     via the self-service profile update path.
 *   - Self-service registration must NEVER create privileged roles.
 *   - Admin role management requires superAdmin and validates ALLOWED_ROLES.
 *
 * Run: node tests/privilege_escalation.test.js
 */
process.env.JWT_SECRET = 'test-secret-for-jwt';
const assert = require('assert');
const axios = require('axios');

const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const Wallet = require('../models/Wallet');
const auditController = require('../controllers/auditController');
const notificationService = require('../services/notificationService');
const authController = require('../controllers/authController');
const adminController = require('../controllers/adminController');
const { checkRoles } = require('../middlewares/auth');

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------
function makeRes() {
    const res = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; if (this.statusCode === null) this.statusCode = 200; return this; },
        cookie() { return this; },
    };
    return res;
}

async function callUpdateUser(body, selfId = 'USER_1', paramId = 'USER_1') {
    let capturedUpdate = null;
    let capturedLog = null;
    const existingUser = {
        _id: selfId, name: 'Original Name', email: 'a@b.com', phone: '08000000000',
        role: 'user', roles: ['user'], isPhoneVerified: true, isPinSet: false,
    };
    User.findByIdAndUpdate = async (_id, update) => {
        capturedUpdate = update;
        return { ...existingUser, ...(update || {}) };
    };
    ActivityLog.create = async (d) => { capturedLog = d; return d; };

    const req = { user: { id: selfId }, params: { id: paramId }, body, ip: '127.0.0.1', headers: { 'user-agent': 'test-agent' } };
    const res = makeRes();
    await authController.updateUser(req, res);
    return { capturedUpdate, capturedLog, res };
}

function restoreUser(original) {
    User.findByIdAndUpdate = original;
}

// --------------------------------------------------------
// Runner (zero-dependency, matches repo test convention)
// --------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
    try {
        fn();
        console.log(`  [PASS] ${name}`);
        passed++;
    } catch (err) {
        console.error(`  [FAIL] ${name}`);
        console.error(`         ${err.message}`);
        failures.push(`${name}: ${err.message}`);
        failed++;
    }
}

(async function run() {
    console.log('====================================================');
    console.log('  PRIVILEGE ESCALATION PREVENTION TESTS');
    console.log('====================================================\n');

    const origFindByIdAndUpdate = User.findByIdAndUpdate;
    const origLogAction = auditController.logAction;
    const origNotifySuperAdmins = notificationService.notifySuperAdmins;
    const origAxiosPost = axios.post;

    try {
        console.log('--- Self-service profile update allowlist ---');

        // A. name update succeeds, only name written
        await (async () => {
            const out = await callUpdateUser({ name: 'Updated Name' });
            test('A. user updates name -> 200 and name written', () => {
                assert.strictEqual(out.res.statusCode, 200);
                assert.deepStrictEqual(out.capturedUpdate, { name: 'Updated Name' });
            });
        })();

        // B. role escalation attempt ignored
        await (async () => {
            const out = await callUpdateUser({ role: 'superAdmin' });
            test('B. user sends { role: "superAdmin" } -> role NOT written', () => {
                assert.strictEqual(out.res.statusCode, 200);
                assert.deepStrictEqual(out.capturedUpdate, {});
                assert.ok(!('role' in out.capturedUpdate), 'role must never reach update payload');
            });
            test('B2. attempted role is recorded in activity log', () => {
                assert.ok(Array.isArray(out.capturedLog.details.blockedFields));
                assert.ok(out.capturedLog.details.blockedFields.includes('role'));
            });
        })();

        // C. roles array escalation ignored
        await (async () => {
            const out = await callUpdateUser({ roles: ['superAdmin'] });
            test('C. user sends { roles: ["superAdmin"] } -> roles NOT written', () => {
                assert.strictEqual(out.res.statusCode, 200);
                assert.deepStrictEqual(out.capturedUpdate, {});
                assert.ok(!('roles' in out.capturedUpdate), 'roles must never reach update payload');
            });
            test('C2. attempted roles recorded in activity log', () => {
                assert.ok(out.capturedLog.details.blockedFields.includes('roles'));
            });
        })();

        // D. accountType cannot be self-set
        await (async () => {
            const out = await callUpdateUser({ accountType: 'reseller' });
            test('D. user sends { accountType: "reseller" } -> unchanged', () => {
                assert.strictEqual(out.res.statusCode, 200);
                assert.deepStrictEqual(out.capturedUpdate, {});
            });
        })();

        // E. status cannot be self-set
        await (async () => {
            const out = await callUpdateUser({ status: true });
            test('E. user sends { status: true } -> unchanged', () => {
                assert.strictEqual(out.res.statusCode, 200);
                assert.deepStrictEqual(out.capturedUpdate, {});
            });
        })();

        // F. mixed legitimate + malicious payload
        await (async () => {
            const out = await callUpdateUser({
                name: 'Updated Name',
                role: 'superAdmin',
                roles: ['admin'],
                status: true,
            });
            test('F. mixed payload -> name written, privileged fields dropped', () => {
                assert.strictEqual(out.res.statusCode, 200);
                assert.deepStrictEqual(out.capturedUpdate, { name: 'Updated Name' });
                assert.ok(!('role' in out.capturedUpdate));
                assert.ok(!('roles' in out.capturedUpdate));
                assert.ok(!('status' in out.capturedUpdate));
            });
            test('F2. all attempted privileged fields recorded', () => {
                const sorted = [...out.capturedLog.details.blockedFields].sort();
                assert.deepStrictEqual(sorted, ['role', 'roles', 'status']);
            });
        })();

        // Bonus: cannot update another user via self-service route
        await (async () => {
            const out = await callUpdateUser({ name: 'Hacker' }, 'USER_1', 'USER_2');
            test('Bonus. updating another user\'s id -> 403', () => {
                assert.strictEqual(out.res.statusCode, 403);
            });
        })();

        console.log('\n--- Registration hardening (self-escalation via signup) ---');

        // Phase 2: signup without a legal acceptance payload is rejected up front —
        // the server no longer trusts an unchecked "I agree" checkbox.
        await (async () => {
            User.findOne = async () => null;
            const resNoLegal = makeRes();
            await authController.register({
                body: {
                    name: 'Attacker',
                    email: 'attacker@example.com',
                    phone: '08099990000',
                    password: 'Passw0rd!',
                },
                ip: '127.0.0.1',
                headers: { 'user-agent': 'test-agent' },
            }, resNoLegal);
            test('Phase2. signup without legal acceptance payload -> 400 LEGAL_ACCEPTANCE_REQUIRED', () => {
                assert.strictEqual(resNoLegal.statusCode, 400);
                assert.strictEqual(resNoLegal.body.code, 'LEGAL_ACCEPTANCE_REQUIRED');
            });
        })();

        await (async () => {
            const mongoose = require('mongoose');
            const LegalAcceptance = require('../models/LegalAcceptance');
            const legalService = require('../services/legalDocument.service');

            let created = null;
            User.findOne = async () => null;
            User.create = async (data) => {
                const record = Array.isArray(data) ? data[0] : data;
                created = record;
                return [{ _id: 'U123', ...record, save: async () => {} }];
            };
            ActivityLog.create = async () => {};
            Wallet.create = async () => ({});
            LegalAcceptance.insertMany = async () => [];
            legalService.validateSignupAcceptances = async () => [];
            mongoose.startSession = async () => ({
                startTransaction() {},
                commitTransaction: async () => {},
                abortTransaction: async () => {},
                endSession() {}
            });
            axios.post = async () => { throw new Error('no network in test'); };

            const req = {
                body: {
                    name: 'Attacker',
                    email: 'attacker@example.com',
                    phone: '08012345678',
                    password: 'Passw0rd!',
                    role: 'superAdmin',
                    roles: ['admin', 'superAdmin'],
                },
                ip: '127.0.0.1',
                headers: { 'user-agent': 'test-agent' },
            };
            const res = makeRes();
            await authController.register(req, res);

            test('Register ignores client role/roles -> user created as plain "user"', () => {
                assert.ok(created, 'User.create should have been called');
                assert.strictEqual(created.role, 'user');
                assert.deepStrictEqual(created.roles, ['user']);
            });
            test('Register with role escalation attempt still succeeds (no crash)', () => {
                assert.strictEqual(res.statusCode, 200);
            });
        })();

        console.log('\n--- Admin role management path ---');

        // G. superAdmin changes a user's role -> success + ROLE_CHANGE audit log
        await (async () => {
            let capturedUpdate = null;
            const auditLogs = [];
            User.findById = async () => ({ _id: 'U1', role: 'user', name: 'Jane', phone: '0801', status: true });
            User.findByIdAndUpdate = async (_id, update) => { capturedUpdate = update; return { _id: 'U1', ...update, name: 'Jane', phone: '0801', status: true }; };
            auditController.logAction = async (...args) => { auditLogs.push(args); };
            notificationService.notifySuperAdmins = async () => {};

            const req = {
                user: { id: 'ADMIN1', name: 'Boss', role: 'superAdmin', roles: ['superAdmin'] },
                params: { id: 'U1' },
                body: { role: 'agent' },
                ip: '127.0.0.1',
                headers: { 'user-agent': 'test-agent' },
            };
            const res = makeRes();
            await adminController.updateUserRole(req, res);

            test('G. superAdmin changes role -> success, role written', () => {
                assert.strictEqual(res.statusCode, 200);
                assert.deepStrictEqual(capturedUpdate, { role: 'agent' });
            });
            test('G2. ROLE_CHANGE audit log recorded with old/new role', () => {
                const rc = auditLogs.find(l => l[2] === 'ROLE_CHANGE');
                assert.ok(rc, 'ROLE_CHANGE log must exist');
                assert.strictEqual(rc[4].oldRole, 'user');
                assert.strictEqual(rc[4].newRole, 'agent');
            });
        })();

        // H. invalid role on admin endpoint -> 400
        await (async () => {
            User.findById = async () => ({ _id: 'U1', role: 'user', name: 'Jane', phone: '0801', status: true });
            const req = {
                user: { id: 'ADMIN1', name: 'Boss', role: 'superAdmin', roles: ['superAdmin'] },
                params: { id: 'U1' },
                body: { role: 'root' },
                ip: '127.0.0.1',
                headers: { 'user-agent': 'test-agent' },
            };
            const res = makeRes();
            await adminController.updateUserRole(req, res);

            test('H. invalid admin role "root" -> 400', () => {
                assert.strictEqual(res.statusCode, 400);
                assert.ok(/invalid role/i.test(res.body.message));
            });
        })();

        // I. authorization middleware: ordinary user blocked, superAdmin allowed
        await (async () => {
            let nextCalled = false;
            const userReq = { user: { id: 'X', role: 'user', roles: ['user'] } };
            const userRes = makeRes();
            const next = () => { nextCalled = true; };
            checkRoles('superAdmin')(userReq, userRes, next);
            test('I. ordinary user hits admin role route -> 403, next NOT called', () => {
                assert.strictEqual(userRes.statusCode, 403);
                assert.strictEqual(nextCalled, false);
            });

            let nextCalled2 = false;
            checkRoles('admin', 'superAdmin')(userReq, userRes, () => { nextCalled2 = true; });
            test('I2. ordinary user blocked by router-level admin guard -> 403', () => {
                assert.strictEqual(userRes.statusCode, 403);
                assert.strictEqual(nextCalled2, false);
            });

            const adminReq = { user: { id: 'A', role: 'superAdmin', roles: ['superAdmin'] } };
            const adminRes = makeRes();
            let adminNext = false;
            checkRoles('superAdmin')(adminReq, adminRes, () => { adminNext = true; });
            test('I3. superAdmin passes admin guard -> next called', () => {
                assert.strictEqual(adminRes.statusCode, null);
                assert.strictEqual(adminNext, true);
            });
        })();

        // Ensure order of user writes: no privileged key survived ANY update payload
        await (async () => {
            const out = await callUpdateUser({ phone: '08123456789', role: 'superAdmin', roles: ['agent'], accountType: 'reseller', status: true });
            test('J. combined sensitive keys never appear in DB write', () => {
                for (const k of ['role', 'roles', 'accountType', 'status']) {
                    assert.ok(!(k in out.capturedUpdate), `${k} leaked into update payload`);
                }
                assert.deepStrictEqual(Object.keys(out.capturedUpdate), ['phone']);
            });
        })();
    } finally {
        User.findByIdAndUpdate = origFindByIdAndUpdate;
        User.findById = User.findByIdAndUpdate;
        User.findOne = User.findByIdAndUpdate;
        User.create = User.findByIdAndUpdate;
        Wallet.create = async () => ({});
        ActivityLog.create = async () => {};
        auditController.logAction = origLogAction;
        notificationService.notifySuperAdmins = origNotifySuperAdmins;
        axios.post = origAxiosPost;
    }

    console.log('\n====================================================');
    console.log(`  RESULT: ${passed} passed, ${failed} failed`);
    if (failures.length) {
        console.log('  Failures:');
        failures.forEach(f => console.log(`    - ${f}`));
    }
    console.log('====================================================');
    process.exit(failed ? 1 : 0);
})().catch(err => {
    console.error('Test suite crashed:', err);
    process.exit(1);
});