'use strict';

/**
 * Admin Payment Gateway Management Test Suite
 *
 * Covers:
 * 1. RBAC authorization (unauthenticated, user, admin vs superAdmin)
 * 2. Safe serialization (zero secret exposure)
 * 3. Blank secret retention during edit
 * 4. Safe credential rotation and encryption
 * 5. Multiple active gateways coexistence
 * 6. Single-default concurrency and constraints
 * 7. Inactive / Maintenance gateway cannot become default
 * 8. Safe Test Connection execution (no secret leakage)
 * 9. Audit logging without credential leaks
 * 10. Reconciliation & In-flight processing visibility
 * 11. Referential integrity on deletion
 * 12. Public client funding-methods discovery
 */

const assert = require('assert');
const mongoose = require('mongoose');

const PaymentGateway = require('../models/PaymentGateway');
const TransactionStatus = require('../models/TransactionStatus');
const WebhookEvent = require('../models/WebhookEvent');
const AuditLog = require('../models/AuditLog');

const adminGatewayController = require('../controllers/adminPaymentGatewayController');
const { sanitizePaymentGateway, sanitizePaymentGatewayForClient } = require('../utils/paymentGatewaySerializer');
const { encryptSecret, decryptSecret, isEncrypted } = require('../utils/crypto');
const { checkRoles } = require('../middlewares/auth');

