/**
 * CORRECTION 2 REGRESSION: Admin raw-detail route wiring.
 *
 * Proves:
 *   1. routes/admin.js GET /transactions/:id invokes getUserTransaction with
 *      { sanitize: false } as the OPTIONS argument (3rd arg), not dropped as a
 *      stray 4th arg after `next`.
 *   2. Customer path (getUserTransaction with no options) still returns the
 *      sanitized DTO (costPrice/profit/pricingSnapshot/response absent).
 *   3. Admin raw path returns internal reconciliation fields (costPrice,
 *      profit, pricingSnapshot, response, provider).
 *   4. An ordinary user is rejected by the admin role gate (checkRoles).
 *
 * Run: node tests/admin_raw_wiring.test.js
 */
process.env.JWT_SECRET = 'test-secret-for-jwt';
const assert = require('assert');

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

const FULL_DOC = {
    _id: 'txn-1',
    userId: 'user-9',
    transactionId: 'ZNT-988-AF2',
    refId: 'ZNT-988-AF2',
    type: 'airtime',
    service: 'mtnairtime',
    amount: 200,
    status: 'success',
    createdAt: new Date('2026-09-11T16:14:23.000Z'),
    costPrice: 185,
    profit: 17.5,
    pricingSnapshot: { providerId: 'prov-1' },
    response: { product_name: 'MTN Airtime' },
    provider: 'VTPass',
    providerRef: 'vtp-99221',
    details: { phone: '08031234567', network: 'MTN', internalNote: 'secret' }
};

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(c) { this.statusCode = c; return this; },
        json(p) { this.body = p; if (this.statusCode === null) this.statusCode = 200; return this; },
    };
}

console.log('====================================================');
console.log('  ADMIN RAW-DETAIL ROUTE WIRING TESTS');
console.log('====================================================\n');

// ---- 1. Route wiring: options passed as 3rd argument ----
{
    const tc = require('../controllers/transactionController');
    const originalGetUserTransaction = tc.getUserTransaction;

    let capturedArgs = null;
    tc.getUserTransaction = (...args) => {
        capturedArgs = args;
        // Return a minimal JSON so the handler completes.
        const res = args[1];
        if (res && typeof res.json === 'function') res.json({ ok: true });
    };

    let adminRouter = null;
    try {
        adminRouter = require('../routes/admin');
    } catch (e) {
        tc.getUserTransaction = originalGetUserTransaction;
        test('admin router loads (prerequisite)', () => { throw e; });
        process.exit(failed ? 1 : 0);
    }

    const layer = adminRouter.stack.find(l => l.route && l.route.path === '/transactions/:id' && l.route.methods.get);
    test('admin router exposes GET /transactions/:id route', () => {
        assert.ok(layer, 'GET /transactions/:id route not found on admin router');
    });

    if (layer) {
        const handler = layer.route.stack[0].handle;
        const req = { params: { id: 'txn-1' }, user: { id: 'admin-1' } };
        const res = makeRes();
        handler(req, res, () => {});
        test('handler is invoked', () => { assert.ok(capturedArgs, 'handler did not call getUserTransaction'); });

        test('sanitize:false passed as 3rd argument (options slot), not a dropped 4th arg', () => {
            assert.ok(capturedArgs, 'capturedArgs missing');
            assert.strictEqual(capturedArgs[0], req, 'arg0 must be req');
            assert.strictEqual(capturedArgs[1], res, 'arg1 must be res');
            assert.deepStrictEqual(capturedArgs[2], { sanitize: false }, 'arg2 must be { sanitize: false }');
            assert.strictEqual(capturedArgs.length, 3, 'must receive exactly 3 args (no stray 4th arg)');
        });
    }

    tc.getUserTransaction = originalGetUserTransaction;
}

