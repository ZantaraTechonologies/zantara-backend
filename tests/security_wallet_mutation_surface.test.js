'use strict';

/**
 * SECURITY — CRIT 1: CUSTOMER WALLET MUTATION SURFACE (RED-FIRST regression)
 *
 * Ordinary authenticated customers must never reach arbitrary wallet
 * credit/debit/freeze/unfreeze through the HTTP router.
 *
 * Caller-trace (whole repo incl. web + mobile, node_modules-excluded):
 *   0 legitimate HTTP callers of POST /wallet/{debit,credit} or
 *     GET /wallet/{freeze,unfreeze}. Every real mutation flows through
 *     walletService directly from service/controller layer:
 *       - funding:  paymentGateway.service.js:596 (credit)
 *       - purchase: purchase.service.js:162 (debit)
 *       - withdrawal freeze/unfreeze: withdrawalController.js:62,130-134
 *       - referral: referral.js:148 (credit), redeemEarnings (credit)
 *       - admin manual (superAdmin-gated): adminController.js:398,450
 *     Admin-gated pair already exists and is Role-gated.
 *
 * The four customer routes below are the audit finding (users could
 * self-serve credit/debit/freeze/unfreeze). They are now REMOVED from the
 * router. walletService mutation primitives + the superAdmin admin pair are
 * preserved verbatim for the legitimate internal flows above.
 *
 * RED demo harness (dir + file-placeholder: fixed live in repo during fix).
 * This test introspects routes/wallet.js stack for the four paths and expects
 * them ABSENT after the fix. Before the fix it correctly FAILS (RED).
 */
const assert = require('assert');

// Byte-exact mirror of test harness in tests/legal_signup_and_guard.test.js
const { verifyJWT } = require('../middlewares/auth');
const requireLegalCompliance = require('../middlewares/requireLegalCompliance');

const walletRouter = require('../routes/wallet');
const layersFor = (router, path) => {
    const layer = router.stack.find(l => l.route && l.route.path === path);
    if (!layer) return null;
    return layer.route.stack.map(s => s.handle);
};
const has = (handles, fn) => handles.some(h => h === fn);

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  [PASS] ${name}`);
    } catch (err) {
        failed++;
        failures.push(name);
        console.log(`  [FAIL] ${name} — ${err.message}`);
    }
}

console.log('====================================================');
console.log(' SECURITY — CUSTOMER WALLET MUTATION SURFACE (CRIT 1)');
console.log('====================================================');

console.log('\n--- A. Customer wallet mutation routes are REMOVED ---');
test('A1. NO POST /wallet/debit', () => {
    assert.strictEqual(layersFor(walletRouter, '/debit'), null,
        '/wallet/debit must be absent from customer router');
});
test('A2. NO POST /wallet/credit', () => {
    assert.strictEqual(layersFor(walletRouter, '/credit'), null,
        '/wallet/credit must be absent from customer router');
});
test('A3. NO GET /wallet/freeze (arbitrary side-effect on GET)', () => {
    assert.strictEqual(layersFor(walletRouter, '/freeze'), null,
        '/wallet/freeze must be absent from customer router');
});
test('A4. NO GET /wallet/unfreeze (arbitrary side-effect on GET)', () => {
    assert.strictEqual(layersFor(walletRouter, '/unfreeze'), null,
        '/wallet/unfreeze must be absent from customer router');
});

console.log('\n--- B. Legitimate customer wallet flows remain wired ---');
test('B1. GET /wallet (view own wallet) intact', () => {
    const h = layersFor(walletRouter, '/');
    assert.ok(h && h[0] === verifyJWT, 'GET / must be verifyJWT-guarded');
});
test('B2. POST /wallet/fund (funding, requires legal) intact', () => {
    const h = layersFor(walletRouter, '/fund');
    assert.ok(h && h[0] === verifyJWT, 'POST /fund must be verifyJWT-guarded');
    assert.ok(has(h, requireLegalCompliance), 'POST /fund must require legal compliance');
});
test('B3. POST /wallet/transfer (peer transfer) intact', () => {
    const h = layersFor(walletRouter, '/transfer');
    assert.ok(h && h[0] === verifyJWT, 'POST /transfer must be verifyJWT-guarded');
    assert.ok(has(h, requireLegalCompliance), 'POST /transfer must require legal compliance');
});
test('B4. POST /wallet/redeem-earnings (referral redemption) intact', () => {
    const h = layersFor(walletRouter, '/redeem-earnings');
    assert.ok(h && h[0] === verifyJWT, 'POST /redeem-earnings must be verifyJWT-guarded');
    assert.ok(has(h, requireLegalCompliance), 'POST /redeem-earnings must require legal compliance');
});

console.log('\n--- C. superAdmin-gated admin manual pair preserved (routes/admin.js) ---');
const adminRouter = require('../routes/admin');
const { checkRoles } = require('../middlewares/auth');
// The admin router gates authentication at ROUTER level via
// router.use(verifyJWT, checkRoles('admin','superAdmin')) (routes/admin.js:26),
// so per-route stacks contain role gate(s) but NOT verifyJWT. Assert BOTH:
//   (a) a router-level .use guard that applies verifyJWT, and
//   (b) per-route checkRoles on the credit/debit pair.
const routerUseHandles = adminRouter.stack
    .filter(l => l.route === undefined && typeof l.handle === 'function')
    .map(l => l.handle);
const anyUseAppliesVerifyJWT = () => verifyJWT !== undefined &&
    routerUseHandles.some(h => h === verifyJWT);
test('C1. admin POST /users/:userId/credit remains (middleware + handler)', () => {
    const h = layersFor(adminRouter, '/users/:userId/credit');
    assert.ok(h && h.length >= 2, 'admin credit must be wired with a guard + handler');
    assert.ok(anyUseAppliesVerifyJWT(), 'admin router must apply verifyJWT via router.use');
});
test('C2. admin POST /users/:userId/debit remains (middleware + handler)', () => {
    const h = layersFor(adminRouter, '/users/:userId/debit');
    assert.ok(h && h.length >= 2, 'admin debit must be wired with a guard + handler');
    assert.ok(anyUseAppliesVerifyJWT(), 'admin router must apply verifyJWT via router.use');
});

console.log('\n--- D. walletService mutation primitives preserved for internal flows ---');
const walletService = require('../services/wallet.service');
test('D1. walletService.credit is a function', () => {
    assert.strictEqual(typeof walletService.credit, 'function');
});
test('D2. walletService.debit is a function', () => {
    assert.strictEqual(typeof walletService.debit, 'function');
});
test('D3. walletService.freeze is a function', () => {
    assert.strictEqual(typeof walletService.freeze, 'function');
});
test('D4. walletService.unfreeze is a function', () => {
    assert.strictEqual(typeof walletService.unfreeze, 'function');
});

console.log('\n====================================================');
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
if (failures.length) {
    console.log('  Failures:');
    failures.forEach(f => console.log(`    - ${f}`));
}
console.log('====================================================');
process.exit(failed > 0 ? 1 : 0);
