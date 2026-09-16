'use strict';

/**
 * CRIT FINAL GATE — Investment Initialization FAIL-CLOSED Tests
 *
 * Guards the invariant that EVERY NEW investment_buy payment MUST obtain and
 * validate an authoritative server-side sharePrice BEFORE:
 *   - TransactionStatus creation
 *   - gateway initialization
 *   - any external payment request capable of taking the user's money
 *
 * If the share price cannot be loaded, is null/undefined, NaN/non-finite or
 * <= 0, BOTH initialization paths (unified PaymentGatewayService and the
 * legacy Paystack controller) FAIL CLOSED:
 *   - no investment TransactionStatus is created
 *   - the gateway is never initialized
 *   - a controlled application error is returned to the caller
 *
 * Ordinary type='funding' initialization must remain unaffected when
 * investment settings are unavailable.
 *
 * Runs without a live MongoDB connection (in-memory mocks).
 */

const assert = require('assert');
const axios = require('axios');
const crypto = require('crypto');

const PaymentGateway = require('../models/PaymentGateway');
const TransactionStatus = require('../models/TransactionStatus');

const paymentGatewayService = require('../services/paymentGateway.service');
const investmentService = require('../services/investment.service');
const paystackController = require('../controllers/paystackController');

async function runInvestmentInitFailClosedTests() {
    console.log('==========================================================');
    console.log(' INVESTMENT INIT FAIL-CLOSED TEST SUITE (FINAL GATE)      ');
    console.log('==========================================================\n');

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

    // ─── MOCK STATE ────────────────────────────────────────────────────────────
    let mockGateways = [];
    let txCreated = [];
    let gatewayInitCalls = [];
    let psInitCalls = [];

    // Save originals for restoration
    const origGetInvestmentSettings = investmentService.getInvestmentSettings;
    const origPgCountDocuments = PaymentGateway.countDocuments;
    const origPgFindOne = PaymentGateway.findOne;
    const origTxCreate = TransactionStatus.create;
    const origAxiosPost = axios.post;
    const origServiceAdapterInit = paymentGatewayService.adapters.paystack.prototype.initializePayment;

    // ─── MOCK SETUP ────────────────────────────────────────────────────────────
    function resetMocks() {
        txCreated = [];
        gatewayInitCalls = [];
        psInitCalls = [];

        // Default gateway (Paystack) controllable per-scenario.
        mockGateways = [
            {
                _id: 'gw-paystack',
                name: 'Paystack',
                code: 'paystack',
                adapterType: 'paystack',
                status: 'active',
                isDefault: true,
                supportedChannels: ['card', 'bank_transfer', 'ussd']
            }
        ];

        PaymentGateway.countDocuments = () => Promise.resolve(mockGateways.length);
        PaymentGateway.findOne = () => {
            if (mockGateways.length === 0) return { then: (resolve) => Promise.resolve(resolve(null)) };
            const g = mockGateways.find((gw) => gw.status === 'active' && gw.isDefault)
                || mockGateways.find((gw) => gw.status === 'active')
                || null;
            return { then: (resolve) => Promise.resolve(resolve(g)) };
        };

        TransactionStatus.create = (doc) => {
            txCreated.push(doc);
            return Promise.resolve({ ...doc, _id: crypto.randomUUID() });
        };

        paymentGatewayService.adapters.paystack.prototype.initializePayment = async ({ reference }) => {
            gatewayInitCalls.push(reference);
            return {
                success: true,
                authorizationUrl: 'https://checkout.paystack.com/mock-init',
                reference
            };
        };

        // The legacy Paystack controller captures utils/paystack.initializePayment
        // by value at load time, so the real SDK is reached. Intercept the HTTP
        // layer exactly as the other suites do. The controller counts as a
        // gateway request only when this real SDK is invoked.
        axios.post = async () => {
            psInitCalls.push('sdk-call');
            return { data: { status: true, data: { authorization_url: 'https://checkout.paystack.com/mock', reference: 'paystack-sdk-ref' } } };
        };
    }

    // Sets how the authoritative investment settings resolve for the NEXT call.
    function stubInvestmentSettings(mode) {
        investmentService.getInvestmentSettings = async () => {
            if (mode === 'throws') {
                throw new Error('DB connection issue: settings collection unreachable');
            }
            if (mode === 'missing') return { investmentEnabled: true };
            if (mode === 'null') return { investmentEnabled: true, sharePrice: null };
            if (mode === 'zero') return { investmentEnabled: true, sharePrice: 0 };
            if (mode === 'negative') return { investmentEnabled: true, sharePrice: -500 };
            if (mode === 'nan') return { investmentEnabled: true, sharePrice: 'not-a-number' };
            if (mode === 'valid') return { investmentEnabled: true, sharePrice: 10000 };
            // funding / no investment_buy → asset settings are irrelevant
            return { investmentEnabled: true, sharePrice: 10000 };
        };
    }

    const makeRes = (calls) => ({
        status(code) {
            calls.statusCode = code;
            return this;
        },
        json(body) {
            calls.jsonBody = body;
            return this;
        },
        send(body) {
            calls.sendBody = body;
            return this;
        },
        sendStatus(code) {
            calls.statusCode = code;
            return this;
        }
    });

    const serviceInitArgs = () => ({
        gatewayCode: 'paystack',
        user: { _id: 'user-1', email: 'u1@test.com' },
        amount: 30000,
        metadata: { type: 'investment_buy' }
    });

    const controllerInitReq = () => ({
        body: {
            amount: 30000,
            channels: ['card', 'bank_transfer'],
            metadata: { type: 'investment_buy' }
        },
        user: { id: 'user-1', email: 'u1@test.com' }
    });

    function assertRejectedBySettings(resultOrErr) {
        assert.ok(
            resultOrErr instanceof Error,
            'investment_buy initialization MUST be rejected when the share price is unavailable/invalid'
        );
        assert.strictEqual(
            resultOrErr.code,
            'INVALID_INVESTMENT_CONFIGURATION',
            `controlled error code expected, got ${resultOrErr.code}`
        );
    }

    try {
        // ─── PATH 1: UNIFIED PaymentGatewayService.initializeFunding ─────────
        await test('S-A. paymentGateway service: valid sharePrice snapshots the authoritative value and initializes the gateway', async () => {
            resetMocks();
            stubInvestmentSettings('valid');

            const res = await paymentGatewayService.initializeFunding(serviceInitArgs());

            assert.strictEqual(res.success, true, 'valid investment init must succeed');
            assert.strictEqual(txCreated.length, 1, 'exactly one TransactionStatus must be created');
            assert.strictEqual(txCreated[0].type, 'investment_buy', 'TransactionStatus must be an investment_buy');
            assert.strictEqual(
                txCreated[0].sharePrice,
                10000,
                `TransactionStatus.sharePrice MUST equal the authoritative server value (10000), got ${txCreated[0].sharePrice}`
            );
            assert.strictEqual(gatewayInitCalls.length, 1, 'gateway initialization MUST be allowed for a valid price');
        });

        await test('S-B. paymentGateway service: getInvestmentSettings throws → rejected, no record, gateway NOT initialized', async () => {
            resetMocks();
            stubInvestmentSettings('throws');

            let caught = null;
            try {
                await paymentGatewayService.initializeFunding(serviceInitArgs());
            } catch (e) {
                caught = e;
            }

            assert.ok(caught instanceof Error, 'must throw when settings cannot be loaded');
            assert.strictEqual(txCreated.length, 0, 'ZERO investment TransactionStatus records may be created');
            assert.strictEqual(gatewayInitCalls.length, 0, 'gateway initialization MUST NOT be called');
        });

        await test('S-C. paymentGateway service: sharePrice missing → rejected, no record, gateway NOT initialized', async () => {
            resetMocks();
            stubInvestmentSettings('missing');

            let caught = null;
            try {
                await paymentGatewayService.initializeFunding(serviceInitArgs());
            } catch (e) {
                caught = e;
            }

            assertRejectedBySettings(caught);
            assert.strictEqual(txCreated.length, 0, 'no TransactionStatus may be created for a missing sharePrice');
            assert.strictEqual(gatewayInitCalls.length, 0, 'gateway initialization MUST NOT be called');
        });

        await test('S-D. paymentGateway service: sharePrice null → rejected, no record, gateway NOT initialized', async () => {
            resetMocks();
            stubInvestmentSettings('null');

            let caught = null;
            try {
                await paymentGatewayService.initializeFunding(serviceInitArgs());
            } catch (e) {
                caught = e;
            }

            assertRejectedBySettings(caught);
            assert.strictEqual(txCreated.length, 0, 'no TransactionStatus may be created for a null sharePrice');
            assert.strictEqual(gatewayInitCalls.length, 0, 'gateway initialization MUST NOT be called');
        });

        await test('S-E. paymentGateway service: sharePrice = 0 → rejected, no record, gateway NOT initialized', async () => {
            resetMocks();
            stubInvestmentSettings('zero');

            let caught = null;
            try {
                await paymentGatewayService.initializeFunding(serviceInitArgs());
            } catch (e) {
                caught = e;
            }

            assertRejectedBySettings(caught);
            assert.strictEqual(txCreated.length, 0, 'no TransactionStatus may be created for sharePrice = 0');
            assert.strictEqual(gatewayInitCalls.length, 0, 'gateway initialization MUST NOT be called');
        });

        await test('S-F. paymentGateway service: sharePrice < 0 → rejected, no record, gateway NOT initialized', async () => {
            resetMocks();
            stubInvestmentSettings('negative');

            let caught = null;
            try {
                await paymentGatewayService.initializeFunding(serviceInitArgs());
            } catch (e) {
                caught = e;
            }

            assertRejectedBySettings(caught);
            assert.strictEqual(txCreated.length, 0, 'no TransactionStatus may be created for a negative sharePrice');
            assert.strictEqual(gatewayInitCalls.length, 0, 'gateway initialization MUST NOT be called');
        });

        await test('S-G. paymentGateway service: sharePrice undefined → rejected, no record, gateway NOT initialized', async () => {
            resetMocks();
            stubInvestmentSettings('missing'); // sharePrice key absent → Number(undefined) = NaN

            let caught = null;
            try {
                await paymentGatewayService.initializeFunding(serviceInitArgs());
            } catch (e) {
                caught = e;
            }

            assertRejectedBySettings(caught);
            assert.strictEqual(txCreated.length, 0, 'no TransactionStatus may be created for an undefined sharePrice');
            assert.strictEqual(gatewayInitCalls.length, 0, 'gateway initialization MUST NOT be called');
        });

        await test('S-H. paymentGateway service: sharePrice NaN/non-finite → rejected, no record, gateway NOT initialized', async () => {
            resetMocks();
            stubInvestmentSettings('nan');

            let caught = null;
            try {
                await paymentGatewayService.initializeFunding(serviceInitArgs());
            } catch (e) {
                caught = e;
            }

            assertRejectedBySettings(caught);
            assert.strictEqual(txCreated.length, 0, 'no TransactionStatus may be created for a non-finite sharePrice');
            assert.strictEqual(gatewayInitCalls.length, 0, 'gateway initialization MUST NOT be called');
        });

        await test('S-I. paymentGateway service: ordinary funding stays functional when investment settings are unavailable', async () => {
            resetMocks();
            stubInvestmentSettings('throws');

            const res = await paymentGatewayService.initializeFunding({
                gatewayCode: 'paystack',
                user: { _id: 'user-1', email: 'u1@test.com' },
                amount: 5000,
                metadata: { type: 'funding' }
            });

            assert.strictEqual(res.success, true, 'ordinary funding must succeed even when investment settings fail');
            assert.strictEqual(txCreated.length, 1, 'funding TransactionStatus must be created');
            assert.strictEqual(txCreated[0].type, 'funding', 'must remain a funding record');
            assert.strictEqual(txCreated[0].sharePrice, undefined, 'funding records must NOT carry a sharePrice snapshot');
            assert.strictEqual(gatewayInitCalls.length, 1, 'gateway initialization must proceed for funding');
        });

        // ─── PATH 2: LEGACY Paystack controller /api/paystack/initialize ─────
        await test('P-A. legacy Paystack controller: valid sharePrice snapshots the authoritative value and initializes the gateway', async () => {
            resetMocks();
            stubInvestmentSettings('valid');

            const calls = {};
            const res = makeRes(calls);
            await paystackController.payment(controllerInitReq(), res);

            assert.ok(calls.jsonBody, 'controller must respond with initialization result');
            assert.strictEqual(txCreated.length, 1, 'exactly one TransactionStatus must be created');
            assert.strictEqual(txCreated[0].type, 'investment_buy', 'TransactionStatus must be an investment_buy');
            assert.strictEqual(
                txCreated[0].sharePrice,
                10000,
                `TransactionStatus.sharePrice MUST equal the authoritative server value (10000), got ${txCreated[0].sharePrice}`
            );
            assert.strictEqual(psInitCalls.length, 1, 'gateway (Paystack) initialization MUST be allowed for a valid price');
        });

        await test('P-B. legacy Paystack controller: getInvestmentSettings throws → rejected (400), no record, gateway NOT initialized', async () => {
            resetMocks();
            stubInvestmentSettings('throws');

            const calls = {};
            const res = makeRes(calls);
            await paystackController.payment(controllerInitReq(), res);

            assert.strictEqual(calls.statusCode, 400, 'fail-closed setting failure must map to 400');
            assert.ok(calls.jsonBody, 'a controlled error body must be returned');
            assert.strictEqual(calls.jsonBody.code, 'INVALID_INVESTMENT_CONFIGURATION', 'controlled error code expected');
            assert.strictEqual(
                String(calls.jsonBody.error).toLowerCase().includes('temporarily unavailable'),
                true,
                'client must receive a safe generic message, never internal settings/db details'
            );
            assert.strictEqual(txCreated.length, 0, 'ZERO investment TransactionStatus records may be created');
            assert.strictEqual(psInitCalls.length, 0, 'gateway initialization MUST NOT be called');
        });

        await test('P-C. legacy Paystack controller: sharePrice missing → rejected (400), no record, gateway NOT initialized', async () => {
            resetMocks();
            stubInvestmentSettings('missing');

            const calls = {};
            const res = makeRes(calls);
            await paystackController.payment(controllerInitReq(), res);

            assert.strictEqual(calls.statusCode, 400, 'missing sharePrice must fail closed');
            assert.strictEqual(txCreated.length, 0, 'no TransactionStatus may be created for a missing sharePrice');
            assert.strictEqual(psInitCalls.length, 0, 'gateway initialization MUST NOT be called');
        });

        await test('P-D. legacy Paystack controller: sharePrice = 0 → rejected (400), no record, gateway NOT initialized', async () => {
            resetMocks();
            stubInvestmentSettings('zero');

            const calls = {};
            const res = makeRes(calls);
            await paystackController.payment(controllerInitReq(), res);

            assert.strictEqual(calls.statusCode, 400, 'sharePrice = 0 must fail closed');
            assert.strictEqual(txCreated.length, 0, 'no TransactionStatus may be created for sharePrice = 0');
            assert.strictEqual(psInitCalls.length, 0, 'gateway initialization MUST NOT be called');
        });

        await test('P-E. legacy Paystack controller: sharePrice < 0 → rejected (400), no record, gateway NOT initialized', async () => {
            resetMocks();
            stubInvestmentSettings('negative');

            const calls = {};
            const res = makeRes(calls);
            await paystackController.payment(controllerInitReq(), res);

            assert.strictEqual(calls.statusCode, 400, 'negative sharePrice must fail closed');
            assert.strictEqual(txCreated.length, 0, 'no TransactionStatus may be created for a negative sharePrice');
            assert.strictEqual(psInitCalls.length, 0, 'gateway initialization MUST NOT be called');
        });

        await test('P-F. legacy Paystack controller: sharePrice NaN/non-finite → rejected (400), no record, gateway NOT initialized', async () => {
            resetMocks();
            stubInvestmentSettings('nan');

            const calls = {};
            const res = makeRes(calls);
            await paystackController.payment(controllerInitReq(), res);

            assert.strictEqual(calls.statusCode, 400, 'non-finite sharePrice must fail closed');
            assert.strictEqual(txCreated.length, 0, 'no TransactionStatus may be created for a non-finite sharePrice');
            assert.strictEqual(psInitCalls.length, 0, 'gateway initialization MUST NOT be called');
        });

        await test('P-G. legacy Paystack controller: ordinary funding stays functional when investment settings are unavailable', async () => {
            resetMocks();
            stubInvestmentSettings('throws');

            const calls = {};
            const res = makeRes(calls);
            await paystackController.payment(
                {
                    body: {
                        amount: 5000,
                        channels: ['card', 'bank_transfer'],
                        metadata: { type: 'funding' }
                    },
                    user: { id: 'user-1', email: 'u1@test.com' }
                },
                res
            );

            assert.ok(calls.jsonBody, 'ordinary funding must succeed when investment settings fail');
            assert.strictEqual(txCreated.length, 1, 'funding TransactionStatus must be created');
            assert.strictEqual(txCreated[0].type, 'funding', 'must remain a funding record');
            assert.strictEqual(txCreated[0].sharePrice, undefined, 'funding records must NOT carry a sharePrice snapshot');
            assert.strictEqual(psInitCalls.length, 1, 'gateway initialization must proceed for funding');
        });
    } finally {
        // ─── RESTORE ───────────────────────────────────────────────
        investmentService.getInvestmentSettings = origGetInvestmentSettings;
        PaymentGateway.countDocuments = origPgCountDocuments;
        PaymentGateway.findOne = origPgFindOne;
        TransactionStatus.create = origTxCreate;
        axios.post = origAxiosPost;
        paymentGatewayService.adapters.paystack.prototype.initializePayment = origServiceAdapterInit;
    }

    // ─── SUMMARY ───────────────────────────────────────────────────────────────
    console.log('\n-----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('-----------------------------------------------------\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runInvestmentInitFailClosedTests().catch((err) => {
    console.error('[FATAL TEST ERROR]', err);
    process.exit(1);
});