async function runAdminPaymentGatewayTests() {
    console.log('====================================================');
    console.log('    ADMIN PAYMENT GATEWAY MANAGEMENT TEST SUITE     ');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`✅ [PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`❌ [FAIL] ${name}`);
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
    let auditLogsDB = [];
    let transactionsDB = [];
    let webhooksDB = [];

    // Save original model methods
    const origFind = PaymentGateway.find;
    const origFindById = PaymentGateway.findById;
    const origFindOne = PaymentGateway.findOne;
    const origCreate = PaymentGateway.create;
    const origCountDocuments = PaymentGateway.countDocuments;
    const origFindByIdAndDelete = PaymentGateway.findByIdAndDelete;
    const origSetDefault = PaymentGateway.setDefault;

    const origTxFind = TransactionStatus.find;
    const origTxCount = TransactionStatus.countDocuments;
    const origWhCount = WebhookEvent.countDocuments;
    const origAuditCreate = AuditLog.create;

    // Install mocks
    PaymentGateway.countDocuments = async () => gatewaysDB.length;
    PaymentGateway.find = () => ({
        sort: () => [...gatewaysDB]
    });
    PaymentGateway.findById = async (id) => {
        return gatewaysDB.find(g => String(g._id) === String(id)) || null;
    };
    PaymentGateway.findOne = async (filter) => {
        if (filter.code) {
            return gatewaysDB.find(g => g.code === filter.code) || null;
        }
        if (filter.$or) {
            return gatewaysDB.find(g =>
                filter.$or.some(cond => (cond.code && g.code === cond.code) || (cond.name && g.name === cond.name))
            ) || null;
        }
        return null;
    };
    PaymentGateway.create = async (doc) => {
        const gw = {
            ...doc,
            _id: new mongoose.Types.ObjectId(),
            createdAt: new Date(),
            updatedAt: new Date(),
            save: async function () {
                this.updatedAt = new Date();
                return this;
            },
            markModified: function () {}
        };
        gatewaysDB.push(gw);
        return gw;
    };
    PaymentGateway.findByIdAndDelete = async (id) => {
        const idx = gatewaysDB.findIndex(g => String(g._id) === String(id));
        if (idx !== -1) {
            const removed = gatewaysDB.splice(idx, 1)[0];
            return removed;
        }
        return null;
    };
    PaymentGateway.setDefault = async (id) => {
        gatewaysDB.forEach(g => {
            if (String(g._id) !== String(id)) g.isDefault = false;
            else {
                if (g.status !== 'active') throw new Error('Cannot set non-active gateway as default');
                g.isDefault = true;
            }
        });
        return { modifiedCount: 1 };
    };

    AuditLog.create = async (log) => {
        auditLogsDB.push(log);
        return log;
    };

    TransactionStatus.countDocuments = async (filter) => {
        if (filter.gateway) {
            return transactionsDB.filter(t => t.gateway === filter.gateway).length;
        }
        return transactionsDB.length;
    };

    WebhookEvent.countDocuments = async (filter) => {
        if (filter.gatewayCode) {
            return webhooksDB.filter(w => w.gatewayCode === filter.gatewayCode).length;
        }
        return webhooksDB.length;
    };

    TransactionStatus.find = (filter) => ({
        sort: () => ({
            limit: () => ({
                populate: () => ({
                    lean: async () => transactionsDB.filter(t => filter.status.$in.includes(t.status))
                })
            })
        })
    });

    try {
        // ─────────────────────────────────────────────────────────────────────────────
        // 1. RBAC AUTHORIZATION TESTS
        // ─────────────────────────────────────────────────────────────────────────────
        await test('1. Unauthenticated request without token is rejected with 401', async () => {
            const { verifyJWT } = require('../middlewares/auth');
            const { req, res, next } = mockReqRes({ headers: {} });
            verifyJWT(req, res, next);
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(res.responseData?.message, 'Not authenticated');
        });

        await test('2. Ordinary user (role: user) cannot access SuperAdmin gateway endpoints', async () => {
            const middleware = checkRoles('superAdmin');
            const { req, res, next } = mockReqRes({ user: { role: 'user' } });
            middleware(req, res, next);
            assert.strictEqual(res.statusCode, 403);
            assert.strictEqual(res.responseData?.message, 'Forbidden: Insufficient role');
        });

        await test('3. Ordinary Admin (role: admin) cannot modify payment gateway configuration', async () => {
            const middleware = checkRoles('superAdmin');
            const { req, res, next } = mockReqRes({ user: { role: 'admin' } });
            middleware(req, res, next);
            assert.strictEqual(res.statusCode, 403);
        });

        await test('4. SuperAdmin passes authorization for gateway mutations', async () => {
            const middleware = checkRoles('superAdmin');
            const { req, res, next } = mockReqRes({ user: { role: 'superAdmin' } });
            let called = false;
            middleware(req, res, () => { called = true; });
            assert.strictEqual(called, true);
        });

        // ─────────────────────────────────────────────────────────────────────────────
        // 2. CREATION & SERIALIZATION SECURITY
        // ─────────────────────────────────────────────────────────────────────────────
        await test('5. SuperAdmin can create a new payment gateway', async () => {
            gatewaysDB = [];
            const { req, res } = mockReqRes({
                user: { role: 'superAdmin', name: 'SuperAdmin 1' },
                body: {
                    name: 'Paystack Production',
                    code: 'paystack',
                    adapterType: 'paystack',
                    status: 'active',
                    environment: 'live',
                    isDefault: true,
                    publicKey: 'pk_live_1234567890',
                    secretKey: 'sk_live_very_secret_key_abcdef',
                    webhookSecret: 'whsec_very_secret_webhook_123',
                    baseUrl: 'https://api.paystack.co',
                    supportedChannels: ['card', 'bank_transfer', 'ussd']
                }
            });

            await adminGatewayController.createGateway(req, res);
            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.responseData?.success, true);
            assert.strictEqual(res.responseData?.data?.name, 'Paystack Production');
            assert.strictEqual(res.responseData?.data?.code, 'paystack');
            assert.strictEqual(res.responseData?.data?.isDefault, true);
            assert.strictEqual(res.responseData?.data?.secretKeyConfigured, true);
            assert.strictEqual(res.responseData?.data?.webhookSecretConfigured, true);

            // Verify stored in DB is encrypted
            const stored = gatewaysDB[0];
            assert.ok(isEncrypted(stored.secretKey), 'secretKey must be encrypted at rest');
            assert.ok(isEncrypted(stored.webhookSecret), 'webhookSecret must be encrypted at rest');
        });

        await test('6. GET endpoints never return secrets or key fragments', async () => {
            const { req, res } = mockReqRes({ user: { role: 'admin' } });
            await adminGatewayController.getAllGateways(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData?.success, true);

            const gw = res.responseData?.data[0];
            assert.strictEqual(gw.secretKey, undefined, 'secretKey field must not exist in response');
            assert.strictEqual(gw.webhookSecret, undefined, 'webhookSecret field must not exist in response');
            assert.strictEqual(gw.maskedSecretKey, undefined, 'maskedSecretKey must not exist');
            assert.strictEqual(gw.secretKeyConfigured, true);
            assert.strictEqual(gw.webhookSecretConfigured, true);
        });

        // ─────────────────────────────────────────────────────────────────────────────
        // 3. CREDENTIAL RETENTION ON BLANK EDIT
        // ─────────────────────────────────────────────────────────────────────────────
        await test('7. Blank secretKey / webhookSecret during edit retains existing credentials', async () => {
            const existing = gatewaysDB[0];
            const originalSecretCipher = existing.secretKey;
            const originalWebhookCipher = existing.webhookSecret;

            const { req, res } = mockReqRes({
                user: { role: 'superAdmin' },
                params: { id: existing._id },
                body: {
                    name: 'Paystack Production Renamed',
                    // Sending blank / whitespace string
                    secretKey: '   ',
                    webhookSecret: '',
                    environment: 'live'
                }
            });

            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData?.data?.name, 'Paystack Production Renamed');
            assert.strictEqual(res.responseData?.data?.secretKeyConfigured, true);
            assert.strictEqual(res.responseData?.data?.webhookSecretConfigured, true);

            // Verify DB records retained original encrypted values
            assert.strictEqual(existing.secretKey, originalSecretCipher);
            assert.strictEqual(existing.webhookSecret, originalWebhookCipher);
        });

        await test('8. Non-empty credential edit encrypts and updates credential safely', async () => {
            const existing = gatewaysDB[0];
            const originalSecretCipher = existing.secretKey;

            const { req, res } = mockReqRes({
                user: { role: 'superAdmin' },
                params: { id: existing._id },
                body: {
                    secretKey: 'sk_live_new_rotated_secret_99999'
                }
            });

            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.notStrictEqual(existing.secretKey, originalSecretCipher);
            assert.ok(isEncrypted(existing.secretKey));
            assert.strictEqual(decryptSecret(existing.secretKey), 'sk_live_new_rotated_secret_99999');
        });

        // ─────────────────────────────────────────────────────────────────────────────
        // 4. MULTIPLE ACTIVE GATEWAYS & SINGLE DEFAULT CONCURRENCY
        // ─────────────────────────────────────────────────────────────────────────────
        await test('9. Multiple active gateways can coexist simultaneously', async () => {
            // Add Monnify and Flutterwave as active
            const { req: req1, res: res1 } = mockReqRes({
                user: { role: 'superAdmin' },
                body: {
                    name: 'Monnify Direct',
                    code: 'monnify',
                    adapterType: 'monnify',
                    status: 'active',
                    isDefault: false,
                    publicKey: 'MK_TEST_123',
                    secretKey: 'MNFY_SECRET_123',
                    baseUrl: 'https://sandbox.monnify.com',
                    supportedChannels: ['card', 'bank_transfer']
                }
            });
            await adminGatewayController.createGateway(req1, res1);
            assert.strictEqual(res1.statusCode, 201);

            const { req: req2, res: res2 } = mockReqRes({
                user: { role: 'superAdmin' },
                body: {
                    name: 'Flutterwave Backup',
                    code: 'flutterwave',
                    adapterType: 'flutterwave',
                    status: 'active',
                    isDefault: false,
                    publicKey: 'FLWPUBK_TEST',
                    secretKey: 'FLWSECK_TEST_999',
                    baseUrl: 'https://api.flutterwave.com/v3',
                    supportedChannels: ['card', 'bank_transfer', 'ussd']
                }
            });
            await adminGatewayController.createGateway(req2, res2);
            assert.strictEqual(res2.statusCode, 201);

            // Check: All 3 are active!
            const active = gatewaysDB.filter(g => g.status === 'active');
            assert.strictEqual(active.length, 3, 'Paystack, Monnify, and Flutterwave must all be active');
        });

        await test('10. Setting new default gateway atomically unsets previous default', async () => {
            const monnify = gatewaysDB.find(g => g.code === 'monnify');
            const paystack = gatewaysDB.find(g => g.code === 'paystack');

            assert.strictEqual(paystack.isDefault, true);
            assert.strictEqual(monnify.isDefault, false);

            const { req, res } = mockReqRes({
                user: { role: 'superAdmin' },
                params: { id: monnify._id }
            });

            await adminGatewayController.setDefaultGateway(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData?.data?.isDefault, true);

            // Monnify is now default, Paystack is NOT default
            assert.strictEqual(monnify.isDefault, true);
            assert.strictEqual(paystack.isDefault, false);
        });

        await test('11. Inactive gateway cannot be set as default', async () => {
            // Set flutterwave to inactive
            const flw = gatewaysDB.find(g => g.code === 'flutterwave');
            flw.status = 'inactive';

            const { req, res } = mockReqRes({
                user: { role: 'superAdmin' },
                params: { id: flw._id }
            });

            await adminGatewayController.setDefaultGateway(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.ok(res.responseData?.message.includes('Only active gateways can be default'));
            assert.strictEqual(flw.isDefault, false);
        });

        await test('12. Maintenance gateway cannot be set as default', async () => {
            const flw = gatewaysDB.find(g => g.code === 'flutterwave');
            flw.status = 'maintenance';

            const { req, res } = mockReqRes({
                user: { role: 'superAdmin' },
                params: { id: flw._id }
            });

            await adminGatewayController.setDefaultGateway(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(flw.isDefault, false);
        });

        // ─────────────────────────────────────────────────────────────────────────────
        // 5. TEST CONNECTION
        // ─────────────────────────────────────────────────────────────────────────────
        await test('13. Test Connection invokes server-side adapter and never returns credentials', async () => {
            const paystack = gatewaysDB.find(g => g.code === 'paystack');
            const { req, res } = mockReqRes({
                user: { role: 'superAdmin' },
                params: { id: paystack._id }
            });

            // Mock adapter testConnection
            const origGetAdapter = require('../services/paymentGateway.service').getAdapterInstance;
            require('../services/paymentGateway.service').getAdapterInstance = () => ({
                testConnection: async () => ({
                    success: true,
                    message: 'Connected to Paystack successfully'
                })
            });

            try {
                await adminGatewayController.testGatewayConnection(req, res);
                assert.strictEqual(res.statusCode, 200);
                assert.strictEqual(res.responseData?.success, true);
                assert.strictEqual(res.responseData?.message, 'Connected to Paystack successfully');
                assert.strictEqual(res.responseData?.lastHealthCheck?.status, 'online');
                assert.strictEqual(res.responseData?.secretKey, undefined);
                assert.strictEqual(res.responseData?.authorization, undefined);
            } finally {
                require('../services/paymentGateway.service').getAdapterInstance = origGetAdapter;
            }
        });

        // ─────────────────────────────────────────────────────────────────────────────
        // 6. AUDIT LOGGING
        // ─────────────────────────────────────────────────────────────────────────────
        await test('14. Admin audit log records actions without recording sensitive secrets', async () => {
            assert.ok(auditLogsDB.length > 0, 'Audit entries must be recorded');
            const credLog = auditLogsDB.find(l => l.action === 'PAYMENT_GATEWAY_CREDENTIALS_ROTATED');
            assert.ok(credLog, 'Credential rotation must be audited');
            assert.strictEqual(credLog.details?.secretKeyUpdated, true);
            assert.strictEqual(credLog.details?.secretKey, undefined, 'Secret value must not exist in audit log');
            assert.strictEqual(credLog.details?.rawKey, undefined);
        });

        // ─────────────────────────────────────────────────────────────────────────────
        // 7. RECONCILIATION VISIBILITY
        // ─────────────────────────────────────────────────────────────────────────────
        await test('15. Processing & reconciliation_required funding transactions visible to Admin', async () => {
            transactionsDB = [
                {
                    _id: new mongoose.Types.ObjectId(),
                    reference: 'ZAN-PROC-991',
                    gateway: 'paystack',
                    status: 'processing',
                    amount: 5000,
                    currency: 'NGN',
                    userId: { _id: new mongoose.Types.ObjectId(), name: 'Tunde Client', email: 'tunde@example.com' },
                    createdAt: new Date(Date.now() - 15 * 60 * 1000), // 15 mins ago
                    updatedAt: new Date(Date.now() - 15 * 60 * 1000)
                },
                {
                    _id: new mongoose.Types.ObjectId(),
                    reference: 'ZAN-RECON-882',
                    gateway: 'monnify',
                    status: 'reconciliation_required',
                    amount: 10000,
                    confirmedAmountKobo: 100000, // ₦1000 (mismatch!)
                    currency: 'NGN',
                    confirmedCurrency: 'NGN',
                    confirmedProviderRef: 'MNFY-TX-5544',
                    reconciliationReason: 'Amount mismatch: expected ₦10000, provider confirmed ₦1000',
                    userId: { _id: new mongoose.Types.ObjectId(), name: 'Amina Buyer', email: 'amina@example.com' },
                    createdAt: new Date(Date.now() - 5 * 60 * 1000),
                    updatedAt: new Date(Date.now() - 5 * 60 * 1000)
                },
                {
                    _id: new mongoose.Types.ObjectId(),
                    reference: 'ZAN-SUCCESS-111',
                    gateway: 'paystack',
                    status: 'success', // Should NOT be in reconciliation endpoint
                    amount: 2000
                }
            ];

            const { req, res } = mockReqRes({ user: { role: 'admin' } });
            await adminGatewayController.getReconciliationTransactions(req, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData?.success, true);
            assert.strictEqual(res.responseData?.data?.length, 2);

            const procItem = res.responseData.data.find(d => d.reference === 'ZAN-PROC-991');
            assert.ok(procItem);
            assert.strictEqual(procItem.status, 'processing');
            assert.strictEqual(procItem.elapsedMinutes >= 14, true, 'Must display elapsed processing time');
            assert.strictEqual(procItem.expectedAmount, 5000);

            const reconItem = res.responseData.data.find(d => d.reference === 'ZAN-RECON-882');
            assert.ok(reconItem);
            assert.strictEqual(reconItem.status, 'reconciliation_required');
            assert.strictEqual(reconItem.expectedAmount, 10000);
            assert.strictEqual(reconItem.confirmedAmount, 1000);
            assert.ok(reconItem.reconciliationReason.includes('Amount mismatch'));
        });

        await test('16. Reconciliation response does not leak raw secret/provider payloads', async () => {
            const { req, res } = mockReqRes({ user: { role: 'admin' } });
            await adminGatewayController.getReconciliationTransactions(req, res);
            res.responseData.data.forEach(item => {
                assert.strictEqual(item.raw, undefined);
                assert.strictEqual(item.rawPayload, undefined);
                assert.strictEqual(item.headers, undefined);
                assert.strictEqual(item.authorization, undefined);
            });
        });

        // ─────────────────────────────────────────────────────────────────────────────
        // 8. DELETION SAFEGUARD
        // ─────────────────────────────────────────────────────────────────────────────
        await test('17. Gateway deletion is blocked if historical financial transactions exist', async () => {
            const paystack = gatewaysDB.find(g => g.code === 'paystack');
            // Mock that 1 transaction exists for paystack
            transactionsDB = [{ gateway: 'paystack', reference: 'REF-OLD-1' }];

            const { req, res } = mockReqRes({
                user: { role: 'superAdmin' },
                params: { id: paystack._id }
            });

            await adminGatewayController.deleteGateway(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.ok(res.responseData?.message.includes('historical financial records'));
            assert.ok(gatewaysDB.some(g => g.code === 'paystack'), 'Paystack must NOT be deleted');
        });

        // ─────────────────────────────────────────────────────────────────────────────
        // 9. CLIENT FUNDING METHODS DISCOVERY
        // ─────────────────────────────────────────────────────────────────────────────
        await test('18. GET /api/wallet/funding-methods returns only active gateways stripped of internal data', async () => {
            const origGetActive = require('../services/paymentGateway.service').getActiveGateways;
            require('../services/paymentGateway.service').getActiveGateways = async () => {
                return gatewaysDB.filter(g => g.status === 'active');
            };

            try {
                const { req, res } = mockReqRes({ user: { role: 'user' } });
                await adminGatewayController.getFundingMethods(req, res);
                assert.strictEqual(res.statusCode, 200);
                assert.strictEqual(res.responseData?.success, true);

                const methods = res.responseData?.data;
                assert.ok(Array.isArray(methods));
                methods.forEach(m => {
                    assert.ok(m.code);
                    assert.ok(m.name);
                    assert.ok(m.supportedChannels);
                    assert.strictEqual(m.secretKey, undefined);
                    assert.strictEqual(m.secretKeyConfigured, undefined, 'Client view must not expose credential indicators');
                    assert.strictEqual(m.lastHealthCheck, undefined, 'Client view must not expose internal health telemetry');
                });
            } finally {
                require('../services/paymentGateway.service').getActiveGateways = origGetActive;
            }
        });

    } finally {
        // Restore original model methods
        PaymentGateway.find = origFind;
        PaymentGateway.findById = origFindById;
        PaymentGateway.findOne = origFindOne;
        PaymentGateway.create = origCreate;
        PaymentGateway.countDocuments = origCountDocuments;
        PaymentGateway.findByIdAndDelete = origFindByIdAndDelete;
        PaymentGateway.setDefault = origSetDefault;

        TransactionStatus.find = origTxFind;
        TransactionStatus.countDocuments = origTxCount;
        WebhookEvent.countDocuments = origWhCount;
        AuditLog.create = origAuditCreate;
    }

    console.log('\n----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('----------------------------------------------------\n');

    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    runAdminPaymentGatewayTests();
}

module.exports = runAdminPaymentGatewayTests;
