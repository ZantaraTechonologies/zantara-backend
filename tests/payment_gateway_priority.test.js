'use strict';

/**
 * Payment Gateway Routing Priority Test Suite
 *
 * Covers the Routing Priority feature end-to-end:
 * 1. Model schema definition (Number, default 1, min 1)
 * 2. Mongoose-level validation (rejects 0, negatives, non-numeric)
 * 3. Serializer behavior (admin returns it; client view strips it)
 * 4. Admin create: persists provided priority, defaults to 1, floors decimals,
 *    rejects invalid values with 400
 * 5. Admin update: persists, floors decimals, rejects invalid values, unchanged on error
 */

const assert = require('assert');
const mongoose = require('mongoose');

const PaymentGateway = require('../models/PaymentGateway');
const AuditLog = require('../models/AuditLog');

const adminGatewayController = require('../controllers/adminPaymentGatewayController');
const { sanitizePaymentGateway, sanitizePaymentGatewayForClient } = require('../utils/paymentGatewaySerializer');

function runPriorityTests() {
    console.log('====================================================');
    console.log('    PAYMENT GATEWAY ROUTING PRIORITY TEST SUITE     ');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`\u2705 [PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`\u274c [FAIL] ${name}`);
            console.error(`   Error: ${err.message}`);
            if (process.env.VERBOSE) console.error(err.stack);
            failed++;
        }
    }

    // Helper: Mock Express req/res
    function mockReqRes(options = {}) {
        const req = {
            user: options.user || { _id: new mongoose.Types.ObjectId(), name: 'Test SuperAdmin', role: 'superAdmin' },
            params: options.params || {},
            body: options.body || {},
            query: options.query || {},
            headers: options.headers || {},
            ip: '127.0.0.1'
        };

        const res = {
            statusCode: 200,
            responseData: null,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(data) {
                this.responseData = data;
                return this;
            }
        };

        const next = (err) => {
            if (err) res.error = err;
        };

        return { req, res, next };
    }

    // In-memory gateway store for isolated controller testing
    let gatewaysDB = [];

    // Save original model methods
    const origCreate = PaymentGateway.create;
    const origFindOne = PaymentGateway.findOne;
    const origFindById = PaymentGateway.findById;
    const origAuditCreate = AuditLog.create;

    // Install mocks
    PaymentGateway.create = async (data) => {
        const doc = {
            _id: new mongoose.Types.ObjectId(),
            ...data,
            isDefault: false,
            priority: data.priority === undefined ? 1 : data.priority,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        doc.save = async function () {};
        gatewaysDB.push(doc);
        return doc;
    };
    PaymentGateway.findOne = async (filter) => {
        if (filter.$or) {
            return gatewaysDB.find(g =>
                filter.$or.some(cond => (cond.code && g.code === cond.code) || (cond.name && g.name === cond.name))
            ) || null;
        }
        if (filter.code) {
            return gatewaysDB.find(g => g.code === filter.code) || null;
        }
        return null;
    };
    PaymentGateway.findById = async (id) => {
        const g = gatewaysDB.find(g => String(g._id) === String(id)) || null;
        if (g) g.save = async function () {};
        return g;
    };
    AuditLog.create = async () => ({});

    const baseCreateBody = {
        name: 'Test Gateway',
        code: 'priotest',
        adapterType: 'paystack',
        status: 'inactive',
        environment: 'test',
        supportedChannels: ['card', 'bank_transfer', 'ussd']
    };

    return (async () => {
        // ─────────────────────────────────────────────────────────────────────
        // 1. MODEL SCHEMA
        // ─────────────────────────────────────────────────────────────────────
        await test('1. Priority schema path is a Number with default 1 and min 1', async () => {
            const path = PaymentGateway.schema.path('priority');
            assert.ok(path, 'priority path must exist');
            assert.strictEqual(path.instance, 'Number');
            assert.strictEqual(path.defaultValue, 1);
            const validators = path.validators || [];
            assert.ok(
                validators.some(v => v.type === 'min' && v.min === 1),
                'priority must carry a min validator of 1'
            );
        });

        await test('2. Default priority on a new doc without explicit value is 1', async () => {
            const created = await PaymentGateway.create({ ...baseCreateBody });
            freshDB();
            assert.strictEqual(created.priority, 1);
        });

        await test('3. Model rejects priority 0 at validation time', async () => {
            const doc = new PaymentGateway({ ...baseCreateBody, code: `p0_${Date.now()}`, priority: 0 });
            const validationErr = doc.validateSync();
            assert.ok(
                validationErr && (validationErr.errors || {}).priority,
                'priority 0 must fail model validation'
            );
        });

        await test('4. Model rejects negative priority at validation time', async () => {
            const doc = new PaymentGateway({ ...baseCreateBody, code: `pn_${Date.now()}`, priority: -3 });
            const validationErr = doc.validateSync();
            assert.ok(
                validationErr && (validationErr.errors || {}).priority,
                'negative priority must fail model validation'
            );
        });

        await test('5. Model rejects non-numeric priority at validation time', async () => {
            const doc = new PaymentGateway({ ...baseCreateBody, code: `pa_${Date.now()}`, priority: 'high' });
            let invalid = false;
            try {
                await doc.$validate();
            } catch (e) {
                invalid = true;
            }
            assert.ok(invalid || (doc.validateSync() && (doc.validateSync().errors || {}).priority), 'non-numeric priority must fail');
        });

        await test('6. Model accepts a valid priority (5)', async () => {
            const doc = new PaymentGateway({ ...baseCreateBody, code: `px_${Date.now()}`, priority: 5 });
            const validationErr = doc.validateSync();
            assert.strictEqual(validationErr, undefined, `no validation error expected, got: ${validationErr}`);
        });

        // ─────────────────────────────────────────────────────────────────────
        // 2. SERIALIZER
        // ─────────────────────────────────────────────────────────────────────
        await test('7. Admin serializer forwards priority and falls back to 1', async () => {
            const g5 = { ...baseCreateBody, priority: 5 };
            const gMissing = { ...baseCreateBody, priority: undefined };
            assert.strictEqual(sanitizePaymentGateway(g5).priority, 5);
            assert.strictEqual(sanitizePaymentGateway(gMissing).priority, 1);
        });

        await test('8. Client-facing serializer does not expose priority', async () => {
            const clientView = sanitizePaymentGatewayForClient({ ...baseCreateBody, priority: 5 });
            assert.strictEqual(clientView.priority, undefined);
            assert.strictEqual(clientView.secretKey, undefined);
            assert.ok(clientView.supportedChannels);
        });

        // ─────────────────────────────────────────────────────────────────────
        // 3. ADMIN CREATE
        // ─────────────────────────────────────────────────────────────────────
        await test('9. Create persists the provided priority (3)', async () => {
            freshDB();
            const { req, res } = mockReqRes({ body: { ...baseCreateBody, code: 'prio_create_a', priority: 3 } });
            await adminGatewayController.createGateway(req, res);
            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.responseData.data.priority, 3);
            assert.strictEqual(gatewaysDB[0].priority, 3);
        });

        await test('10. Create without priority defaults to 1', async () => {
            freshDB();
            const { req, res } = mockReqRes({ body: { ...baseCreateBody, code: 'prio_create_b' } });
            await adminGatewayController.createGateway(req, res);
            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.responseData.data.priority, 1);
        });

        await test('11. Create floors decimal priority (2.9 -> 2)', async () => {
            freshDB();
            const { req, res } = mockReqRes({ body: { ...baseCreateBody, code: 'prio_create_c', priority: 2.9 } });
            await adminGatewayController.createGateway(req, res);
            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.responseData.data.priority, 2);
        });

        await test('12. Create rejects priority 0 with 400', async () => {
            freshDB();
            const { req, res } = mockReqRes({ body: { ...baseCreateBody, code: 'prio_create_d', priority: 0 } });
            await adminGatewayController.createGateway(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.ok(res.responseData.message.includes('positive integer'));
            assert.strictEqual(gatewaysDB.length, 0);
        });

        await test('13. Create rejects negative priority with 400', async () => {
            freshDB();
            const { req, res } = mockReqRes({ body: { ...baseCreateBody, code: 'prio_create_e', priority: -4 } });
            await adminGatewayController.createGateway(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(gatewaysDB.length, 0);
        });

        await test('14. Create rejects non-numeric priority with 400', async () => {
            freshDB();
            for (const bad of ['abc', NaN]) {
                const { req, res } = mockReqRes({ body: { ...baseCreateBody, code: 'prio_create_f', priority: bad } });
                await adminGatewayController.createGateway(req, res);
                assert.strictEqual(res.statusCode, 400, `priority=${bad} must be rejected`);
            }
        });

        // ─────────────────────────────────────────────────────────────────────
        // 4. ADMIN UPDATE
        // ─────────────────────────────────────────────────────────────────────
        await test('15. Update persists the provided priority (7)', async () => {
            freshDB();
            const created = await PaymentGateway.create({ ...baseCreateBody, code: 'prio_upd_a', priority: 1 });
            const { req, res } = mockReqRes({
                params: { id: created._id },
                body: { priority: 7 }
            });
            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData.data.priority, 7);
            assert.strictEqual(gatewaysDB[0].priority, 7);
        });

        await test('16. Update floors decimal priority (4.8 -> 4)', async () => {
            freshDB();
            const created = await PaymentGateway.create({ ...baseCreateBody, code: 'prio_upd_b', priority: 1 });
            const { req, res } = mockReqRes({
                params: { id: created._id },
                body: { priority: 4.8 }
            });
            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData.data.priority, 4);
        });

        await test('17. Update rejects priority 0 with 400 and leaves value unchanged', async () => {
            freshDB();
            const created = await PaymentGateway.create({ ...baseCreateBody, code: 'prio_upd_c', priority: 2 });
            const { req, res } = mockReqRes({
                params: { id: created._id },
                body: { priority: 0 }
            });
            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(gatewaysDB[0].priority, 2, 'priority must remain unchanged after rejected update');
        });

        await test('18. Update rejects negative priority with 400 and leaves value unchanged', async () => {
            freshDB();
            const created = await PaymentGateway.create({ ...baseCreateBody, code: 'prio_upd_d', priority: 2 });
            const { req, res } = mockReqRes({
                params: { id: created._id },
                body: { priority: -1 }
            });
            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(gatewaysDB[0].priority, 2);
        });

        await test('19. Update rejects non-numeric priority with 400 and leaves value unchanged', async () => {
            freshDB();
            const created = await PaymentGateway.create({ ...baseCreateBody, code: 'prio_upd_e', priority: 2 });
            const { req, res } = mockReqRes({
                params: { id: created._id },
                body: { priority: 'nope' }
            });
            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(gatewaysDB[0].priority, 2);
        });

        await test('20. Update without priority preserves the existing priority', async () => {
            freshDB();
            const created = await PaymentGateway.create({ ...baseCreateBody, code: 'prio_upd_f', priority: 6 });
            const { req, res } = mockReqRes({
                params: { id: created._id },
                body: { name: 'Renamed Gateway' }
            });
            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData.data.priority, 6);
        });

        await test('20b. REGRESSION: create priority=3, update another field without priority, priority stays 3', async () => {
            freshDB();
            const created = await PaymentGateway.create({ ...baseCreateBody, code: 'prio_upd_reg', priority: 3 });
            const { req, res } = mockReqRes({
                params: { id: created._id },
                body: { name: 'Updated Gateway Name' }
            });
            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData.data.priority, 3, 'omitted priority must be preserved on update');
            assert.strictEqual(gatewaysDB[0].priority, 3);
            assert.strictEqual(gatewaysDB[0].name, 'Updated Gateway Name');
        });

        await test('20c. REGRESSION: priority=3, PUT priority:null -> remains 3', async () => {
            freshDB();
            const created = await PaymentGateway.create({ ...baseCreateBody, code: 'prio_upd_null', priority: 3 });
            const { req, res } = mockReqRes({
                params: { id: created._id },
                body: { priority: null }
            });
            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData.data.priority, 3);
            assert.strictEqual(gatewaysDB[0].priority, 3);
        });

        await test('20d. REGRESSION: priority=3, PUT priority:"" -> remains 3', async () => {
            freshDB();
            const created = await PaymentGateway.create({ ...baseCreateBody, code: 'prio_upd_empty', priority: 3 });
            const { req, res } = mockReqRes({
                params: { id: created._id },
                body: { priority: '' }
            });
            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData.data.priority, 3);
            assert.strictEqual(gatewaysDB[0].priority, 3);
        });

        await test('20e. REGRESSION: priority=3, PUT priority:"   " -> remains 3', async () => {
            freshDB();
            const created = await PaymentGateway.create({ ...baseCreateBody, code: 'prio_upd_ws', priority: 3 });
            const { req, res } = mockReqRes({
                params: { id: created._id },
                body: { priority: '   ' }
            });
            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData.data.priority, 3);
            assert.strictEqual(gatewaysDB[0].priority, 3);
        });

        await test('20f. REGRESSION: priority=3, PUT priority:2 -> becomes 2', async () => {
            freshDB();
            const created = await PaymentGateway.create({ ...baseCreateBody, code: 'prio_upd_num', priority: 3 });
            const { req, res } = mockReqRes({
                params: { id: created._id },
                body: { priority: 2 }
            });
            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData.data.priority, 2);
            assert.strictEqual(gatewaysDB[0].priority, 2);
        });

        await test('20g. Update with whitespace-only numeric string is preserved, not 400', async () => {
            freshDB();
            const created = await PaymentGateway.create({ ...baseCreateBody, code: 'prio_upd_ws2', priority: 3 });
            const { req, res } = mockReqRes({
                params: { id: created._id },
                body: { priority: '\t ' }
            });
            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData.data.priority, 3);
        });

        // ─────────────────────────────────────────────────────────────────────
        // 5. STANDARDIZED PRIORITY ACROSS EXISTING SERIALIZER + ROUTING DOC
        // ─────────────────────────────────────────────────────────────────────
        await test('21. Serializer + controller produce identical single priority value (no second mechanism)', async () => {
            freshDB();
            const created = await PaymentGateway.create({ ...baseCreateBody, code: 'prio_uniq', priority: 3 });
            const adminView = sanitizePaymentGateway(created);
            // Simulate what Admin UI would send back on edit (Number(formPriority))
            const { req, res } = mockReqRes({
                params: { id: created._id },
                body: { priority: Number(adminView.priority) }
            });
            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.responseData.data.priority, 3);
            assert.strictEqual(res.responseData.data.priority, adminView.priority);
        });

        // Restore originals
        PaymentGateway.create = origCreate;
        PaymentGateway.findOne = origFindOne;
        PaymentGateway.findById = origFindById;
        AuditLog.create = origAuditCreate;

        console.log('\n------------------------------------------');
        console.log(`Priority Suite: ${passed} passed, ${failed} failed`);
        console.log('------------------------------------------\n');
        return { passed, failed };
    })();

    function freshDB() {
        gatewaysDB = [];
    }
}

runPriorityTests().then(({ passed, failed }) => {
    if (failed > 0) process.exit(1);
}).catch((err) => {
    console.error('Fatal error in priority test suite:', err);
    process.exit(1);
});