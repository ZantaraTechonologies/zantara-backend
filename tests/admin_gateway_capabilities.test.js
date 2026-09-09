'use strict';

/**
 * Admin Payment Gateway Capabilities & Validation Test Suite
 *
 * Covers:
 * 1. GET /capabilities returns registry with all supported adapters and field schemas
 * 2. GET /capabilities never exposes actual secrets or credentials
 * 3. Rejects unknown adapter engine on gateway creation
 * 4. Rejects unsupported channels for a given adapter (e.g. virtual_account for Paystack)
 * 5. Accepts valid adapter-specific channels (e.g. virtual_account for Monnify)
 * 6. Validates channels during gateway update against effective adapter
 * 7. Inactive gateway cannot be set as default on creation or status change
 * 8. Blank secret during update retains existing encrypted credential
 */

const assert = require('assert');
const mongoose = require('mongoose');

const PaymentGateway = require('../models/PaymentGateway');
const AuditLog = require('../models/AuditLog');
const adminGatewayController = require('../controllers/adminPaymentGatewayController');
const { encryptSecret, decryptSecret, isEncrypted } = require('../utils/crypto');
const {
    ADAPTER_REGISTRY,
    SUPPORTED_ADAPTER_CODES,
    getAdapterSpec,
    getPublicCapabilities
} = require('../adapters/payment/paymentAdapterRegistry');

