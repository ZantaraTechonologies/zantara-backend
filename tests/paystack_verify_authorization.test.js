'use strict';

const assert = require('assert');

const TransactionStatus = require('../models/TransactionStatus');
const paymentGatewayService = require('../services/paymentGateway.service');
const { verifyTransaction } = require('../controllers/paystackController');
const { verifyFunding: verifyWalletFunding } = require('../controllers/walletFundingController');
const paystackRouter = require('../routes/paystack');

async function runPaystackVerifyAuthorizationTests() {
    console.log('==========================================================');
    console.log(' LEGACY PAYMENT VERIFICATION AUTHORIZATION TEST SUITE');
    console.log('==========================================================\n');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`[PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`[FAIL] ${name}`);
            console.error(`       ${err.message}`);
            failed++;
        }
    }

    const originalFindOne = TransactionStatus.findOne;
    const originalVerifyFunding = paymentGatewayService.verifyFunding;

    let rows = [];
    let verifyCalls = [];
    let serviceResultFor = () => ({ status: 'pending', type: 'funding' });

    function reset({ records = [], resultFor } = {}) {
        rows = records.map(row => ({ ...row }));
        verifyCalls = [];
        serviceResultFor = resultFor || (() => ({ status: 'pending', type: 'funding' }));

        TransactionStatus.findOne = async query => {
            return rows.find(row => {
                if (String(row.refId) !== String(query.refId)) return false;
                if (Object.prototype.hasOwnProperty.call(query, 'userId')) {
                    return row.userId != null && String(row.userId) === String(query.userId);
                }
                return true;
            }) || null;
        };

        paymentGatewayService.verifyFunding = async reference => {
            verifyCalls.push(reference);
            return serviceResultFor(reference);
        };
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

    async function callLegacy({ reference, userId, role = 'user', roles = [] }) {
        const req = {
            params: { reference },
            user: { id: userId, role, roles }
        };
        const res = makeResponse();
        await verifyTransaction(req, res);
        return res;
    }

    async function callWallet({ reference, userId, role = 'user', roles = [] }) {
        const req = {
            query: { reference },
            user: { id: userId, role, roles }
        };
        const res = makeResponse();
        await verifyWalletFunding(req, res);
        return res;
    }

    try {
        await test('R1. Anonymous caller is rejected by legacy route authentication', async () => {
            const routeLayer = paystackRouter.stack.find(layer => layer.route && layer.route.path === '/verify/:reference');
            assert.ok(routeLayer, 'legacy verification route must be registered');
            assert.ok(routeLayer.route.stack.length >= 2, 'route must have authentication before its controller');

            const req = { cookies: {}, headers: {} };
            const res = makeResponse();
            let nextCalled = false;
            await routeLayer.route.stack[0].handle(req, res, () => { nextCalled = true; });

            assert.strictEqual(res.statusCode, 401);
            assert.deepStrictEqual(res.body, { message: 'Not authenticated' });
            assert.strictEqual(nextCalled, false);
        });

        await test('R2. User A can verify User A reference through the legacy endpoint', async () => {
            reset({
                records: [{ refId: 'RA', userId: 'user-A', status: 'pending', type: 'funding' }],
                resultFor: () => ({ status: 'success', type: 'funding' })
            });

            const res = await callLegacy({ reference: 'RA', userId: 'user-A' });
            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body, { success: true, status: 'success', type: 'funding' });
            assert.deepStrictEqual(verifyCalls, ['RA']);
        });

        await test('R3. User B receives generic 404 for User A reference', async () => {
            reset({ records: [{ refId: 'RA', userId: 'user-A', status: 'pending', type: 'funding' }] });

            const res = await callLegacy({ reference: 'RA', userId: 'user-B' });
            assert.strictEqual(res.statusCode, 404);
            assert.deepStrictEqual(res.body, { success: false, status: 'not_found' });
        });

        await test('R4. Legacy ownership rejection happens before verifyFunding', async () => {
            reset({ records: [{ refId: 'RA', userId: 'user-A', status: 'pending', type: 'funding' }] });

            await callLegacy({ reference: 'RA', userId: 'user-B' });
            assert.strictEqual(verifyCalls.length, 0, 'verifyFunding must not run after ownership failure');
        });

        await test('R5. Admin has no role-based cross-customer bypass on legacy endpoint', async () => {
            reset({ records: [{ refId: 'RA', userId: 'user-A', status: 'pending', type: 'funding' }] });

            const res = await callLegacy({ reference: 'RA', userId: 'admin-B', role: 'admin', roles: ['admin'] });
            assert.strictEqual(res.statusCode, 404);
            assert.deepStrictEqual(res.body, { success: false, status: 'not_found' });
            assert.strictEqual(verifyCalls.length, 0);
        });

        await test('R6. SuperAdmin has no role-based cross-customer bypass on legacy endpoint', async () => {
            reset({ records: [{ refId: 'RA', userId: 'user-A', status: 'pending', type: 'funding' }] });

            const res = await callLegacy({ reference: 'RA', userId: 'super-B', role: 'superAdmin', roles: ['superAdmin'] });
            assert.strictEqual(res.statusCode, 404);
            assert.deepStrictEqual(res.body, { success: false, status: 'not_found' });
            assert.strictEqual(verifyCalls.length, 0);
        });

        await test('R7. Ownerless legacy TransactionStatus fails closed', async () => {
            reset({ records: [{ refId: 'RA', status: 'pending', type: 'funding' }] });

            const res = await callLegacy({ reference: 'RA', userId: 'user-A' });
            assert.strictEqual(res.statusCode, 404);
            assert.deepStrictEqual(res.body, { success: false, status: 'not_found' });
            assert.strictEqual(verifyCalls.length, 0);
        });

        await test('R8. Legacy unknown and non-owner references are externally equivalent', async () => {
            reset({
                records: [{ refId: 'RA', userId: 'user-A', status: 'pending', type: 'funding' }],
                resultFor: reference => reference === 'RA'
                    ? { status: 'pending', type: 'funding' }
                    : { status: 'not_found' }
            });

            const nonOwner = await callLegacy({ reference: 'RA', userId: 'user-B' });
            const unknown = await callLegacy({ reference: 'RX', userId: 'user-B' });
            assert.strictEqual(nonOwner.statusCode, unknown.statusCode);
            assert.deepStrictEqual(nonOwner.body, unknown.body);
            assert.strictEqual(verifyCalls.length, 0);
        });

        await test('R9. Legitimate pending legacy owner delegates exactly once', async () => {
            reset({
                records: [{ refId: 'RA', userId: 'user-A', status: 'pending', type: 'investment_buy' }],
                resultFor: () => ({ status: 'pending', type: 'investment_buy' })
            });

            const res = await callLegacy({ reference: 'RA', userId: 'user-A' });
            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body, { success: false, status: 'pending', type: 'investment_buy' });
            assert.deepStrictEqual(verifyCalls, ['RA']);
        });

        await test('R10. Legitimate terminal legacy owner response remains compatible', async () => {
            reset({
                records: [{ refId: 'RA', userId: 'user-A', status: 'failed', type: 'investment_buy' }],
                resultFor: () => ({ status: 'failed', type: 'investment_buy', reference: 'RA' })
            });

            const res = await callLegacy({ reference: 'RA', userId: 'user-A' });
            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body, { success: false, status: 'failed', type: 'investment_buy' });
            assert.deepStrictEqual(verifyCalls, ['RA']);
        });

        await test('R11. Wallet owner succeeds', async () => {
            reset({ records: [{ refId: 'RA', userId: 'user-A', status: 'pending', type: 'funding' }] });

            const res = await callWallet({ reference: 'RA', userId: 'user-A' });
            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body, { status: 'pending', type: 'funding', reference: 'RA', amount: undefined });
            assert.deepStrictEqual(verifyCalls, ['RA']);
        });

        await test('R12. Wallet non-owner receives generic 404 before verifyFunding', async () => {
            reset({ records: [{ refId: 'RA', userId: 'user-A', status: 'pending', type: 'funding' }] });

            const res = await callWallet({ reference: 'RA', userId: 'user-B' });
            assert.strictEqual(res.statusCode, 404);
            assert.deepStrictEqual(res.body, { status: 'not_found' });
            assert.strictEqual(verifyCalls.length, 0);
        });

        await test('R13. Ownerless wallet TransactionStatus fails closed', async () => {
            reset({ records: [{ refId: 'RA', status: 'pending', type: 'funding' }] });

            const res = await callWallet({ reference: 'RA', userId: 'user-A' });
            assert.strictEqual(res.statusCode, 404);
            assert.deepStrictEqual(res.body, { status: 'not_found' });
            assert.strictEqual(verifyCalls.length, 0);
        });

        await test('R14. Wallet unknown and non-owner references are externally equivalent', async () => {
            reset({ records: [{ refId: 'RA', userId: 'user-A', status: 'pending', type: 'funding' }] });

            const nonOwner = await callWallet({ reference: 'RA', userId: 'user-B' });
            const unknown = await callWallet({ reference: 'RX', userId: 'user-B' });
            assert.strictEqual(nonOwner.statusCode, unknown.statusCode);
            assert.deepStrictEqual(nonOwner.body, unknown.body);
            assert.strictEqual(verifyCalls.length, 0);
        });
    } finally {
        TransactionStatus.findOne = originalFindOne;
        paymentGatewayService.verifyFunding = originalVerifyFunding;
    }

    console.log('\n-----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('-----------------------------------------------------\n');

    if (failed > 0) process.exit(1);
}

runPaystackVerifyAuthorizationTests().catch(err => {
    console.error('[FATAL TEST ERROR]', err);
    process.exit(1);
});
