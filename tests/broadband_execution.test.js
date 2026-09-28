'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'broadband-execution-test-secret';
process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY = process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY
    || '11'.repeat(32);

const assert = require('assert');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const UniversalAdapter = require('../adapters/universal.adapter');
const { PROVIDER_OPERATIONS, supportsProviderOperation } = require('../adapters/providerAdapterRegistry');
const { validateMetadata } = require('../utils/providerSerializer');
const { serializeBroadbandVerification } = require('../utils/customerVerificationSerializer');
const { normalizeIdentifier, normalizeAmount } = require('../utils/broadbandInputPolicy');
const {
    issueBroadbandVerificationContext,
    verifyBroadbandVerificationContext
} = require('../utils/broadbandVerificationContext');
const { encryptSecret, decryptSecret, isEncrypted, validateEncryptionConfiguration } = require('../utils/crypto');
const { PROVIDER_OUTCOMES, normalizeProviderOutcome } = require('../utils/providerOutcome');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
const ProviderOffer = require('../models/ProviderOffer');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const pinService = require('../services/pin.service');
const walletService = require('../services/wallet.service');
const pricingService = require('../services/pricing.service');
const procurementService = require('../services/procurement.service');
const providerService = require('../services/provider.service');
const purchaseService = require('../services/purchase.service');
const broadbandService = require('../services/broadband.service');
const broadbandController = require('../controllers/broadbandController');
const broadbandReadiness = require('../services/broadbandReadiness.service');
const transactionIdempotencyIndexService = require('../services/transactionIdempotencyIndex.service');
const {
    buildBroadbandPurchaseIntent,
    createBroadbandRequestFingerprint
} = require('../utils/broadbandRequestFingerprint');
const servicesRouter = require('../routes/services');
const { verifyJWT } = require('../middlewares/auth');
const requireLegalCompliance = require('../middlewares/requireLegalCompliance');
const { pinLimiter, broadbandVerificationLimiter } = require('../middlewares/limiter');

const chainResult = value => ({
    populate() { return this; },
    sort() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
});

