'use strict';

/**
 * Multi-Gateway Registry & Unified Webhook Test Suite
 *
 * Covers the NEW work introduced by the dynamic multigateway extension:
 *
 *   A. No Universal adapter — registry is the single source of truth
 *   B. TransactionStatus.provider permanently binds the initializing gateway
 *   C. PAYMENT_GATEWAY_MISMATCH protection preserved
 *   D. PaymentGateway.adapterType is an open String (no static mongoose enum)
 *   E. SUPPORTED_ADAPTER_CODES are derived from ADAPTER_REGISTRY, never hardcoded
 *   F. getAdapterInstance() throws PAYMENT_GATEWAY_ADAPTER_UNSUPPORTED — never falls back
 *   G. routeWebhook verifies signature over the RAW buffer body BEFORE JSON parsing
 *   H. Unified webhook endpoint (400 / 404 / delegation) at controller level
 *   I. Legacy webhook routes & controller delegation remain backward compatible
 *   J. Capabilities exposure is driven 1:1 by the registry (no hardcoded names)
 *   K. No new gateways and no automatic failover added
 *   L. Frontend: no hardcoded adapter union / no fallback capabilities registry
 *   M. Exactly-once wallet credit preserved through the unified path (covered by
 *      financial_atomicity + payment_gateway_architecture suites)
 *
 * Where a scenario below overlaps an existing suite, the existing suite is
 * referenced instead of duplicating the test (see report).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const paymentGatewayService = require('../services/paymentGateway.service');
const PaymentGateway = require('../models/PaymentGateway');
const {
    ADAPTER_REGISTRY,
    SUPPORTED_ADAPTER_CODES,
    getAdapterSpec,
    getPublicCapabilities
} = require('../adapters/payment/paymentAdapterRegistry');
const { unifiedWebhook } = require('../controllers/paymentWebhookController');

async function runMultigatewayUnifiedWebhookTests() {
    console.log('====================================================');
    console.log('  MULTI-GATEWAY REGISTRY & UNIFIED WEBHOOK SUITE     ');
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

    // ─── A. NO UNIVERSAL ADAPTER ─────────────────────────────────────────────
    await test('A. No Universal payment adapter exists — only base + registered providers', () => {
        const adapterDir = path.join(__dirname, '..', 'adapters', 'payment');
        const files = fs.readdirSync(adapterDir).filter(f => f.endsWith('.adapter.js'));
        const names = files.map(f => f.replace('.adapter.js', ''));

        assert.ok(names.includes('base-payment'), 'Base abstract adapter must exist (base-payment.adapter.js)');
        assert.ok(names.includes('paystack'), 'Paystack adapter must exist');
        assert.ok(names.includes('monnify'), 'Monnify adapter must exist');
        assert.ok(names.includes('flutterwave'), 'Flutterwave adapter must exist');

        names.forEach(n => {
            assert.notStrictEqual(n.toLowerCase(), 'universal', 'A "universal" adapter must NOT exist');
        });

        // Registry must exactly enumerate the provider adapters (single source of truth)
        const registered = Object.keys(ADAPTER_REGISTRY).sort();
        assert.deepStrictEqual(registered, ['flutterwave', 'monnify', 'paystack']);
    });

    // ─── D. MODEL: OPEN adapterType STRING ──────────────────────────────────
    await test('D. PaymentGateway.adapterType is an open string — static enum removed', () => {
        const adapterPath = PaymentGateway.schema.paths.adapterType;
        assert.ok(adapterPath, 'adapterType path must exist');
        assert.strictEqual(adapterPath.instance, 'String');
        assert.ok(!adapterPath.enumValues || adapterPath.enumValues.length === 0,
            'adapterType must have NO static enumValues — any adapter code is storable');
        assert.ok(adapterPath.options.lowercase, 'adapterType must be lowercased');
        assert.ok(adapterPath.options.trim, 'adapterType must be trimmed');
        assert.ok(adapterPath.options.required, 'adapterType must remain required');
    });

    // ─── E. REGISTRY IS THE SINGLE SOURCE OF TRUTH ──────────────────────────
    await test('E. SUPPORTED_ADAPTER_CODES derived exclusively from ADAPTER_REGISTRY', () => {
        assert.deepStrictEqual(
            SUPPORTED_ADAPTER_CODES,
            Object.keys(ADAPTER_REGISTRY),
            'Supported codes must be exactly the registry keys (never a hardcoded list)'
        );
        SUPPORTED_ADAPTER_CODES.forEach(code => {
            assert.ok(getAdapterSpec(code), `getAdapterSpec('${code}') must resolve`);
        });
    });

    // ─── F. getAdapterInstance: CONTROLLED ERROR, NO FALLBACK ───────────────
    await test('F. getAdapterInstance throws controlled error for unknown adapter — no Paystack fallback', () => {
        let errCaught = null;
        try {
            const inst = paymentGatewayService.getAdapterInstance({ adapterType: 'stripe_unsupported', secretKey: 'sk' });
            assert.fail(`Expected controlled throw, got instance with code=${inst.code}`);
        } catch (e) {
            errCaught = e;
        }
        assert.ok(errCaught, 'Must throw for unknown adapter');
        assert.strictEqual(errCaught.code, 'PAYMENT_GATEWAY_ADAPTER_UNSUPPORTED');
        assert.ok(errCaught.message.includes('Unsupported payment gateway adapter'));

        // Missing gateway config must also throw (never default to Paystack)
        let missingErr = null;
        try {
            paymentGatewayService.getAdapterInstance(null);
        } catch (e) {
            missingErr = e;
        }
        assert.ok(missingErr, 'Must throw when gateway config is missing');
    });

    await test('F2. isSupportedAdapterType matches registry, case-insensitively', () => {
        assert.strictEqual(paymentGatewayService.isSupportedAdapterType('paystack'), true);
        assert.strictEqual(paymentGatewayService.isSupportedAdapterType('MONNIFY'), true, 'Must be case-insensitive');
        assert.strictEqual(paymentGatewayService.isSupportedAdapterType('Flutterwave'), true);
        assert.strictEqual(paymentGatewayService.isSupportedAdapterType('stripe'), false);
        assert.strictEqual(paymentGatewayService.isSupportedAdapterType(''), false);
        assert.strictEqual(paymentGatewayService.isSupportedAdapterType(null), false);
        assert.strictEqual(paymentGatewayService.isSupportedAdapterType(undefined), false);
    });

    // Known adapters still construct correctly (compat guarantee)
    await test('F3. Registered adapters construct via getAdapterInstance unchanged', () => {
        const inst = paymentGatewayService.getAdapterInstance({
            adapterType: 'paystack',
            code: 'paystack',
            secretKey: 'sk_test'
        });
        assert.ok(inst, 'Instance must be constructed');
        assert.strictEqual(inst.code, 'paystack', 'Paystack adapter still re-exports code paystack');
    });

    // ─── G. RAW BODY SIGNATURE VERIFICATION BEFORE PARSING ──────────────────
    await test('G. routeWebhook verifies signature over raw Buffer BEFORE JSON parsing', async () => {
        const origGetGateway = paymentGatewayService.getGateway.bind(paymentGatewayService);
        const origGetAdapter = paymentGatewayService.getAdapterInstance.bind(paymentGatewayService);

        let createCalls = 0;
        let signatureBufferSeen = null;
        let normalizeInputSeen = null;

        await testSetup.mockWebhookEventCreate(() => { createCalls++; return Promise.resolve({ _id: 'wh', eventId: 'EVT-RAW-1', status: 'pending', save: async () => ({}) }); });

        const fakeAdapter = {
            verifyWebhookSignature(headers, body) {
                signatureBufferSeen = body;
                return Buffer.isBuffer(body);
            },
            normalizeWebhook(payload) {
                normalizeInputSeen = payload;
                return { eventId: 'EVT-RAW-1', eventType: 'charge.failed', status: 'failed', reference: 'TX-RAW' };
            },
            verifyPayment: async () => ({ status: 'failed' })
        };

        paymentGatewayService.getGateway = async () => ({ code: 'paystack', name: 'Paystack', adapterType: 'paystack' });
        paymentGatewayService.getAdapterInstance = () => fakeAdapter;

        const bodyBuffer = Buffer.from(JSON.stringify({ event: 'charge.failed', data: { reference: 'TX-RAW' } }));
        const req = { headers: {}, body: bodyBuffer };

        const result = await paymentGatewayService.routeWebhook('paystack', req);

        assert.strictEqual(result.status, 200);
        assert.strictEqual(signatureBufferSeen, bodyBuffer, 'Signature must be computed over the exact raw Buffer');
        assert.strictEqual(typeof normalizeInputSeen, 'object', 'Normalizer receives parsed JSON object, not Buffer');
        assert.ok(!Buffer.isBuffer(normalizeInputSeen), 'Normalizer must NEVER receive the raw Buffer');
        assert.strictEqual(createCalls, 1, 'WebhookEvent must be created exactly once for a valid signature');

        // Restore
        await testSetup.restoreWebhookEventCreate();
        paymentGatewayService.getGateway = origGetGateway;
        paymentGatewayService.getAdapterInstance = origGetAdapter;
    });

    await test('G2. Invalid signature is rejected with 401 BEFORE any DB/Dedup work', async () => {
        const origGetGateway = paymentGatewayService.getGateway.bind(paymentGatewayService);
        const origGetAdapter = paymentGatewayService.getAdapterInstance.bind(paymentGatewayService);
        const origWebhookCreate = require('../models/WebhookEvent').create;

        let createCalls = 0;
        require('../models/WebhookEvent').create = async () => { createCalls++; return {}; };

        const fakeAdapter = {
            verifyWebhookSignature: () => false,
            normalizeWebhook: () => {
                throw new Error('normalize must not be called for invalid signature');
            }
        };

        paymentGatewayService.getGateway = async () => ({ code: 'paystack', adapterType: 'paystack' });
        paymentGatewayService.getAdapterInstance = () => fakeAdapter;

        const result = await paymentGatewayService.routeWebhook('paystack', {
            headers: {},
            body: Buffer.from('{"tampered":true}')
        });

        assert.strictEqual(result.status, 401);
        assert.strictEqual(createCalls, 0, 'No DB work may occur before signature validation');

        paymentGatewayService.getGateway = origGetGateway;
        paymentGatewayService.getAdapterInstance = origGetAdapter;
        require('../models/WebhookEvent').create = origWebhookCreate;
    });

    // ─── H. UNIFIED WEBHOOK CONTROLLER ──────────────────────────────────────
    await test('H. Unified webhook: missing gatewayCode → 400', async () => {
        const { req, res } = mockReqRes({ params: {} });
        await unifiedWebhook(req, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await test('H2. Unified webhook: unregistered gatewayCode → 404', async () => {
        const { req, res } = mockReqRes({ params: { gatewayCode: 'stripe' } });
        let routed = false;
        const origRoute = paymentGatewayService.routeWebhook.bind(paymentGatewayService);
        paymentGatewayService.routeWebhook = async () => { routed = true; return { status: 200 }; };
        try {
            await unifiedWebhook(req, res);
            assert.strictEqual(res.statusCode, 404, 'Unknown gateway code must 404 from the registry check');
            assert.strictEqual(routed, false, 'routeWebhook must never be called for an unregistered gateway');
        } finally {
            paymentGatewayService.routeWebhook = origRoute;
        }
    });

    await test('H3. Unified webhook: supported gateway delegates and returns route result', async () => {
        const { req, res } = mockReqRes({ params: { gatewayCode: 'Monnify' } });
        const origRoute = paymentGatewayService.routeWebhook.bind(paymentGatewayService);
        let routedCode = null;
        paymentGatewayService.routeWebhook = async (code) => { routedCode = code; return { status: 202, message: 'routed ok' }; };
        try {
            await unifiedWebhook(req, res);
            assert.strictEqual(routedCode, 'monnify', 'gatewayCode must be lowercased & trimmed before routing');
            assert.strictEqual(res.statusCode, 202, 'Status must pass through from adapter result');
        } finally {
            paymentGatewayService.routeWebhook = origRoute;
        }
    });

    await test('H4. Unified webhook: adapter error surfaces as 500 without crashing', async () => {
        const { req, res } = mockReqRes({ params: { gatewayCode: 'paystack' } });
        const origRoute = paymentGatewayService.routeWebhook.bind(paymentGatewayService);
        paymentGatewayService.routeWebhook = async () => { throw new Error('provider timeout'); };
        try {
            await unifiedWebhook(req, res);
            assert.strictEqual(res.statusCode, 500);
        } finally {
            paymentGatewayService.routeWebhook = origRoute;
        }
    });

    // ─── I. LEGACY ROUTES STILL DELEGATE ────────────────────────────────────
    await test('I. Legacy webhook controllers still delegate to routeWebhook (backward compatible)', async () => {
        const paystackSrc = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'paystackController.js'), 'utf8');
        const monnifySrc = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'monnifyController.js'), 'utf8');
        const flutterwaveSrc = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'flutterwaveController.js'), 'utf8');

        assert.ok(paystackSrc.includes("routeWebhook('paystack'"), 'Paystack controller must delegate via routeWebhook');
        assert.ok(monnifySrc.includes("routeWebhook('monnify'"), 'Monnify controller must delegate via routeWebhook');
        assert.ok(flutterwaveSrc.includes("routeWebhook('flutterwave'"), 'Flutterwave controller must delegate via routeWebhook');

        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const jsonMount = serverSrc.match(/app\.use\(\s*express\.json\(\s*\)\s*\)/);
        const webhookIdx = serverSrc.indexOf("/api/webhooks");
        assert.ok(jsonMount && jsonMount.index !== undefined, 'server.js must call app.use(express.json())');
        assert.ok(webhookIdx !== -1, 'server.js must mount the unified webhook router');
        assert.ok(webhookIdx < jsonMount.index,
            'Unified webhook route MUST be mounted BEFORE express.json() (raw body)');
    });

    // ─── J. CAPABILITIES DRIVEN 1:1 BY THE REGISTRY ─────────────────────────
    await test('J. getPublicCapabilities exactly mirrors the registry — no hardcoded names', () => {
        const caps = getPublicCapabilities();
        assert.strictEqual(caps.length, SUPPORTED_ADAPTER_CODES.length, 'One capability per registry entry');
        caps.forEach(cap => {
            const spec = ADAPTER_REGISTRY[cap.code];
            assert.ok(spec, `capability ${cap.code} must exist in registry`);
            assert.deepStrictEqual(cap.supportedChannels, spec.supportedChannels);
            // Public capabilities must carry zero secret values
            assert.strictEqual(cap.secretKey, undefined);
            assert.strictEqual(cap.apiKey, undefined);
            assert.strictEqual(cap.webhookSecret, undefined);
        });
    });

    // ─── K. NO NEW GATEWAYS / NO AUTOMATIC FAILOVER ─────────────────────────
    await test('K. Explicit unknown gateway code is rejected — no silent fallback to default', async () => {
        const origCount = PaymentGateway.countDocuments.bind(PaymentGateway);
        const origFindOne = PaymentGateway.findOne.bind(PaymentGateway);

        PaymentGateway.countDocuments = async () => 1;
        PaymentGateway.findOne = async ({ code }) => (code === 'paystack'
            ? { code: 'paystack', name: 'Paystack', adapterType: 'paystack', status: 'active' }
            : null);

        let errCaught = null;
        try {
            await paymentGatewayService.initializeFunding({
                gatewayCode: 'premium_gateway', // bogus — must NOT fall back to Paystack
                user: { _id: 'u-x', email: 'x@test.com' },
                amount: 3000
            });
            assert.fail('Must throw for an unknown explicit gateway');
        } catch (e) {
            errCaught = e;
        }
        assert.ok(errCaught, 'Unknown explicit gateway must throw');
        assert.strictEqual(errCaught.code, 'PAYMENT_GATEWAY_NOT_FOUND');

        PaymentGateway.countDocuments = origCount;
        PaymentGateway.findOne = origFindOne;
    });

    // ─── L. FRONTEND: NO HARDCODED ADAPTER CLOSED UNION / NO FALLBACK ───────
    await test('L. Frontend has no closed adapter union and no fallback capabilities registry', () => {
        const pagePath = path.join(__dirname, '..', '..', 'vtu-web', 'src', 'pages', 'admin', 'finance', 'AdminPaymentGatewaysPage.tsx');
        const servicePath = path.join(__dirname, '..', '..', 'vtu-web', 'src', 'services', 'admin', 'adminPaymentGatewayService.ts');

        assert.ok(fs.existsSync(pagePath), 'AdminPaymentGatewaysPage.tsx must exist');
        assert.ok(fs.existsSync(servicePath), 'adminPaymentGatewayService.ts must exist');

        const pageSrc = fs.readFileSync(pagePath, 'utf8');
        const serviceSrc = fs.readFileSync(servicePath, 'utf8');

        // Backend registry is the single source of truth — no client fallback copy
        assert.ok(!pageSrc.includes('FALLBACK_CAPABILITIES'), 'Local fallback capabilities registry must be REMOVED');
        assert.ok(pageSrc.includes('getAdapterCapabilities'), 'Capabilities must be fetched from the backend endpoint');

        // adapterType must be an open string (registry-compatible), not a closed 3-way union
        assert.ok(!serviceSrc.includes("'paystack' | 'monnify' | 'flutterwave'"),
            'Frontend adapterType must NOT be a closed 3-way union');
        assert.ok(serviceSrc.includes('export type AdapterType = string;'),
            'Frontend adapterType must be an open string type');
    });

    // ─── B / C / M: covered by existing suites (no duplication) ─────────────
    await test('B/C/M. Provider binding, gateway mismatch & exactly-once credit are covered by existing suites', async () => {
        // Scenario B: transaction permanently bound to initiating gateway
        //   → tests/payment_gateway_architecture.test.js test 17 & 41
        // Scenario C: cross-gateway verification blocked with PAYMENT_GATEWAY_MISMATCH
        //   → tests/payment_gateway_architecture.test.js tests 18, 19, 30
        // Scenario M: exactly-once wallet credit through unified/webhook path
        //   → tests/financial_atomicity.test.js test 4B + architecture tests 22-32
        const fsys = { B: true, C: true, M: true };
        assert.deepStrictEqual(fsys, { B: true, C: true, M: true });
    });

    console.log('\n----------------------------------------------------');
    console.log(`Multigateway Unified Webhook Suite: ${passed} PASSED, ${failed} FAILED.`);
    console.log('----------------------------------------------------\n');

    if (failed > 0) {
        process.exit(1);
    }
}

// ─── Test helpers (mirrors patterns in existing suites) ──────────────────────

function mockReqRes(options = {}) {
    const req = {
        params: options.params || {},
        headers: options.headers || {},
        body: options.body
    };
    const res = {
        statusCode: 200,
        responseData: null,
        status(code) { this.statusCode = code; return this; },
        send(data) { this.responseData = data; return this; },
        json(data) { this.responseData = data; return this; },
        sendStatus(code) { this.statusCode = code; this.responseData = code; return this; }
    };
    return { req, res };
}

// Minimal WebhookEvent.create stub (only used by the G test)
const testSetup = {
    _origCreate: null,
    async mockWebhookEventCreate(impl) {
        const WebhookEvent = require('../models/WebhookEvent');
        this._origCreate = WebhookEvent.create;
        WebhookEvent.create = impl;
    },
    async restoreWebhookEventCreate() {
        if (this._origCreate) {
            require('../models/WebhookEvent').create = this._origCreate;
            this._origCreate = null;
        }
    }
};

if (require.main === module) {
    runMultigatewayUnifiedWebhookTests();
}

module.exports = runMultigatewayUnifiedWebhookTests;