async function runCapabilitiesTests() {
    console.log('====================================================');
    console.log('  PAYMENT GATEWAY CAPABILITIES & VALIDATION SUITE   ');
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

    // Mock storage
    let gatewaysDB = [];
    const origFind = PaymentGateway.find;
    const origFindById = PaymentGateway.findById;
    const origFindOne = PaymentGateway.findOne;
    const origCreate = PaymentGateway.create;
    const origCountDocuments = PaymentGateway.countDocuments;
    const origAuditCreate = AuditLog.create;

    PaymentGateway.find = () => ({
        sort: () => Promise.resolve(gatewaysDB.map(g => ({ ...g })))
    });

    PaymentGateway.findById = (id) => {
        const item = gatewaysDB.find(g => String(g._id) === String(id));
        if (!item) return Promise.resolve(null);
        return Promise.resolve({
            ...item,
            save: async function () {
                const idx = gatewaysDB.findIndex(g => String(g._id) === String(id));
                if (idx !== -1) gatewaysDB[idx] = { ...this };
                return this;
            }
        });
    };

    PaymentGateway.findOne = (query) => {
        if (query.code) {
            const item = gatewaysDB.find(g => g.code === query.code);
            return Promise.resolve(item ? { ...item } : null);
        }
        if (query.isDefault) {
            const item = gatewaysDB.find(g => g.isDefault === true);
            return Promise.resolve(item ? { ...item } : null);
        }
        return Promise.resolve(null);
    };

    PaymentGateway.create = async (data) => {
        const doc = {
            _id: new mongoose.Types.ObjectId(),
            ...data,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        gatewaysDB.push(doc);
        return doc;
    };

    PaymentGateway.countDocuments = async (query = {}) => {
        let list = gatewaysDB;
        if (query.isDefault !== undefined) list = list.filter(g => g.isDefault === query.isDefault);
        if (query.status !== undefined) list = list.filter(g => g.status === query.status);
        return list.length;
    };

    AuditLog.create = async (entry) => entry;

    try {
        // Test 1: Public capabilities registry structure
        await test('Capabilities endpoint returns all 3 supported adapters with schema descriptors', async () => {
            const { req, res } = mockReqRes({ user: { role: 'admin' } });
            await adminGatewayController.getAdapterCapabilities(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.responseData?.success, true);
            const caps = res.responseData?.data;
            assert.ok(Array.isArray(caps));
            assert.strictEqual(caps.length, 3);

            const codes = caps.map(c => c.code);
            assert.ok(codes.includes('paystack'));
            assert.ok(codes.includes('monnify'));
            assert.ok(codes.includes('flutterwave'));

            // Verify Paystack schema
            const paystack = caps.find(c => c.code === 'paystack');
            assert.strictEqual(paystack.label, 'Paystack');
            assert.deepStrictEqual(paystack.supportedChannels, ['card', 'bank_transfer', 'ussd']);
            assert.ok(paystack.credentialFields.some(f => f.key === 'publicKey' && f.sensitive === false));
            assert.ok(paystack.credentialFields.some(f => f.key === 'secretKey' && f.sensitive === true));

            // Verify Monnify schema (has contractCode in metadataFields)
            const monnify = caps.find(c => c.code === 'monnify');
            assert.strictEqual(monnify.label, 'Monnify');
            assert.ok(monnify.supportedChannels.includes('virtual_account'));
            assert.ok(monnify.metadataFields.some(m => m.key === 'contractCode' && m.required === true));
        });

        // Test 2: Zero secrets or stored credentials in capabilities
        await test('Capabilities endpoint exposes ZERO secret keys, API keys, or encrypted data', async () => {
            const { req, res } = mockReqRes();
            await adminGatewayController.getAdapterCapabilities(req, res);

            const caps = res.responseData?.data;
            caps.forEach(cap => {
                assert.strictEqual(cap.secretKey, undefined);
                assert.strictEqual(cap.apiKey, undefined);
                assert.strictEqual(cap.webhookSecret, undefined);
                cap.credentialFields.forEach(field => {
                    assert.strictEqual(field.value, undefined);
                    assert.strictEqual(field.encrypted, undefined);
                });
            });
        });

        // Test 3: Reject unknown adapter engine
        await test('Gateway creation rejects unknown or unverified adapter engines', async () => {
            const { req, res } = mockReqRes({
                body: {
                    name: 'Custom Unverified',
                    code: 'custom_gateway',
                    adapterType: 'stripe_unsupported',
                    supportedChannels: ['card']
                }
            });

            await adminGatewayController.createGateway(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.responseData?.success, false);
            assert.ok(res.responseData?.message.includes('Invalid adapterType'));
        });

        // Test 4: Reject unsupported channels for adapter
        await test('Gateway creation rejects channels unsupported by the chosen adapter', async () => {
            // Paystack does NOT support 'virtual_account' in its registry declaration
            const { req, res } = mockReqRes({
                body: {
                    name: 'Paystack Secondary',
                    code: 'paystack_secondary',
                    adapterType: 'paystack',
                    supportedChannels: ['card', 'virtual_account'],
                    secretKey: 'sk_test_12345678'
                }
            });

            await adminGatewayController.createGateway(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.responseData?.success, false);
            assert.ok(res.responseData?.message.includes('not supported'));
        });

        // Test 5: Allow valid adapter-supported channels
        await test('Gateway creation accepts channels supported by adapter (e.g. virtual_account for Monnify)', async () => {
            const { req, res } = mockReqRes({
                body: {
                    name: 'Monnify Direct',
                    code: 'monnify_direct',
                    adapterType: 'monnify',
                    status: 'active',
                    supportedChannels: ['card', 'bank_transfer', 'virtual_account'],
                    publicKey: 'MK_TEST_1234',
                    secretKey: 'sk_monnify_test',
                    metadata: { contractCode: '9988776655' }
                }
            });

            await adminGatewayController.createGateway(req, res);
            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.responseData?.success, true);
            assert.strictEqual(res.responseData?.data?.code, 'monnify_direct');
            assert.ok(res.responseData?.data?.supportedChannels.includes('virtual_account'));
        });

        // Test 6: Inactive gateway cannot be set as default on creation
        await test('Inactive gateway cannot be made platform default on creation', async () => {
            const { req, res } = mockReqRes({
                body: {
                    name: 'Draft Gateway',
                    code: 'draft_gateway',
                    adapterType: 'paystack',
                    status: 'inactive',
                    isDefault: true,
                    supportedChannels: ['card']
                }
            });

            await adminGatewayController.createGateway(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.responseData?.success, false);
            assert.ok(res.responseData?.message.includes('default'));
        });

        // Test 7: Update validates channels against adapter
        await test('Gateway update rejects channels outside adapter capabilities', async () => {
            const created = await PaymentGateway.create({
                name: 'Paystack Production',
                code: 'paystack_prod',
                adapterType: 'paystack',
                status: 'active',
                supportedChannels: ['card'],
                secretKey: encryptSecret('sk_live_initial')
            });

            const { req, res } = mockReqRes({
                params: { id: String(created._id) },
                body: {
                    supportedChannels: ['card', 'virtual_account'] // not supported for paystack
                }
            });

            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.responseData?.success, false);
            assert.ok(res.responseData?.message.includes('not supported'));
        });

        // Test 8: Blank secret retention on update
        await test('Blank secret on update preserves existing encrypted credential', async () => {
            const originalSecret = 'sk_live_secret_preserve_me';
            const encryptedOriginal = encryptSecret(originalSecret);

            const gatewayDoc = await PaymentGateway.create({
                name: 'Flutterwave Prod',
                code: 'flutterwave_prod',
                adapterType: 'flutterwave',
                status: 'active',
                supportedChannels: ['card', 'bank_transfer'],
                secretKey: encryptedOriginal,
                publicKey: 'FLWPUBK_1234'
            });

            const { req, res } = mockReqRes({
                params: { id: String(gatewayDoc._id) },
                body: {
                    name: 'Flutterwave Prod Renamed',
                    secretKey: '', // BLANK: must NOT overwrite existing secret
                    webhookSecret: ''
                }
            });

            await adminGatewayController.updateGateway(req, res);
            assert.strictEqual(res.statusCode, 200);

            // Fetch from store and verify raw secretKey is still encrypted original
            const updated = gatewaysDB.find(g => String(g._id) === String(gatewayDoc._id));
            assert.ok(isEncrypted(updated.secretKey));
            assert.strictEqual(decryptSecret(updated.secretKey), originalSecret);
        });

    } finally {
        // Restore methods
        PaymentGateway.find = origFind;
        PaymentGateway.findById = origFindById;
        PaymentGateway.findOne = origFindOne;
        PaymentGateway.create = origCreate;
        PaymentGateway.countDocuments = origCountDocuments;
        AuditLog.create = origAuditCreate;
    }

    console.log('\n----------------------------------------------------');
    console.log(`Capabilities Test Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('----------------------------------------------------\n');

    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    runCapabilitiesTests();
}

module.exports = runCapabilitiesTests;