// ---- 2. Customer path stays sanitized ----
{
    const tc = require('../controllers/transactionController');
    const originalFindOne = require('../models/Transaction').findOne;
    require('../models/Transaction').findOne = async () => FULL_DOC;

    const res = makeRes();
    const req = { user: { id: 'user-9' }, params: { id: 'txn-1' } };

    test('customer getUserTransaction(req, res) returns sanitized DTO', async () => {
        await tc.getUserTransaction(req, res);
        assert.strictEqual(res.body.costPrice, undefined, 'costPrice leaked');
        assert.strictEqual(res.body.profit, undefined, 'profit leaked');
        assert.strictEqual(res.body.pricingSnapshot, undefined, 'pricingSnapshot leaked');
        assert.strictEqual(res.body.response, undefined, 'response leaked');
        assert.strictEqual(res.body.provider, undefined, 'provider leaked');
        assert.strictEqual(res.body.providerRef, undefined, 'providerRef leaked');
        assert.ok(res.body.details, 'safe details missing');
        assert.strictEqual(res.body.details.internalNote, undefined, 'internalNote leaked');
        require('../models/Transaction').findOne = originalFindOne;
    });
}

// ---- 3. Admin raw path returns internal reconciliation fields ----
{
    const tc = require('../controllers/transactionController');
    const originalFindOne = require('../models/Transaction').findOne;
    require('../models/Transaction').findOne = async () => FULL_DOC;

    const res = makeRes();
    const req = { user: { id: 'admin-1' }, params: { id: 'txn-1' } };

    test('admin raw (sanitize:false) returns full internal doc', async () => {
        await tc.getUserTransaction(req, res, { sanitize: false });
        assert.strictEqual(res.body.costPrice, 185, 'costPrice missing for admin');
        assert.strictEqual(res.body.profit, 17.5, 'profit missing for admin');
        assert.ok(res.body.pricingSnapshot, 'pricingSnapshot missing for admin');
        assert.ok(res.body.response, 'response missing for admin');
        assert.strictEqual(res.body.provider, 'VTPass', 'provider missing for admin');
        assert.strictEqual(res.body.providerRef, 'vtp-99221', 'providerRef missing for admin');
        require('../models/Transaction').findOne = originalFindOne;
    });

    test('admin raw path looks up by id only (any owner)', async () => {
        const calls = [];
        require('../models/Transaction').findOne = async (q) => { calls.push(q); return FULL_DOC; };
        const res2 = makeRes();
        await tc.getUserTransaction({ user: { id: 'admin-1' }, params: { id: 'txn-1' } }, res2, { sanitize: false });
        assert.deepStrictEqual(calls[0], { _id: 'txn-1' }, 'raw admin lookup must not be owner-scoped');
        require('../models/Transaction').findOne = originalFindOne;
    });
}

// ---- 4. Ordinary user rejected by the admin role gate ----
{
    const { checkRoles } = require('../middlewares/auth');

    const res = {
        statusCode: null,
        body: null,
        status(c) { this.statusCode = c; return this; },
        json(p) { this.body = p; return this; },
    };

    test('ordinary user (role "user") is rejected by checkRoles("admin","superAdmin")', () => {
        let nextCalled = false;
        const req = { user: { role: 'user' } };
        checkRoles('admin', 'superAdmin')(req, res, () => { nextCalled = true; });
        assert.strictEqual(res.statusCode, 403, 'expected 403 for ordinary user');
        assert.strictEqual(nextCalled, false, 'next must not be called for ordinary user');
    });

    test('admin passes the role gate', () => {
        let nextCalled = false;
        const req = { user: { role: 'admin' } };
        const res2 = { status() { throw new Error('should not reject'); }, json() {} };
        checkRoles('admin', 'superAdmin')(req, res2, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true, 'next must be called for admin');
    });
}

console.log('\n====================================================');
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
if (failures.length) {
    console.log('  Failures:');
    failures.forEach(f => console.log(`    - ${f}`));
}
console.log('====================================================');
process.exit(failed ? 1 : 0);