async function run() {
    let passed = 0;
    let failed = 0;
    const test = async (name, fn) => {
        try {
            await fn();
            console.log(`[PASS] ${name}`);
            passed++;
        } catch (error) {
            console.error(`[FAIL] ${name}: ${error.message}`);
            failed++;
        }
    };

    await test('Universal Broadband capabilities require explicit safe configuration', () => {
        const incomplete = {
            adapterType: 'universal',
            metadata: { broadbandPurchaseUrl: '/buy', broadbandSuccessPath: 'code', broadbandSuccessValue: '00' }
        };
        assert.strictEqual(supportsProviderOperation(incomplete, PROVIDER_OPERATIONS.PURCHASE_BROADBAND), false);

        const complete = {
            adapterType: 'universal',
            metadata: {
                broadbandPurchaseUrl: '/buy',
                broadbandSuccessPath: 'code',
                broadbandSuccessValue: '00',
                broadbandPendingPath: 'status',
                broadbandPendingValue: 'pending',
                broadbandFailurePath: 'status',
                broadbandFailureValue: 'failed',
                queryUrl: '/query',
                querySuccessPath: 'code',
                querySuccessValue: '00',
                queryPendingPath: 'status',
                queryPendingValue: 'pending',
                queryFailurePath: 'status',
                queryFailureValue: 'failed',
                broadbandVerifyUrl: '/verify',
                broadbandVerifySuccessPath: 'code',
                broadbandVerifySuccessValue: '00',
                broadbandVerifyPendingPath: 'status',
                broadbandVerifyPendingValue: 'pending',
                broadbandVerifyFailurePath: 'status',
                broadbandVerifyFailureValue: 'failed'
            }
        };
        assert.strictEqual(supportsProviderOperation(complete, PROVIDER_OPERATIONS.PURCHASE_BROADBAND), true);
        assert.strictEqual(supportsProviderOperation(complete, PROVIDER_OPERATIONS.VERIFY_BROADBAND), true);
        assert.strictEqual(supportsProviderOperation(complete, PROVIDER_OPERATIONS.VERIFY_BROADBAND_EVIDENCE), false);
        complete.metadata.broadbandVerifyReferencePath = 'reference';
        complete.metadata.broadbandFieldMap = {
            request_id: 'request',
            serviceID: 'service',
            variation_code: 'plan',
            identifier: 'identifier',
            amount: 'amount',
            verification_reference: 'verificationReference'
        };
        assert.strictEqual(supportsProviderOperation(complete, PROVIDER_OPERATIONS.VERIFY_BROADBAND_EVIDENCE), true);
        assert.strictEqual(supportsProviderOperation({ ...complete, adapterType: 'vtpass' }, PROVIDER_OPERATIONS.PURCHASE_BROADBAND), false);
    });

    await test('Broadband Universal metadata keys are accepted and normalized', () => {
        const metadata = validateMetadata({
            broadbandPurchaseUrl: '/buy',
            broadbandMethod: 'post',
            broadbandFieldMap: {
                request_id: 'reference',
                serviceID: 'service',
                variation_code: 'plan',
                identifier: 'account',
                amount: 'amount'
            },
            broadbandSuccessPath: 'response.code',
            broadbandSuccessValue: 200,
            broadbandVerifyUrl: '/verify',
            broadbandVerifyMethod: 'get',
            broadbandVerifyCustomerNamePath: 'data.customer.name'
        });
        assert.strictEqual(metadata.broadbandMethod, 'POST');
        assert.strictEqual(metadata.broadbandVerifyMethod, 'GET');
        assert.strictEqual(metadata.broadbandSuccessValue, '200');
        assert.throws(() => validateMetadata({
            broadbandFieldMap: { identifier: 'account' }
        }), /missing required keys/);
        assert.throws(() => validateMetadata({ authHeaderValue: 'Basic raw-credential' }), /placeholder/);

        const originalEnvironment = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = 'staging';
            assert.throws(
                () => validateMetadata({ broadbandPurchaseUrl: 'http://example.com/path/localhost' }),
                /HTTPS URL/
            );
            assert.throws(
                () => validateMetadata({ broadbandPurchaseUrl: 'https://user:password@provider.example/buy' }),
                /embedded credentials/
            );
            assert.strictEqual(
                validateMetadata({ broadbandPurchaseUrl: 'http://127.0.0.1:8080/buy' }).broadbandPurchaseUrl,
                'http://127.0.0.1:8080/buy'
            );
        } finally {
            if (originalEnvironment === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = originalEnvironment;
        }
    });

    await test('Skipped Broadband verification is represented as quote-ready, not verified', () => {
        const result = serializeBroadbandVerification({
            verified: false,
            identifierMasked: '****1234',
            verificationContext: 'opaque',
            idempotencyKey: 'key',
            serviceIdentityId: 'identity',
            expiresAt: new Date().toISOString()
        });
        assert.strictEqual(result.verified, false);
        assert.strictEqual(result.status, 'verification_not_required');
    });

    await test('Universal Broadband response uses operation-specific mappings', () => {
        const adapter = new UniversalAdapter({
            baseUrl: 'https://provider.example',
            apiKey: 'key',
            metadata: {
                successPath: 'generic.code',
                successValue: 'never',
                broadbandSuccessPath: 'purchase.code',
                broadbandSuccessValue: '00',
                broadbandStatusPath: 'purchase.status',
                broadbandTransactionIdPath: 'purchase.reference'
            }
        });
        const result = adapter.mapResponse({
            purchase: { code: '00', status: 'delivered', reference: 'P-1' },
            generic: { code: 'wrong' }
        }, 'broadband');
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'delivered');
        assert.strictEqual(result.transactionId, 'P-1');
        const malformed = normalizeProviderOutcome(adapter.mapResponse(null, 'broadband'));
        assert.strictEqual(malformed.outcome, PROVIDER_OUTCOMES.UNKNOWN);
    });

    await test('Universal Broadband verification rejects contradictory outcomes', () => {
        const adapter = new UniversalAdapter({
            metadata: {
                broadbandVerifySuccessPath: 'code',
                broadbandVerifySuccessValue: '00',
                broadbandVerifyFailurePath: 'state',
                broadbandVerifyFailureValue: 'failed'
            }
        });
        const result = adapter.mapVerificationResponse({ code: '00', state: 'failed' });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.outcome, PROVIDER_OUTCOMES.UNKNOWN);
    });

    await test('Universal Broadband purchase rejects contradictory outcomes', () => {
        const adapter = new UniversalAdapter({
            metadata: {
                broadbandSuccessPath: 'code',
                broadbandSuccessValue: '00',
                broadbandFailurePath: 'state',
                broadbandFailureValue: 'failed'
            }
        });
        const result = adapter.mapResponse({ code: '00', state: 'failed' }, 'broadband');
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.outcome, PROVIDER_OUTCOMES.UNKNOWN);
    });

    await test('Legacy Universal failure statuses remain unknown without explicit mapping', () => {
        const adapter = new UniversalAdapter({
            metadata: { statusPath: 'status' }
        });
        const result = adapter.mapResponse({ status: 'failed' });
        assert.strictEqual(result.outcome, PROVIDER_OUTCOMES.UNKNOWN);
    });

    await test('Universal Broadband verification maps amount only when configured', () => {
        const input = { serviceID: 'BB', variation_code: 'PLAN', identifier: '1234', amount: 1500 };
        const withoutAmountMap = new UniversalAdapter({ metadata: {} });
        assert.deepStrictEqual(withoutAmountMap._buildBroadbandVerificationPayload(input), {
            serviceID: 'BB', variation_code: 'PLAN', identifier: '1234'
        });
        const withAmountMap = new UniversalAdapter({
            metadata: {
                broadbandVerifyFieldMap: {
                    serviceID: 'service',
                    variation_code: 'plan',
                    identifier: 'customer',
                    amount: 'value'
                }
            }
        });
        assert.deepStrictEqual(withAmountMap._buildBroadbandVerificationPayload(input), {
            service: 'BB', plan: 'PLAN', customer: '1234', value: 1500
        });
    });

    await test('Identifier and amount policies normalize and fail closed', () => {
        assert.strictEqual(normalizeIdentifier(' AB-123 ', {
            label: 'Subscriber ID',
            normalization: 'uppercase',
            pattern: '^AB-\\d{3}$'
        }), 'AB-123');
        assert.strictEqual(normalizeAmount('1500', 'amount', {
            min: 1000,
            max: 5000,
            step: 500,
            currency: 'NGN'
        }), 1500);
        assert.throws(() => normalizeAmount(1250, 'amount', {
            min: 1000,
            max: 5000,
            step: 500,
            currency: 'NGN'
        }), /steps of 500/);
        assert.throws(() => normalizeAmount(1000.001, 'amount', {
            min: 1000,
            max: 5000,
            step: 1,
            currency: 'NGN'
        }), /decimal places/);
        assert.throws(() => normalizeAmount(1000, 'amount', {
            min: 100,
            max: undefined,
            step: 100,
            currency: 'NGN'
        }), /policy is invalid/);
        assert.strictEqual(normalizeAmount(1024.09, 'amount', {
            min: 1000,
            max: 5000,
            step: 0.01,
            currency: 'NGN'
        }), 1024.09);
        assert.throws(() => normalizeIdentifier(`${'a'.repeat(40)}!`, {
            label: 'Subscriber ID',
            pattern: '^(a+)+$'
        }), /format is invalid/);
        assert.throws(() => normalizeIdentifier(`${'a'.repeat(200)}!`, {
            label: 'Subscriber ID',
            pattern: '^a{0,100}a{0,100}a{0,100}b$'
        }), /format is invalid/);
        assert.strictEqual(normalizeIdentifier('0803-123 4567', {
            label: 'Phone', normalization: 'digits_only', kind: 'numeric'
        }), '08031234567');
        assert.throws(() => normalizeIdentifier('0803A1234567', {
            label: 'Phone', normalization: 'digits_only', kind: 'numeric'
        }), /unsupported characters/);
        assert.throws(() => normalizeIdentifier('   ', {
            label: 'Customer ID', normalization: 'none'
        }), /required/);
    });

    await test('Verification context is opaque, user-bound, and tamper-resistant', () => {
        const user = { _id: new mongoose.Types.ObjectId(), authVersion: 2 };
        const canonicalServiceId = String(new mongoose.Types.ObjectId());
        const claims = {
            canonicalServiceId,
            planId: canonicalServiceId,
            serviceIdentityId: String(new mongoose.Types.ObjectId()),
            offerId: String(new mongoose.Types.ObjectId()),
            providerId: String(new mongoose.Types.ObjectId()),
            providerCode: 'PLAN',
            providerServiceCode: 'BROADBAND',
            providerAmount: 900,
            identifier: 'SECRET-SUBSCRIBER-ID',
            contactPhone: '08012345678',
            purchaseMode: 'plan',
            verificationMode: 'required',
            verificationEvidenceRequired: false,
            identityUpdatedAt: 1,
            quotedPrice: 1000,
            offerUpdatedAt: 1,
            providerRoutingVersion: 1
        };
        const context = issueBroadbandVerificationContext({ user, ttlSeconds: 300, jti: 'context-jti', claims });
        assert.ok(isEncrypted(context));
        assert.ok(!context.includes(claims.identifier));
        assert.strictEqual(verifyBroadbandVerificationContext(context, { user, maxTtlSeconds: 300 }).jti, 'context-jti');
        assert.throws(() => verifyBroadbandVerificationContext(`${context}x`, { user, maxTtlSeconds: 300 }), /Invalid or expired/);
        assert.throws(() => verifyBroadbandVerificationContext(context, {
            user: { _id: new mongoose.Types.ObjectId(), authVersion: 2 },
            maxTtlSeconds: 300
        }), /Invalid or expired/);
    });

    await test('Plain signed JWTs cannot replace encrypted verification contexts', () => {
        const user = { _id: new mongoose.Types.ObjectId(), authVersion: 0 };
        const token = jwt.sign({ purpose: 'broadband_verification' }, process.env.JWT_SECRET, { expiresIn: 300 });
        assert.throws(() => verifyBroadbandVerificationContext(token, { user, maxTtlSeconds: 300 }), /Invalid or expired/);
    });

    await test('Expired Broadband verification contexts are rejected', () => {
        const user = { _id: new mongoose.Types.ObjectId(), authVersion: 0 };
        const canonicalServiceId = String(new mongoose.Types.ObjectId());
        const context = issueBroadbandVerificationContext({
            user,
            ttlSeconds: -1,
            claims: {
                canonicalServiceId,
                planId: canonicalServiceId,
                serviceIdentityId: String(new mongoose.Types.ObjectId()),
                offerId: String(new mongoose.Types.ObjectId()),
                providerId: String(new mongoose.Types.ObjectId()),
                providerCode: 'PLAN', providerServiceCode: 'BROADBAND', providerAmount: 900,
                identifier: 'ID-1', contactPhone: '08012345678', purchaseMode: 'plan',
                verificationMode: 'none', verificationEvidenceRequired: false,
                identityUpdatedAt: 1, quotedPrice: 1000, offerUpdatedAt: 1, providerRoutingVersion: 1
            }
        });
        assert.throws(
            () => verifyBroadbandVerificationContext(context, { user, maxTtlSeconds: 1800 }),
            /Invalid or expired/
        );
    });

    await test('Broadband request fingerprint is deterministic and covers material intent without PIN', () => {
        const base = {
            canonicalServiceId: String(new mongoose.Types.ObjectId()),
            planId: String(new mongoose.Types.ObjectId()),
            serviceIdentityId: String(new mongoose.Types.ObjectId()),
            identifier: 'SUBSCRIBER-1',
            purchaseMode: 'plan',
            jti: 'same-key',
            contactPhone: '08012345678'
        };
        base.canonicalServiceId = base.planId;
        const request = { expectedPrice: 1000, pin: '1234' };
        const fingerprint = createBroadbandRequestFingerprint(base, request);
        assert.strictEqual(fingerprint, createBroadbandRequestFingerprint(base, request));
        assert.notStrictEqual(fingerprint, createBroadbandRequestFingerprint({
            ...base, planId: String(new mongoose.Types.ObjectId()), canonicalServiceId: String(new mongoose.Types.ObjectId())
        }, request));
        assert.notStrictEqual(fingerprint, createBroadbandRequestFingerprint({ ...base, identifier: 'SUBSCRIBER-2' }, request));
        assert.notStrictEqual(fingerprint, createBroadbandRequestFingerprint(base, { ...request, expectedPrice: 1001 }));
        assert.strictEqual(Object.prototype.hasOwnProperty.call(buildBroadbandPurchaseIntent(base, request), 'pin'), false);

        const amountContext = {
            ...base,
            purchaseMode: 'amount',
            planId: undefined,
            canonicalServiceId: String(new mongoose.Types.ObjectId())
        };
        assert.notStrictEqual(
            createBroadbandRequestFingerprint(amountContext, { expectedPrice: 1523, amount: 1500 }),
            createBroadbandRequestFingerprint(amountContext, { expectedPrice: 1523, amount: 1600 })
        );
    });

    await test('AMOUNT verification supplies normalized amount and optional evidence can be absent', async () => {
        const originals = {
            serviceFind: Service.find,
            identityFindOne: ServiceIdentity.findOne,
            userFindById: User.findById,
            selectBestOffer: procurementService.selectBestOffer,
            getAdapterInstance: providerService.getAdapterInstance,
            resolvePricing: pricingService.resolvePricing,
            inspectService: broadbandReadiness.inspectService
        };
        const user = { id: new mongoose.Types.ObjectId(), authVersion: 0 };
        const identity = {
            _id: new mongoose.Types.ObjectId(),
            status: true,
            purchaseMode: 'amount',
            identifierPolicy: { label: 'Subscriber ID', kind: 'numeric', normalization: 'digits_only' },
            verificationPolicy: { mode: 'required', evidenceRequired: false, ttlSeconds: 300 },
            amountPolicy: { min: 1000, max: 5000, step: 100, currency: 'NGN' }
        };
        const service = {
            _id: new mongoose.Types.ObjectId(), identityId: identity._id,
            category: 'broadband', status: true, code: 'BB_AMOUNT', name: 'Broadband Top-up'
        };
        const updatedAt = new Date('2026-09-28T00:00:00.000Z');
        const offer = {
            _id: new mongoose.Types.ObjectId(), serviceId: service._id,
            providerCode: 'TOPUP', providerServiceCode: 'BROADBAND',
            costMode: 'dynamic', costPrice: 0, currency: 'NGN', updatedAt,
            providerId: {
                _id: new mongoose.Types.ObjectId(), name: 'Provider', status: 'active',
                adapterType: 'universal', updatedAt
            }
        };
        let verificationPayload;
        try {
            Service.find = async () => [service];
            ServiceIdentity.findOne = async () => identity;
            User.findById = async () => ({ _id: user.id, status: true, authVersion: 0, phone: '08012345678' });
            procurementService.selectBestOffer = async () => offer;
            providerService.getAdapterInstance = async () => ({
                verifyBroadband: async payload => {
                    verificationPayload = payload;
                    return { success: true, outcome: PROVIDER_OUTCOMES.SUCCESS, customer: { name: 'Customer' } };
                }
            });
            pricingService.resolvePricing = async () => ({ salePrice: 1523, retailPrice: 1523, savings: 0 });
            broadbandReadiness.inspectService = async () => ({ ready: true, errors: [] });

            await assert.rejects(broadbandService.verify(user, {
                serviceIdentityId: String(identity._id),
                planId: String(service._id),
                identifier: '08031234567',
                amount: 1500
            }), /Plan ID is not accepted/);
            const result = await broadbandService.verify(user, {
                serviceIdentityId: String(identity._id), identifier: '0803-123 4567', amount: '1500.00'
            });
            assert.strictEqual(verificationPayload.amount, 1500);
            assert.strictEqual(result.planId, undefined);
            assert.ok(result.verificationContext);
        } finally {
            Service.find = originals.serviceFind;
            ServiceIdentity.findOne = originals.identityFindOne;
            User.findById = originals.userFindById;
            procurementService.selectBestOffer = originals.selectBestOffer;
            providerService.getAdapterInstance = originals.getAdapterInstance;
            pricingService.resolvePricing = originals.resolvePricing;
            broadbandReadiness.inspectService = originals.inspectService;
        }
    });

    await test('Evidence-required verification fails closed without normalized evidence', async () => {
        const originals = {
            serviceFindOne: Service.findOne,
            identityFindOne: ServiceIdentity.findOne,
            userFindById: User.findById,
            selectBestOffer: procurementService.selectBestOffer,
            getAdapterInstance: providerService.getAdapterInstance,
            inspectService: broadbandReadiness.inspectService
        };
        const user = { id: new mongoose.Types.ObjectId(), authVersion: 0 };
        const identity = {
            _id: new mongoose.Types.ObjectId(), status: true, purchaseMode: 'plan',
            identifierPolicy: { label: 'Subscriber ID' },
            verificationPolicy: { mode: 'required', evidenceRequired: true, ttlSeconds: 300 }
        };
        const service = {
            _id: new mongoose.Types.ObjectId(), identityId: identity._id,
            category: 'broadband', status: true, code: 'BB_PLAN'
        };
        const updatedAt = new Date('2026-09-28T00:00:00.000Z');
        const offer = {
            _id: new mongoose.Types.ObjectId(), serviceId: service._id,
            providerCode: 'PLAN', providerServiceCode: 'BROADBAND', costMode: 'fixed',
            costPrice: 900, currency: 'NGN', updatedAt,
            providerId: { _id: new mongoose.Types.ObjectId(), name: 'Provider', adapterType: 'universal', updatedAt }
        };
        try {
            Service.findOne = async () => service;
            ServiceIdentity.findOne = async () => identity;
            User.findById = async () => ({ _id: user.id, status: true, authVersion: 0, phone: '08012345678' });
            procurementService.selectBestOffer = async () => offer;
            providerService.getAdapterInstance = async () => ({
                verifyBroadband: async () => ({ success: true, outcome: PROVIDER_OUTCOMES.SUCCESS })
            });
            broadbandReadiness.inspectService = async () => ({ ready: true, errors: [] });

            await assert.rejects(broadbandService.verify(user, {
                serviceIdentityId: String(identity._id),
                planId: String(service._id),
                identifier: 'ID-1',
                amount: 1000
            }), /Amount is not accepted/);
            await assert.rejects(broadbandService.verify(user, {
                serviceIdentityId: String(identity._id), planId: String(service._id), identifier: 'ID-1'
            }), /evidence is required/);
        } finally {
            Service.findOne = originals.serviceFindOne;
            ServiceIdentity.findOne = originals.identityFindOne;
            User.findById = originals.userFindById;
            procurementService.selectBestOffer = originals.selectBestOffer;
            providerService.getAdapterInstance = originals.getAdapterInstance;
            broadbandReadiness.inspectService = originals.inspectService;
        }
    });

    await test('AMOUNT purchase rejects an amount different from its signed context', async () => {
        const originals = {
            serviceFindOne: Service.findOne,
            identityFindOne: ServiceIdentity.findOne,
            findIdempotentTransaction: purchaseService.findIdempotentTransaction,
            processPurchase: purchaseService.processPurchase,
            inspectService: broadbandReadiness.inspectService
        };
        const user = { id: new mongoose.Types.ObjectId(), authVersion: 0 };
        const identity = {
            _id: new mongoose.Types.ObjectId(), status: true, purchaseMode: 'amount',
            identifierPolicy: { label: 'Subscriber ID' },
            verificationPolicy: { mode: 'none', evidenceRequired: false, ttlSeconds: 300 },
            amountPolicy: { min: 1000, max: 5000, step: 100, currency: 'NGN' }
        };
        const service = {
            _id: new mongoose.Types.ObjectId(), identityId: identity._id,
            category: 'broadband', status: true, code: 'BB_AMOUNT'
        };
        const context = issueBroadbandVerificationContext({
            user,
            ttlSeconds: 300,
            jti: 'amount-jti',
            claims: {
                canonicalServiceId: String(service._id),
                serviceIdentityId: String(identity._id),
                offerId: String(new mongoose.Types.ObjectId()),
                providerId: String(new mongoose.Types.ObjectId()),
                providerCode: 'TOPUP', providerServiceCode: 'BROADBAND', providerAmount: 1500,
                identifier: 'ID-1', contactPhone: '08012345678', purchaseMode: 'amount', amount: 1500,
                verificationMode: 'none', verificationEvidenceRequired: false,
                identityUpdatedAt: 0, quotedPrice: 1523, offerUpdatedAt: 1, providerRoutingVersion: 1
            }
        });
        let purchases = 0;
        try {
            purchaseService.findIdempotentTransaction = async () => null;
            Service.findOne = async () => service;
            ServiceIdentity.findOne = async () => identity;
            broadbandReadiness.inspectService = async () => ({ ready: true, errors: [] });
            purchaseService.processPurchase = async () => { purchases++; };
            await assert.rejects(broadbandService.purchase(user, {
                verificationContext: context,
                idempotencyKey: 'amount-jti',
                pin: '1234',
                expectedPrice: 1523,
                amount: 1600
            }), /does not match/);
            assert.strictEqual(purchases, 0);
        } finally {
            Service.findOne = originals.serviceFindOne;
            ServiceIdentity.findOne = originals.identityFindOne;
            purchaseService.findIdempotentTransaction = originals.findIdempotentTransaction;
            purchaseService.processPurchase = originals.processPurchase;
            broadbandReadiness.inspectService = originals.inspectService;
        }
    });

    await test('Procurement skips a higher-priority provider without required capability', async () => {
        const originalFind = ProviderOffer.find;
        const unsupported = {
            _id: new mongoose.Types.ObjectId(),
            providerId: { status: 'active', adapterType: 'universal', metadata: {} }
        };
        const supported = {
            _id: new mongoose.Types.ObjectId(),
            providerId: {
                status: 'active',
                adapterType: 'universal',
                metadata: {
                    broadbandPurchaseUrl: '/buy',
                    broadbandSuccessPath: 'code',
                    broadbandSuccessValue: '00',
                    broadbandPendingPath: 'status',
                    broadbandPendingValue: 'pending',
                    broadbandFailurePath: 'status',
                    broadbandFailureValue: 'failed',
                    queryUrl: '/query',
                    querySuccessPath: 'code',
                    querySuccessValue: '00',
                    queryPendingPath: 'status',
                    queryPendingValue: 'pending',
                    queryFailurePath: 'status',
                    queryFailureValue: 'failed'
                }
            }
        };
        try {
            ProviderOffer.find = () => chainResult([unsupported, supported]);
            const selected = await procurementService.selectBestOffer(new mongoose.Types.ObjectId(), {
                requiredOperations: [PROVIDER_OPERATIONS.PURCHASE_BROADBAND]
            });
            assert.strictEqual(selected, supported);
        } finally {
            ProviderOffer.find = originalFind;
        }
    });

    await test('Procurement skips a malformed higher-priority Broadband offer', async () => {
        const originalFind = ProviderOffer.find;
        const malformed = { _id: 'high', priority: 100, providerId: { status: 'active' } };
        const eligible = { _id: 'low', priority: 10, providerId: { status: 'active' } };
        try {
            ProviderOffer.find = () => chainResult([malformed, eligible]);
            const selected = await procurementService.selectBestOffer(new mongoose.Types.ObjectId(), {
                offerValidator: offer => offer === eligible
            });
            assert.strictEqual(selected, eligible);
        } finally {
            ProviderOffer.find = originalFind;
        }
    });

    await test('Broadband verify returns only safe data and purchase binds its exact context', async () => {
        const originals = {
            serviceFindOne: Service.findOne,
            identityFindOne: ServiceIdentity.findOne,
            userFindById: User.findById,
            selectBestOffer: procurementService.selectBestOffer,
            getAdapterInstance: providerService.getAdapterInstance,
            resolvePricing: pricingService.resolvePricing,
            processPurchase: purchaseService.processPurchase,
            findIdempotentTransaction: purchaseService.findIdempotentTransaction,
            inspectService: broadbandReadiness.inspectService
        };
        const user = { id: new mongoose.Types.ObjectId(), authVersion: 0, roles: ['user'], phone: '08012345678' };
        const identity = {
            _id: new mongoose.Types.ObjectId(),
            status: true,
            purchaseMode: 'plan',
            identifierPolicy: { label: 'Subscriber ID', normalization: 'uppercase' },
            verificationPolicy: { mode: 'required', evidenceRequired: true, ttlSeconds: 300 }
        };
        const service = {
            _id: new mongoose.Types.ObjectId(),
            identityId: identity._id,
            category: 'broadband',
            status: true,
            code: 'BB_PLAN',
            name: 'Broadband Plan',
            price: 10000
        };
        const updatedAt = new Date('2026-09-28T00:00:00.000Z');
        const offer = {
            _id: new mongoose.Types.ObjectId(),
            serviceId: service._id,
            providerCode: 'PLAN-1',
            providerServiceCode: 'BROADBAND',
            costMode: 'fixed',
            costPrice: 9000,
            currency: 'NGN',
            updatedAt,
            providerId: {
                _id: new mongoose.Types.ObjectId(),
                name: 'Hidden Provider',
                status: 'active',
                adapterType: 'universal',
                updatedAt
            }
        };
        let purchaseArgs;
        let providerPayload;
        try {
            Service.findOne = async () => service;
            ServiceIdentity.findOne = async () => identity;
            User.findById = async () => ({ ...user, _id: user.id, status: true, accountType: 'retail' });
            procurementService.selectBestOffer = async () => offer;
            providerService.getAdapterInstance = async () => ({
                verifyBroadband: async () => ({
                    success: true,
                    outcome: PROVIDER_OUTCOMES.SUCCESS,
                    customer: { name: 'Test Customer' },
                    verificationReference: 'PRIVATE-VERIFY-REF',
                    raw: { provider: 'must-not-leak' }
                })
            });
            pricingService.resolvePricing = async () => ({ salePrice: 9500, retailPrice: 10000, savings: 500 });
            purchaseService.processPurchase = async (userId, args) => {
                purchaseArgs = { userId, ...args };
                return { success: true, status: 'success', data: { transactionId: 'T-1' } };
            };
            purchaseService.findIdempotentTransaction = async () => null;
            broadbandReadiness.inspectService = async () => ({ ready: true, errors: [] });

            const verified = await broadbandService.verify(user, {
                serviceIdentityId: String(identity._id),
                planId: String(service._id),
                identifier: ' subscriber-1 '
            });
            assert.strictEqual(verified.customerName, 'Test Customer');
            assert.strictEqual(verified.price.salePrice, 9500);
            assert.strictEqual(verified.provider, undefined);
            assert.strictEqual(verified.raw, undefined);
            assert.ok(verified.verificationContext);

            await assert.rejects(broadbandService.purchase(user, {
                verificationContext: verified.verificationContext,
                idempotencyKey: verified.idempotencyKey,
                pin: '1234',
                expectedPrice: 9500,
                amount: 9500
            }), /Amount is not accepted/);
            await broadbandService.purchase(user, {
                verificationContext: verified.verificationContext,
                idempotencyKey: verified.idempotencyKey,
                pin: '1234',
                expectedPrice: 9500
            });
            assert.strictEqual(purchaseArgs.requiredProviderOfferId, String(offer._id));
            assert.strictEqual(purchaseArgs.idempotencyKey, `bbv:${verified.idempotencyKey}`);
            const balanceRefreshedOffer = {
                ...offer,
                providerId: {
                    ...offer.providerId,
                    updatedAt: new Date('2026-09-29T00:00:00.000Z')
                }
            };
            const boundContext = verifyBroadbandVerificationContext(verified.verificationContext, {
                user,
                maxTtlSeconds: 1800
            });
            assert.strictEqual(String(balanceRefreshedOffer.providerId._id), boundContext.providerId);
            assert.strictEqual(new Date(balanceRefreshedOffer.updatedAt).getTime(), boundContext.offerUpdatedAt);
            assert.strictEqual(Number(balanceRefreshedOffer.providerId.routingVersion || 1), boundContext.providerRoutingVersion);
            await purchaseArgs.providerSelectionValidator(balanceRefreshedOffer);
            assert.throws(() => purchaseArgs.providerSelectionValidator({
                ...balanceRefreshedOffer,
                providerId: { ...balanceRefreshedOffer.providerId, routingVersion: 2 }
            }), /configuration changed/);
            await purchaseArgs.providerCall('REQ-1', 9000, {
                providerServiceCode: 'BROADBAND',
                providerCode: 'PLAN-1',
                adapter: {
                    purchaseBroadband: async payload => {
                        providerPayload = payload;
                        return { success: true };
                    }
                }
            });
            assert.strictEqual(providerPayload.identifier, 'SUBSCRIBER-1');
            assert.strictEqual(providerPayload.verification_reference, 'PRIVATE-VERIFY-REF');
        } finally {
            Service.findOne = originals.serviceFindOne;
            ServiceIdentity.findOne = originals.identityFindOne;
            User.findById = originals.userFindById;
            procurementService.selectBestOffer = originals.selectBestOffer;
            providerService.getAdapterInstance = originals.getAdapterInstance;
            pricingService.resolvePricing = originals.resolvePricing;
            purchaseService.processPurchase = originals.processPurchase;
            purchaseService.findIdempotentTransaction = originals.findIdempotentTransaction;
            broadbandReadiness.inspectService = originals.inspectService;
        }
    });

    await test('PurchaseService replay returns before procurement or dispatch', async () => {
        const originals = {
            verifyPin: pinService.verifyPin,
            userFindById: User.findById,
            transactionFindOne: Transaction.findOne,
            selectBestOffer: procurementService.selectBestOffer,
            assertInstalled: transactionIdempotencyIndexService.assertInstalled
        };
        let selected = false;
        let dispatched = false;
        try {
            pinService.verifyPin = async () => true;
            User.findById = async () => ({ _id: new mongoose.Types.ObjectId() });
            Transaction.findOne = async () => ({
                _id: new mongoose.Types.ObjectId(),
                transactionId: 'ZNT-23456789ABCD',
                refId: 'ZNT-R-23456789ABCDEFGH',
                status: 'pending',
                providerOutcome: PROVIDER_OUTCOMES.PENDING,
                requestFingerprint: 'a'.repeat(64)
            });
            transactionIdempotencyIndexService.assertInstalled = async () => true;
            procurementService.selectBestOffer = async () => {
                selected = true;
                return null;
            };

            const result = await purchaseService.processPurchase(new mongoose.Types.ObjectId(), {
                type: 'broadband',
                canonicalService: { _id: new mongoose.Types.ObjectId(), status: true },
                idempotencyKey: 'bbv:existing',
                requestFingerprint: 'a'.repeat(64),
                pin: '1234',
                providerCall: async () => {
                    dispatched = true;
                }
            });
            assert.strictEqual(result.status, 'pending');
            assert.strictEqual(selected, false);
            assert.strictEqual(dispatched, false);
        } finally {
            pinService.verifyPin = originals.verifyPin;
            User.findById = originals.userFindById;
            Transaction.findOne = originals.transactionFindOne;
            procurementService.selectBestOffer = originals.selectBestOffer;
            transactionIdempotencyIndexService.assertInstalled = originals.assertInstalled;
        }
    });

    await test('Broadband replay requires the same material request fingerprint', async () => {
        const originalFind = purchaseService.findIdempotentTransaction;
        const user = { id: new mongoose.Types.ObjectId(), authVersion: 0 };
        const canonicalServiceId = String(new mongoose.Types.ObjectId());
        const context = issueBroadbandVerificationContext({
            user,
            ttlSeconds: 300,
            jti: 'existing-jti',
            claims: {
                canonicalServiceId,
                planId: canonicalServiceId,
                serviceIdentityId: String(new mongoose.Types.ObjectId()),
                offerId: String(new mongoose.Types.ObjectId()),
                providerId: String(new mongoose.Types.ObjectId()),
                providerCode: 'PLAN',
                providerServiceCode: 'BROADBAND',
                providerAmount: 900,
                identifier: 'SUBSCRIBER-1',
                contactPhone: '08012345678',
                purchaseMode: 'plan',
                verificationMode: 'required',
                verificationEvidenceRequired: false,
                identityUpdatedAt: 1,
                quotedPrice: 1000,
                offerUpdatedAt: 1,
                providerRoutingVersion: 1
            }
        });
        const decoded = verifyBroadbandVerificationContext(context, { user, maxTtlSeconds: 1800 });
        const request = { verificationContext: context, expectedPrice: 1000 };
        try {
            purchaseService.findIdempotentTransaction = async () => ({
                _id: new mongoose.Types.ObjectId(),
                refId: 'REF',
                transactionId: 'EXISTING',
                status: 'success',
                providerOutcome: PROVIDER_OUTCOMES.SUCCESS,
                requestFingerprint: createBroadbandRequestFingerprint(decoded, request)
            });
            const result = await broadbandService.replay(user, 'existing-jti', request);
            assert.strictEqual(result.status, 'success');
            await assert.rejects(
                broadbandService.replay(user, 'existing-jti', { ...request, expectedPrice: 1001 }),
                error => error.code === 'IDEMPOTENCY_CONFLICT' && error.statusCode === 409
            );
        } finally {
            purchaseService.findIdempotentTransaction = originalFind;
        }
    });

    await test('Broadband replay conflicts on changed plan, identifier, or amount', async () => {
        const originalFind = purchaseService.findIdempotentTransaction;
        const user = { id: new mongoose.Types.ObjectId(), authVersion: 0 };
        const serviceIdentityId = String(new mongoose.Types.ObjectId());
        const offerId = String(new mongoose.Types.ObjectId());
        const providerId = String(new mongoose.Types.ObjectId());
        const issue = claims => issueBroadbandVerificationContext({
            user,
            ttlSeconds: 300,
            jti: 'shared-jti',
            claims: {
                serviceIdentityId,
                offerId,
                providerId,
                providerCode: 'CODE',
                providerServiceCode: 'BROADBAND',
                contactPhone: '08012345678',
                verificationMode: 'none',
                verificationEvidenceRequired: false,
                identityUpdatedAt: 1,
                offerUpdatedAt: 1,
                providerRoutingVersion: 1,
                ...claims
            }
        });
        const planId = String(new mongoose.Types.ObjectId());
        const originalContext = issue({
            canonicalServiceId: planId,
            planId,
            providerAmount: 900,
            identifier: 'ID-1',
            purchaseMode: 'plan',
            quotedPrice: 1000
        });
        const originalRequest = { verificationContext: originalContext, expectedPrice: 1000 };
        const decoded = verifyBroadbandVerificationContext(originalContext, { user, maxTtlSeconds: 1800 });
        let storedFingerprint = createBroadbandRequestFingerprint(decoded, originalRequest);
        try {
            purchaseService.findIdempotentTransaction = async () => ({
                status: 'success',
                requestFingerprint: storedFingerprint
            });
            const changedPlanId = String(new mongoose.Types.ObjectId());
            const changedPlan = issue({
                canonicalServiceId: changedPlanId,
                planId: changedPlanId,
                providerAmount: 900,
                identifier: 'ID-1',
                purchaseMode: 'plan',
                quotedPrice: 1000
            });
            const changedIdentifier = issue({
                canonicalServiceId: planId,
                planId,
                providerAmount: 900,
                identifier: 'ID-2',
                purchaseMode: 'plan',
                quotedPrice: 1000
            });
            const amountServiceId = String(new mongoose.Types.ObjectId());
            const originalAmount = issue({
                canonicalServiceId: amountServiceId,
                providerAmount: 1500,
                identifier: 'ID-1',
                purchaseMode: 'amount',
                amount: 1500,
                quotedPrice: 1523
            });
            const changedAmount = issue({
                canonicalServiceId: amountServiceId,
                providerAmount: 1600,
                identifier: 'ID-1',
                purchaseMode: 'amount',
                amount: 1600,
                quotedPrice: 1523
            });
            for (const request of [
                { verificationContext: changedPlan, expectedPrice: 1000 },
                { verificationContext: changedIdentifier, expectedPrice: 1000 }
            ]) {
                await assert.rejects(
                    broadbandService.replay(user, 'shared-jti', request),
                    error => error.code === 'IDEMPOTENCY_CONFLICT' && error.statusCode === 409
                );
            }
            const decodedAmount = verifyBroadbandVerificationContext(originalAmount, { user, maxTtlSeconds: 1800 });
            storedFingerprint = createBroadbandRequestFingerprint(decodedAmount, {
                verificationContext: originalAmount,
                expectedPrice: 1523,
                amount: 1500
            });
            await assert.rejects(
                broadbandService.replay(user, 'shared-jti', {
                    verificationContext: changedAmount,
                    expectedPrice: 1523,
                    amount: 1600
                }),
                error => error.code === 'IDEMPOTENCY_CONFLICT' && error.statusCode === 409
            );
        } finally {
            purchaseService.findIdempotentTransaction = originalFind;
        }
    });

    await test('Idempotency lookup remains scoped by authenticated user', async () => {
        const originals = {
            transactionFindOne: Transaction.findOne,
            assertInstalled: transactionIdempotencyIndexService.assertInstalled
        };
        const filters = [];
        try {
            transactionIdempotencyIndexService.assertInstalled = async () => true;
            Transaction.findOne = filter => {
                filters.push(filter);
                return { select: async () => null };
            };
            const firstUser = new mongoose.Types.ObjectId();
            const secondUser = new mongoose.Types.ObjectId();
            await purchaseService.findIdempotentTransaction(firstUser, 'bbv:same-key');
            await purchaseService.findIdempotentTransaction(secondUser, 'bbv:same-key');
            assert.strictEqual(filters[0].idempotencyKey, filters[1].idempotencyKey);
            assert.notStrictEqual(String(filters[0].userId), String(filters[1].userId));
        } finally {
            Transaction.findOne = originals.transactionFindOne;
            transactionIdempotencyIndexService.assertInstalled = originals.assertInstalled;
        }
    });

    await test('Pre-guard replay does not dispatch an undispatched request', async () => {
        const originalFind = purchaseService.findIdempotentTransaction;
        const user = { id: new mongoose.Types.ObjectId(), authVersion: 0 };
        const canonicalServiceId = String(new mongoose.Types.ObjectId());
        const context = issueBroadbandVerificationContext({
            user,
            ttlSeconds: 300,
            jti: 'pre-guard-jti',
            claims: {
                canonicalServiceId,
                planId: canonicalServiceId,
                serviceIdentityId: String(new mongoose.Types.ObjectId()),
                offerId: String(new mongoose.Types.ObjectId()),
                providerId: String(new mongoose.Types.ObjectId()),
                providerCode: 'PLAN', providerServiceCode: 'BROADBAND', providerAmount: 900,
                identifier: 'ID-1', contactPhone: '08012345678', purchaseMode: 'plan',
                verificationMode: 'none', verificationEvidenceRequired: false,
                identityUpdatedAt: 1, quotedPrice: 1000, offerUpdatedAt: 1, providerRoutingVersion: 1
            }
        });
        const request = { verificationContext: context, expectedPrice: 1000 };
        const decoded = verifyBroadbandVerificationContext(context, { user, maxTtlSeconds: 1800 });
        try {
            purchaseService.findIdempotentTransaction = async () => ({
                status: 'pending',
                dispatchState: 'not_dispatched',
                requestFingerprint: createBroadbandRequestFingerprint(decoded, request)
            });
            assert.strictEqual(await broadbandService.replay(user, 'pre-guard-jti', request), null);
        } finally {
            purchaseService.findIdempotentTransaction = originalFind;
        }
    });

    await test('Guarded replay resumes an encrypted not-dispatched request with matching intent', async () => {
        const originals = {
            findIdempotentTransaction: purchaseService.findIdempotentTransaction,
            getAdapterInstance: providerService.getAdapterInstance,
            transactionUpdateOne: Transaction.updateOne,
            resolveExistingTransaction: purchaseService.resolveExistingTransaction,
            verifyPin: pinService.verifyPin
        };
        const user = { id: new mongoose.Types.ObjectId(), authVersion: 0 };
        const canonicalServiceId = String(new mongoose.Types.ObjectId());
        const context = issueBroadbandVerificationContext({
            user,
            ttlSeconds: 300,
            jti: 'existing-jti',
            claims: {
                canonicalServiceId,
                planId: canonicalServiceId,
                serviceIdentityId: String(new mongoose.Types.ObjectId()),
                offerId: String(new mongoose.Types.ObjectId()),
                providerId: String(new mongoose.Types.ObjectId()),
                providerCode: 'PLAN-1',
                providerServiceCode: 'BROADBAND',
                providerAmount: 900,
                identifier: 'SUBSCRIBER-1',
                contactPhone: '08012345678',
                purchaseMode: 'plan',
                verificationMode: 'required',
                verificationEvidenceRequired: false,
                identityUpdatedAt: 1,
                quotedPrice: 1000,
                offerUpdatedAt: 1,
                providerRoutingVersion: 1
            }
        });
        const request = { verificationContext: context, expectedPrice: 1000, pin: '1234' };
        const decoded = verifyBroadbandVerificationContext(context, { user, maxTtlSeconds: 1800 });
        const transaction = {
            _id: new mongoose.Types.ObjectId(),
            status: 'pending',
            dispatchState: 'not_dispatched',
            providerOutcome: PROVIDER_OUTCOMES.UNKNOWN,
            providerRequestId: 'ZNT-P-23456789ABCDEFGH',
            provider: 'Provider',
            providerId: new mongoose.Types.ObjectId(),
            providerAdapterType: 'universal',
            providerConfigSnapshot: { baseUrl: 'https://provider.example', metadata: {} },
            providerCredentialSnapshot: { apiKey: 'encrypted-key' },
            requestFingerprint: createBroadbandRequestFingerprint(decoded, request),
            recoveryPayload: require('../utils/crypto').encryptSecret(JSON.stringify({
                serviceID: 'BROADBAND',
                variation_code: 'PLAN-1',
                identifier: 'SUBSCRIBER-1',
                amount: 900,
                phone: '08012345678'
            }))
        };
        let providerPayload;
        let pinChecks = 0;
        const callOrder = [];
        try {
            purchaseService.findIdempotentTransaction = async () => transaction;
            pinService.verifyPin = async (userId, pin) => {
                callOrder.push('pin');
                pinChecks++;
                assert.strictEqual(String(userId), String(user.id));
                assert.strictEqual(pin, '1234');
            };
            providerService.getAdapterInstance = async () => {
                callOrder.push('adapter');
                return {
                    purchaseBroadband: async payload => {
                        callOrder.push('provider');
                        providerPayload = payload;
                        return { success: true, outcome: PROVIDER_OUTCOMES.SUCCESS };
                    }
                };
            };
            Transaction.updateOne = async () => {
                callOrder.push('claim');
                return { modifiedCount: 1 };
            };
            purchaseService.resolveExistingTransaction = async () => ({ success: true, status: 'success', data: {} });

            const result = await broadbandService.replay(
                user,
                'existing-jti',
                request,
                { allowResume: true }
            );
            assert.strictEqual(result.success, true);
            assert.strictEqual(pinChecks, 1);
            assert.deepStrictEqual(callOrder.slice(0, 4), ['pin', 'adapter', 'claim', 'provider']);
            assert.strictEqual(providerPayload.request_id, transaction.providerRequestId);
            assert.strictEqual(providerPayload.identifier, 'SUBSCRIBER-1');
        } finally {
            purchaseService.findIdempotentTransaction = originals.findIdempotentTransaction;
            providerService.getAdapterInstance = originals.getAdapterInstance;
            Transaction.updateOne = originals.transactionUpdateOne;
            purchaseService.resolveExistingTransaction = originals.resolveExistingTransaction;
            pinService.verifyPin = originals.verifyPin;
        }
    });

    await test('PIN verifier emits structured codes for expected customer failures', async () => {
        const originals = {
            userFindOne: User.findOne,
            compare: bcrypt.compare
        };
        try {
            User.findOne = () => ({ select: async () => null });
            await assert.rejects(
                pinService.verifyPin(new mongoose.Types.ObjectId(), '1234'),
                error => error.code === 'TRANSACTION_PIN_NOT_SET' && error.statusCode === 400
            );

            User.findOne = () => ({
                select: async () => ({ transactionPin: 'stored-hash' })
            });
            bcrypt.compare = async () => false;
            await assert.rejects(
                pinService.verifyPin(new mongoose.Types.ObjectId(), '0000'),
                error => error.code === 'TRANSACTION_PIN_INVALID' && error.statusCode === 400
            );
        } finally {
            User.findOne = originals.userFindOne;
            bcrypt.compare = originals.compare;
        }
    });

    await test('Missing or incorrect PIN cannot resume, dispatch, or debit an undispatched purchase', async () => {
        const originals = {
            findIdempotentTransaction: purchaseService.findIdempotentTransaction,
            getAdapterInstance: providerService.getAdapterInstance,
            transactionUpdateOne: Transaction.updateOne,
            verifyPin: pinService.verifyPin,
            walletDebit: walletService.debit
        };
        const user = { id: new mongoose.Types.ObjectId(), authVersion: 0 };
        const canonicalServiceId = String(new mongoose.Types.ObjectId());
        const context = issueBroadbandVerificationContext({
            user,
            ttlSeconds: 300,
            jti: 'pin-guard-jti',
            claims: {
                canonicalServiceId,
                planId: canonicalServiceId,
                serviceIdentityId: String(new mongoose.Types.ObjectId()),
                offerId: String(new mongoose.Types.ObjectId()),
                providerId: String(new mongoose.Types.ObjectId()),
                providerCode: 'PLAN-1', providerServiceCode: 'BROADBAND', providerAmount: 900,
                identifier: 'SUBSCRIBER-1', contactPhone: '08012345678', purchaseMode: 'plan',
                verificationMode: 'required', verificationEvidenceRequired: false,
                identityUpdatedAt: 1, quotedPrice: 1000, offerUpdatedAt: 1, providerRoutingVersion: 1
            }
        });
        const decoded = verifyBroadbandVerificationContext(context, { user, maxTtlSeconds: 1800 });
        const baseRequest = { verificationContext: context, expectedPrice: 1000 };
        const transaction = {
            _id: new mongoose.Types.ObjectId(),
            status: 'pending',
            dispatchState: 'not_dispatched',
            requestFingerprint: createBroadbandRequestFingerprint(decoded, baseRequest),
            recoveryPayload: encryptSecret(JSON.stringify({
                serviceID: 'BROADBAND', variation_code: 'PLAN-1', identifier: 'SUBSCRIBER-1',
                amount: 900, phone: '08012345678'
            }))
        };
        let adapterCalls = 0;
        let claims = 0;
        let debits = 0;
        try {
            purchaseService.findIdempotentTransaction = async () => transaction;
            providerService.getAdapterInstance = async () => { adapterCalls++; return {}; };
            Transaction.updateOne = async () => { claims++; return { modifiedCount: 1 }; };
            walletService.debit = async () => { debits++; };

            await assert.rejects(
                broadbandService.purchase(user, { ...baseRequest, idempotencyKey: 'pin-guard-jti' }),
                error => error.statusCode === 400 && /PIN is required/.test(error.message)
            );
            pinService.verifyPin = async () => {
                const error = new Error('Invalid transaction PIN');
                error.code = 'TRANSACTION_PIN_INVALID';
                error.statusCode = 400;
                throw error;
            };
            await assert.rejects(
                broadbandService.purchase(user, {
                    ...baseRequest,
                    idempotencyKey: 'pin-guard-jti',
                    pin: '0000'
                }),
                error => error.statusCode === 400 && /Invalid transaction PIN/.test(error.message)
            );
            pinService.verifyPin = async () => {
                const error = new Error('Transaction PIN is temporarily locked. Please try again later.');
                error.code = 'TRANSACTION_PIN_LOCKED';
                error.statusCode = 429;
                throw error;
            };
            await assert.rejects(
                broadbandService.purchase(user, {
                    ...baseRequest,
                    idempotencyKey: 'pin-guard-jti',
                    pin: '1234'
                }),
                error => error.statusCode === 429 && /locked/.test(error.message)
            );

            const internalFailures = [
                'MongoServerError: connection to mongodb://internal-host failed',
                'Invalid PIN mongodb://secret-host password=SECRET',
                'wallet MongoServerError collection=wallets host=private-db',
                'balance query failed password=SECRET'
            ];
            for (const diagnostic of internalFailures) {
                pinService.verifyPin = async () => { throw new Error(diagnostic); };
                const res = {
                    statusCode: 200,
                    body: null,
                    status(code) { this.statusCode = code; return this; },
                    json(body) { this.body = body; return this; }
                };
                await broadbandController.purchaseBroadband({
                    user,
                    body: { ...baseRequest, pin: '0000' },
                    headers: { 'idempotency-key': 'pin-guard-jti' }
                }, res);
                assert.strictEqual(res.statusCode, 503);
                assert.strictEqual(
                    res.body.message,
                    'We could not verify your transaction PIN right now. Please try again.'
                );
                assert.strictEqual(res.body.error, 'BROADBAND_PIN_VERIFICATION_UNAVAILABLE');
                const output = JSON.stringify(res.body);
                assert.ok(!output.includes(diagnostic));
                assert.ok(!output.includes('MongoServerError'));
                assert.ok(!output.includes('SECRET'));
            }
            assert.strictEqual(adapterCalls, 0);
            assert.strictEqual(claims, 0);
            assert.strictEqual(debits, 0);
            assert.strictEqual(transaction.dispatchState, 'not_dispatched');
        } finally {
            purchaseService.findIdempotentTransaction = originals.findIdempotentTransaction;
            providerService.getAdapterInstance = originals.getAdapterInstance;
            Transaction.updateOne = originals.transactionUpdateOne;
            pinService.verifyPin = originals.verifyPin;
            walletService.debit = originals.walletDebit;
        }
    });

    await test('Unsafe Broadband recovery payloads fail closed before adapter initialization or dispatch', async () => {
        const originals = {
            findIdempotentTransaction: purchaseService.findIdempotentTransaction,
            getAdapterInstance: providerService.getAdapterInstance,
            transactionUpdateOne: Transaction.updateOne,
            verifyPin: pinService.verifyPin,
            encryptionKey: process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY
        };
        const user = { id: new mongoose.Types.ObjectId(), authVersion: 0 };
        const canonicalServiceId = String(new mongoose.Types.ObjectId());
        const context = issueBroadbandVerificationContext({
            user,
            ttlSeconds: 300,
            jti: 'strict-recovery-jti',
            claims: {
                canonicalServiceId, planId: canonicalServiceId,
                serviceIdentityId: String(new mongoose.Types.ObjectId()),
                offerId: String(new mongoose.Types.ObjectId()), providerId: String(new mongoose.Types.ObjectId()),
                providerCode: 'PLAN-1', providerServiceCode: 'BROADBAND', providerAmount: 900,
                identifier: 'SUBSCRIBER-1', contactPhone: '08012345678', purchaseMode: 'plan',
                verificationMode: 'none', verificationEvidenceRequired: false,
                identityUpdatedAt: 1, quotedPrice: 1000, offerUpdatedAt: 1, providerRoutingVersion: 1
            }
        });
        const request = { verificationContext: context, expectedPrice: 1000, pin: '1234' };
        const decoded = verifyBroadbandVerificationContext(context, { user, maxTtlSeconds: 1800 });
        const validPayload = {
            serviceID: 'BROADBAND', variation_code: 'PLAN-1', identifier: 'SUBSCRIBER-1',
            amount: 900, phone: '08012345678'
        };
        process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY = '22'.repeat(32);
        const encryptedForWrongKey = encryptSecret(JSON.stringify(validPayload));
        process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY = originals.encryptionKey;
        const encryptedForTampering = encryptSecret(JSON.stringify(validPayload));
        const cases = [
            JSON.stringify(validPayload),
            'enc:v1:not-valid',
            `${encryptedForTampering.slice(0, -1)}${encryptedForTampering.endsWith('0') ? '1' : '0'}`,
            encryptSecret(JSON.stringify({ ...validPayload, phone: undefined })),
            encryptedForWrongKey
        ];
        let adapterCalls = 0;
        let claims = 0;
        try {
            pinService.verifyPin = async () => true;
            providerService.getAdapterInstance = async () => { adapterCalls++; return {}; };
            Transaction.updateOne = async () => { claims++; return { modifiedCount: 1 }; };
            for (let index = 0; index < cases.length; index++) {
                purchaseService.findIdempotentTransaction = async () => ({
                    _id: new mongoose.Types.ObjectId(),
                    status: 'pending',
                    dispatchState: 'not_dispatched',
                    requestFingerprint: createBroadbandRequestFingerprint(decoded, request),
                    recoveryPayload: cases[index]
                });
                await assert.rejects(
                    broadbandService.replay(user, 'strict-recovery-jti', request, { allowResume: true }),
                    error => error.statusCode === 503 && /recovery data/.test(error.message)
                );
            }
            assert.strictEqual(adapterCalls, 0);
            assert.strictEqual(claims, 0);
        } finally {
            process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY = originals.encryptionKey;
            purchaseService.findIdempotentTransaction = originals.findIdempotentTransaction;
            providerService.getAdapterInstance = originals.getAdapterInstance;
            Transaction.updateOne = originals.transactionUpdateOne;
            pinService.verifyPin = originals.verifyPin;
        }
    });

    await test('Resumed dispatch returns controlled pending state when local resolution throws', async () => {
        const originals = {
            transactionUpdateOne: Transaction.updateOne,
            transactionFindById: Transaction.findById,
            resolveExistingTransaction: purchaseService.resolveExistingTransaction,
            selectBestOffer: procurementService.selectBestOffer
        };
        const transaction = {
            _id: new mongoose.Types.ObjectId(),
            transactionId: 'ZNT-23456789ABCD',
            refId: 'ZNT-R-23456789ABCDEFGH',
            type: 'broadband',
            status: 'pending',
            isLoss: false,
            dispatchState: 'not_dispatched',
            providerOutcome: PROVIDER_OUTCOMES.UNKNOWN,
            providerRequestId: 'ZNT-P-23456789ABCDEFGH'
        };
        let updateCalls = 0;
        let providerCalls = 0;
        let selections = 0;
        try {
            Transaction.updateOne = async () => {
                updateCalls++;
                return { modifiedCount: 1 };
            };
            Transaction.findById = async () => transaction;
            procurementService.selectBestOffer = async () => { selections++; return null; };
            purchaseService.resolveExistingTransaction = async () => {
                throw new Error('database.internal:27017 evidence persistence failed apiKey=fake');
            };
            const result = await purchaseService.resumeUndispatchedPurchase(transaction, async () => {
                providerCalls++;
                return { outcome: PROVIDER_OUTCOMES.SUCCESS, success: true };
            });
            assert.strictEqual(result.status, 'pending');
            assert.strictEqual(result.providerOutcome, PROVIDER_OUTCOMES.UNKNOWN);
            assert.ok(!JSON.stringify(result).includes('database.internal'));
            assert.strictEqual(providerCalls, 1);
            assert.strictEqual(selections, 0);
            assert.strictEqual(updateCalls, 2);

            const replay = await purchaseService.resumeUndispatchedPurchase(transaction, async () => {
                providerCalls++;
            });
            assert.strictEqual(replay.status, 'pending');
            assert.strictEqual(providerCalls, 1);
        } finally {
            Transaction.updateOne = originals.transactionUpdateOne;
            Transaction.findById = originals.transactionFindById;
            purchaseService.resolveExistingTransaction = originals.resolveExistingTransaction;
            procurementService.selectBestOffer = originals.selectBestOffer;
        }
    });

    await test('Broadband controller rejects untrusted upstream messages and error codes', async () => {
        const originalPurchase = broadbandService.purchase;
        const makeResponse = () => ({
            statusCode: 200,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        });
        try {
            for (const diagnostic of [
                'Provider-X apiKey=fake https://internal.provider routing=secret',
                'pin MongoServerError host=private-db',
                'wallet MongoServerError collection=wallets host=private-db',
                'balance query failed password=SECRET'
            ]) {
                broadbandService.purchase = async () => { throw new Error(diagnostic); };
                const res = makeResponse();
                await broadbandController.purchaseBroadband({
                    user: { id: new mongoose.Types.ObjectId() },
                    body: {},
                    headers: { 'idempotency-key': 'test' }
                }, res);
                assert.strictEqual(res.statusCode, 500);
                assert.strictEqual(res.body.message, 'Broadband purchase failed');
                assert.strictEqual(res.body.error, null);
                const output = JSON.stringify(res.body);
                assert.ok(!output.includes(diagnostic));
                assert.ok(!output.includes('private-db'));
                assert.ok(!output.includes('SECRET'));
            }
        } finally {
            broadbandService.purchase = originalPurchase;
        }
    });

    await test('Broadband controller maps only approved PIN and financial error codes', async () => {
        const originals = {
            replay: broadbandService.replay,
            purchase: broadbandService.purchase
        };
        const makeResponse = () => ({
            statusCode: 200,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        });
        const pinPolicies = {
            TRANSACTION_PIN_NOT_SET: ['Transaction PIN not set', 400],
            TRANSACTION_PIN_INVALID: ['Invalid transaction PIN', 400],
            TRANSACTION_PIN_LOCKED: ['Transaction PIN is temporarily locked. Please try again later.', 429],
            PIN_STATE_CONFLICT: ['Transaction PIN verification changed concurrently. Please retry.', 409]
        };
        const financialPolicies = {
            INSUFFICIENT_WALLET_BALANCE: ['Insufficient wallet balance', 'INSUFFICIENT_FUNDS', 400],
            PURCHASE_PRICE_CHANGED: [
                'The price changed before checkout. Please review the updated price and try again.',
                'PRICE_CHANGED',
                409
            ],
            PURCHASE_LIMIT_EXCEEDED: ['Transaction amount exceeds your account limit.', 'PURCHASE_LIMIT_EXCEEDED', 400]
        };
        try {
            for (const [code, [message, statusCode]] of Object.entries(pinPolicies)) {
                broadbandService.replay = async () => {
                    const error = new Error('MongoServerError internal PIN diagnostic password=SECRET');
                    error.code = code;
                    throw error;
                };
                const res = makeResponse();
                await broadbandController.replayBroadbandPurchase({
                    user: { id: new mongoose.Types.ObjectId() },
                    body: {},
                    headers: { 'idempotency-key': 'test' }
                }, res, () => {});
                assert.strictEqual(res.statusCode, statusCode);
                assert.strictEqual(res.body.message, message);
                assert.strictEqual(res.body.error, code);
                assert.ok(!JSON.stringify(res.body).includes('MongoServerError'));
                assert.ok(!JSON.stringify(res.body).includes('SECRET'));
            }

            for (const [code, [message, publicCode, statusCode]] of Object.entries(financialPolicies)) {
                broadbandService.purchase = async () => {
                    const error = new Error('wallet balance MongoServerError password=SECRET');
                    error.code = code;
                    throw error;
                };
                const res = makeResponse();
                await broadbandController.purchaseBroadband({
                    user: { id: new mongoose.Types.ObjectId() },
                    body: {},
                    headers: { 'idempotency-key': 'test' }
                }, res);
                assert.strictEqual(res.statusCode, statusCode);
                assert.strictEqual(res.body.message, message);
                assert.strictEqual(res.body.error, publicCode);
                assert.ok(!JSON.stringify(res.body).includes('MongoServerError'));
                assert.ok(!JSON.stringify(res.body).includes('SECRET'));
            }
        } finally {
            broadbandService.replay = originals.replay;
            broadbandService.purchase = originals.purchase;
        }
    });

    await test('Undispatched idempotent replay claims dispatch without a second wallet debit', async () => {
        const originals = {
            verifyPin: pinService.verifyPin,
            userFindById: User.findById,
            transactionFindOne: Transaction.findOne,
            transactionUpdateOne: Transaction.updateOne,
            walletFindOne: Wallet.findOne,
            walletDebit: walletService.debit,
            selectBestOffer: procurementService.selectBestOffer,
            resolvePricing: pricingService.resolvePricing,
            resolveExistingTransaction: purchaseService.resolveExistingTransaction,
            assertInstalled: transactionIdempotencyIndexService.assertInstalled
        };
        const userId = new mongoose.Types.ObjectId();
        const serviceId = new mongoose.Types.ObjectId();
        const transaction = {
            _id: new mongoose.Types.ObjectId(),
            refId: 'ZNT-R-23456789ABCDEFGH',
            providerRequestId: 'ZNT-P-23456789ABCDEFGH',
            transactionId: 'ZNT-23456789ABCD',
            status: 'pending',
            dispatchState: 'not_dispatched',
            providerOutcome: PROVIDER_OUTCOMES.UNKNOWN,
            requestFingerprint: 'b'.repeat(64)
        };
        let debits = 0;
        let dispatches = 0;
        try {
            pinService.verifyPin = async () => true;
            User.findById = async () => ({ _id: userId, role: 'user', accountType: 'retail', kycLevel: 1 });
            Transaction.findOne = async () => transaction;
            Transaction.updateOne = async () => ({ modifiedCount: 1 });
            Wallet.findOne = async () => { throw new Error('wallet precheck must not run on replay'); };
            walletService.debit = async () => { debits++; };
            transactionIdempotencyIndexService.assertInstalled = async () => true;
            procurementService.selectBestOffer = async () => ({
                _id: new mongoose.Types.ObjectId(),
                serviceId,
                status: true,
                providerCode: 'PLAN',
                providerServiceCode: 'BROADBAND',
                costPrice: 900,
                providerId: {
                    _id: new mongoose.Types.ObjectId(),
                    name: 'Provider',
                    status: 'active',
                    adapterType: 'universal',
                    metadata: {}
                }
            });
            pricingService.resolvePricing = async () => ({ baseCostPrice: 900, salePrice: 1000 });
            purchaseService.resolveExistingTransaction = async () => ({ success: true, status: 'success', data: {} });

            const result = await purchaseService.processPurchase(userId, {
                type: 'broadband',
                serviceId: 'BB',
                canonicalService: { _id: serviceId, status: true, category: 'broadband', code: 'BB' },
                amount: 1000,
                expectedPrice: 1000,
                idempotencyKey: 'bbv:resume',
                requestFingerprint: 'b'.repeat(64),
                pin: '1234',
                providerCall: async () => {
                    dispatches++;
                    return { success: true, outcome: PROVIDER_OUTCOMES.SUCCESS };
                }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(debits, 0);
            assert.strictEqual(dispatches, 1);
        } finally {
            pinService.verifyPin = originals.verifyPin;
            User.findById = originals.userFindById;
            Transaction.findOne = originals.transactionFindOne;
            Transaction.updateOne = originals.transactionUpdateOne;
            Wallet.findOne = originals.walletFindOne;
            walletService.debit = originals.walletDebit;
            procurementService.selectBestOffer = originals.selectBestOffer;
            pricingService.resolvePricing = originals.resolvePricing;
            purchaseService.resolveExistingTransaction = originals.resolveExistingTransaction;
            transactionIdempotencyIndexService.assertInstalled = originals.assertInstalled;
        }
    });

    await test('New idempotent purchase creates the transaction and wallet debit atomically', async () => {
        const originals = {
            verifyPin: pinService.verifyPin,
            userFindById: User.findById,
            transactionFindOne: Transaction.findOne,
            transactionCreate: Transaction.create,
            transactionUpdateOne: Transaction.updateOne,
            walletFindOne: Wallet.findOne,
            walletDebit: walletService.debit,
            selectBestOffer: procurementService.selectBestOffer,
            resolvePricing: pricingService.resolvePricing,
            resolveExistingTransaction: purchaseService.resolveExistingTransaction,
            assertInstalled: transactionIdempotencyIndexService.assertInstalled,
            startSession: mongoose.startSession
        };
        const userId = new mongoose.Types.ObjectId();
        const serviceId = new mongoose.Types.ObjectId();
        const session = {
            started: false,
            committed: false,
            aborted: false,
            ended: false,
            startTransaction() { this.started = true; },
            async commitTransaction() { this.committed = true; },
            async abortTransaction() { this.aborted = true; },
            async endSession() { this.ended = true; }
        };
        let debitSession;
        try {
            pinService.verifyPin = async () => true;
            User.findById = async () => ({ _id: userId, role: 'user', accountType: 'retail', kycLevel: 1 });
            Transaction.findOne = async () => null;
            Transaction.create = async (documents, options) => {
                assert.ok(Array.isArray(documents));
                assert.strictEqual(options.session, session);
                return [{ _id: new mongoose.Types.ObjectId(), ...documents[0] }];
            };
            Transaction.updateOne = async () => ({ modifiedCount: 1 });
            Wallet.findOne = async () => ({ balance: 5000 });
            walletService.debit = async (...args) => { debitSession = args[5]; };
            transactionIdempotencyIndexService.assertInstalled = async () => true;
            mongoose.startSession = async () => session;
            procurementService.selectBestOffer = async () => ({
                _id: new mongoose.Types.ObjectId(),
                serviceId,
                status: true,
                providerCode: 'PLAN',
                providerServiceCode: 'BROADBAND',
                costPrice: 900,
                providerId: {
                    _id: new mongoose.Types.ObjectId(),
                    name: 'Provider',
                    status: 'active',
                    adapterType: 'universal',
                    metadata: {}
                }
            });
            pricingService.resolvePricing = async () => ({ baseCostPrice: 900, salePrice: 1000 });
            purchaseService.resolveExistingTransaction = async () => ({ success: true, status: 'success', data: {} });

            const result = await purchaseService.processPurchase(userId, {
                type: 'broadband',
                serviceId: 'BB',
                canonicalService: { _id: serviceId, status: true, category: 'broadband', code: 'BB' },
                amount: 1000,
                expectedPrice: 1000,
                idempotencyKey: 'bbv:new',
                requestFingerprint: 'c'.repeat(64),
                pin: '1234',
                providerCall: async () => ({ success: true, outcome: PROVIDER_OUTCOMES.SUCCESS })
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(session.started, true);
            assert.strictEqual(session.committed, true);
            assert.strictEqual(session.aborted, false);
            assert.strictEqual(session.ended, true);
            assert.strictEqual(debitSession, session);
        } finally {
            pinService.verifyPin = originals.verifyPin;
            User.findById = originals.userFindById;
            Transaction.findOne = originals.transactionFindOne;
            Transaction.create = originals.transactionCreate;
            Transaction.updateOne = originals.transactionUpdateOne;
            Wallet.findOne = originals.walletFindOne;
            walletService.debit = originals.walletDebit;
            procurementService.selectBestOffer = originals.selectBestOffer;
            pricingService.resolvePricing = originals.resolvePricing;
            purchaseService.resolveExistingTransaction = originals.resolveExistingTransaction;
            transactionIdempotencyIndexService.assertInstalled = originals.assertInstalled;
            mongoose.startSession = originals.startSession;
        }
    });

    await test('Broadband purchase fails closed when the idempotency index is missing', async () => {
        const originalIndexes = Transaction.collection.indexes;
        try {
            transactionIdempotencyIndexService.resetForTests();
            Transaction.collection.indexes = async () => [];
            await assert.rejects(
                purchaseService.findIdempotentPurchase(new mongoose.Types.ObjectId(), 'bbv:test'),
                error => error.code === 'BROADBAND_IDEMPOTENCY_INDEX_MISSING' && error.statusCode === 503
            );
        } finally {
            Transaction.collection.indexes = originalIndexes;
            transactionIdempotencyIndexService.resetForTests();
        }
    });

    await test('Broadband idempotency index readiness cache expires and revalidates', async () => {
        const originalIndexes = Transaction.collection.indexes;
        const originalNow = Date.now;
        let now = 1000000;
        let reads = 0;
        try {
            Date.now = () => now;
            transactionIdempotencyIndexService.resetForTests();
            Transaction.collection.indexes = async () => {
                reads++;
                if (reads > 1) return [];
                return [{
                    name: 'userId_1_idempotencyKey_1_unique_partial',
                    key: { userId: 1, idempotencyKey: 1 },
                    unique: true,
                    partialFilterExpression: { idempotencyKey: { $type: 'string' } }
                }];
            };
            await transactionIdempotencyIndexService.assertInstalled();
            await transactionIdempotencyIndexService.assertInstalled();
            assert.strictEqual(reads, 1);
            now += transactionIdempotencyIndexService.CACHE_TTL_MS + 1;
            await assert.rejects(
                transactionIdempotencyIndexService.assertInstalled(),
                error => error.code === 'BROADBAND_IDEMPOTENCY_INDEX_MISSING'
            );
            assert.strictEqual(reads, 2);
        } finally {
            Date.now = originalNow;
            Transaction.collection.indexes = originalIndexes;
            transactionIdempotencyIndexService.resetForTests();
        }
    });

    await test('Staging validates encryption configuration at startup', () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalKey = process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY;
        try {
            process.env.NODE_ENV = 'staging';
            delete process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY;
            assert.throws(() => validateEncryptionConfiguration(), /required/);
            process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY = 'invalid';
            assert.throws(() => validateEncryptionConfiguration(), /Invalid/);
            process.env.NODE_ENV = 'development';
            delete process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY;
            assert.strictEqual(validateEncryptionConfiguration(), true);
        } finally {
            if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = originalNodeEnv;
            if (originalKey === undefined) delete process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY;
            else process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY = originalKey;
        }
    });

    await test('Transaction declares the partial unique Broadband idempotency index', () => {
        const index = Transaction.schema.indexes().find(([, options]) => options.name === 'userId_1_idempotencyKey_1_unique_partial');
        assert.ok(index);
        assert.deepStrictEqual(index[0], { userId: 1, idempotencyKey: 1 });
        assert.strictEqual(index[1].unique, true);
        assert.deepStrictEqual(index[1].partialFilterExpression, { idempotencyKey: { $type: 'string' } });
    });

    await test('Broadband routes enforce authentication, throttling, compliance, and PIN limiting', () => {
        const handlersFor = path => servicesRouter.stack
            .find(layer => layer.route?.path === path)
            .route.stack.map(layer => layer.handle);
        const verifyHandlers = handlersFor('/broadband/verify');
        const purchaseHandlers = handlersFor('/broadband');
        assert.strictEqual(verifyHandlers[0], verifyJWT);
        assert.strictEqual(verifyHandlers[1], broadbandVerificationLimiter);
        assert.strictEqual(purchaseHandlers[0], verifyJWT);
        assert.strictEqual(purchaseHandlers[2], requireLegalCompliance);
        assert.strictEqual(purchaseHandlers[3], pinLimiter);
    });

    await test('Decrypted context contains no credentials or provider configuration', () => {
        const user = { id: new mongoose.Types.ObjectId(), authVersion: 0 };
        const canonicalServiceId = String(new mongoose.Types.ObjectId());
        const context = issueBroadbandVerificationContext({
            user,
            ttlSeconds: 60,
            claims: {
                canonicalServiceId,
                planId: canonicalServiceId,
                serviceIdentityId: String(new mongoose.Types.ObjectId()),
                offerId: String(new mongoose.Types.ObjectId()),
                providerId: String(new mongoose.Types.ObjectId()),
                providerCode: 'PLAN',
                providerServiceCode: 'BROADBAND',
                providerAmount: 900,
                identifier: 'ID-1',
                contactPhone: '08012345678',
                purchaseMode: 'plan',
                verificationMode: 'none',
                verificationEvidenceRequired: false,
                identityUpdatedAt: 1,
                quotedPrice: 1000,
                offerUpdatedAt: 1,
                providerRoutingVersion: 1
            }
        });
        const decoded = jwt.decode(decryptSecret(context));
        assert.strictEqual(decoded.apiKey, undefined);
        assert.strictEqual(decoded.secretKey, undefined);
        assert.strictEqual(decoded.providerConfig, undefined);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
