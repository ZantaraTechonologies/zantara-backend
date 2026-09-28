const crypto = require('crypto');
const mongoose = require('mongoose');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
const User = require('../models/User');
const procurementService = require('./procurement.service');
const providerService = require('./provider.service');
const pricingService = require('./pricing.service');
const purchaseService = require('./purchase.service');
const pinService = require('./pin.service');
const broadbandReadiness = require('./broadbandReadiness.service');
const { PROVIDER_OPERATIONS, supportsProviderOperation } = require('../adapters/providerAdapterRegistry');
const { PROVIDER_OUTCOMES } = require('../utils/providerOutcome');
const { normalizeIdentifier, normalizeAmount, maskIdentifier } = require('../utils/broadbandInputPolicy');
const {
    issueBroadbandVerificationContext,
    verifyBroadbandVerificationContext
} = require('../utils/broadbandVerificationContext');
const {
    createBroadbandRequestFingerprint,
    fingerprintsMatch
} = require('../utils/broadbandRequestFingerprint');
const { serializeBroadbandVerification } = require('../utils/customerVerificationSerializer');
const { encryptSecret } = require('../utils/crypto');
const { decodeBroadbandRecoveryPayload } = require('../utils/broadbandRecoveryPayload');
const {
    PIN_ERROR_CODES,
    PURCHASE_ERROR_CODES,
    createControlledBroadbandError,
    createPolicyError,
    resolveCustomerError
} = require('../utils/broadbandCustomerError');

const serviceError = (message, statusCode = 400, code) => {
    return createControlledBroadbandError(message, statusCode, code);
};

const timestamp = value => value ? new Date(value).getTime() : 0;

const idempotencyConflict = () => serviceError(
    'Idempotency key was already used for a different Broadband purchase',
    409,
    'IDEMPOTENCY_CONFLICT'
);

class BroadbandService {
    async replay(user, idempotencyKey, request = {}, { allowResume = false } = {}) {
        if (!idempotencyKey || typeof idempotencyKey !== 'string') return null;
        const transaction = await purchaseService.findIdempotentTransaction(
            user._id || user.id,
            `bbv:${idempotencyKey}`
        );
        if (!transaction) return null;

        let requestFingerprint;
        try {
            const context = verifyBroadbandVerificationContext(request.verificationContext, {
                user,
                maxTtlSeconds: 1800,
                ignoreExpiration: true
            });
            requestFingerprint = createBroadbandRequestFingerprint(context, request);
        } catch (_) {
            throw idempotencyConflict();
        }
        if (!fingerprintsMatch(transaction.requestFingerprint, requestFingerprint)) {
            throw idempotencyConflict();
        }
        if (transaction.status !== 'pending' || transaction.dispatchState !== 'not_dispatched') {
            return purchaseService.resultFromExistingTransaction(transaction);
        }
        if (!allowResume) return null;

        if (typeof request.pin !== 'string' || !request.pin.trim()) {
            throw serviceError('PIN is required', 400, 'TRANSACTION_PIN_REQUIRED');
        }
        try {
            await pinService.verifyPin(user._id || user.id, request.pin);
        } catch (error) {
            const safe = resolveCustomerError(error, { allowedCodes: PIN_ERROR_CODES });
            if (safe) throw createControlledBroadbandError(safe.message, safe.statusCode, error.code);
            console.error('[Broadband PIN] Verification failed', {
                transactionId: String(transaction._id || ''),
                errorCode: error.code || error.name || 'ERROR'
            });
            throw createPolicyError('BROADBAND_PIN_VERIFICATION_UNAVAILABLE');
        }

        const recovery = decodeBroadbandRecoveryPayload(transaction.recoveryPayload);
        if (!recovery.ok && recovery.reason === 'encryption') {
            console.warn('[Broadband Recovery] Encrypted recovery payload validation failed', {
                transactionId: String(transaction._id || '')
            });
            throw serviceError('Broadband purchase recovery data is unavailable', 503);
        }
        if (!recovery.ok) {
            console.warn('[Broadband Recovery] Recovery payload schema validation failed', {
                transactionId: String(transaction._id || '')
            });
            throw serviceError('Broadband purchase recovery data is invalid', 503);
        }
        const payload = recovery.payload;

        const adapter = await providerService.getAdapterInstance(transaction.provider, {
            providerId: transaction.providerId,
            adapterType: transaction.providerAdapterType,
            configSnapshot: transaction.providerConfigSnapshot,
            credentialSnapshot: transaction.providerCredentialSnapshot,
            allowInactive: true
        });
        return purchaseService.resumeUndispatchedPurchase(
            transaction,
            requestId => adapter.purchaseBroadband({ ...payload, request_id: requestId })
        );
    }

    async _loadServiceAndIdentity({ planId, serviceIdentityId, canonicalServiceId }) {
        if (!mongoose.Types.ObjectId.isValid(serviceIdentityId)) {
            throw serviceError('Valid Broadband service identity ID required');
        }
        const identity = await ServiceIdentity.findOne({ _id: serviceIdentityId, status: true });
        if (!identity || !identity.purchaseMode || !identity.identifierPolicy || !identity.verificationPolicy) {
            throw serviceError('Broadband service is not fully configured', 409);
        }

        let service;
        if (identity.purchaseMode === 'plan') {
            if (!mongoose.Types.ObjectId.isValid(planId)) throw serviceError('Valid Broadband plan ID required');
            service = await Service.findOne({
                _id: planId,
                identityId: serviceIdentityId,
                category: 'broadband',
                status: true
            });
        } else if (canonicalServiceId) {
            if (!mongoose.Types.ObjectId.isValid(canonicalServiceId)) {
                throw serviceError('Broadband verification context is invalid');
            }
            service = await Service.findOne({
                _id: canonicalServiceId,
                identityId: serviceIdentityId,
                category: 'broadband',
                status: true
            });
        } else {
            const services = await Service.find({
                identityId: serviceIdentityId,
                category: 'broadband',
                status: true
            });
            if (services.length !== 1) {
                throw serviceError('Broadband AMOUNT identity must have exactly one active purchase service', 409);
            }
            [service] = services;
        }
        if (!service) throw serviceError('Broadband service not found', 404);
        const readiness = await broadbandReadiness.inspectService(identity, service, { requireOffer: false });
        if (!readiness.ready) throw serviceError('Broadband service is not fully configured', 409);
        return { service, identity };
    }

    _validateOffer(offer, service, identity) {
        if (!offer?.providerId?.name || !offer.providerId._id) {
            throw serviceError('No compatible Broadband provider is available', 503);
        }
        if (!String(offer.providerCode || '').trim() || !String(offer.providerServiceCode || '').trim()) {
            throw serviceError('Broadband provider mapping is incomplete', 503);
        }
        if ((offer.currency || 'NGN') !== 'NGN') {
            throw serviceError('Only NGN Broadband provider offers are supported', 503);
        }
        const offerServiceId = offer.serviceId?._id || offer.serviceId;
        if (String(offerServiceId) !== String(service._id)) {
            throw serviceError('Broadband provider mapping is invalid', 503);
        }
        if (identity.purchaseMode === 'amount' && offer.costMode !== 'dynamic') {
            throw serviceError('Broadband amount purchases require dynamic provider pricing', 503);
        }
        if (identity.purchaseMode === 'plan' && offer.costMode !== 'fixed') {
            throw serviceError('Broadband plan purchases require fixed provider pricing', 503);
        }
    }

    async verify(user, { serviceIdentityId, planId, identifier, amount }) {
        const { service, identity } = await this._loadServiceAndIdentity({ planId, serviceIdentityId });
        if (identity.purchaseMode === 'plan' && amount !== undefined) {
            throw serviceError('Amount is not accepted for Broadband PLAN verification');
        }
        if (identity.purchaseMode === 'amount' && planId !== undefined) {
            throw serviceError('Plan ID is not accepted for Broadband AMOUNT verification');
        }
        const customer = await User.findById(user._id || user.id);
        if (!customer || customer.status === false) throw serviceError('User not found or inactive', 403);
        const normalizedIdentifier = normalizeIdentifier(identifier, identity.identifierPolicy);
        const normalizedAmount = normalizeAmount(amount, identity.purchaseMode, identity.amountPolicy);
        const requiredOperations = [PROVIDER_OPERATIONS.PURCHASE_BROADBAND];
        const verificationMode = identity.verificationPolicy.mode;
        const evidenceRequired = Boolean(identity.verificationPolicy.evidenceRequired);
        if (verificationMode === 'required') {
            requiredOperations.push(evidenceRequired
                ? PROVIDER_OPERATIONS.VERIFY_BROADBAND_EVIDENCE
                : PROVIDER_OPERATIONS.VERIFY_BROADBAND);
        }

        const offer = await procurementService.selectBestOffer(service._id, {
            requiredOperations,
            offerValidator: candidate => broadbandReadiness.offerErrors({
                identity,
                service,
                offer: candidate
            }).length === 0
        });
        this._validateOffer(offer, service, identity);
        const providerServiceCode = procurementService.resolveProviderServiceCode(service, offer);
        let verificationResult = null;

        const shouldVerify = verificationMode === 'required'
            || (verificationMode === 'optional'
                && supportsProviderOperation(offer.providerId, PROVIDER_OPERATIONS.VERIFY_BROADBAND));
        if (shouldVerify) {
            const adapter = await providerService.getAdapterInstance(offer.providerId.name, {
                providerId: offer.providerId._id,
                adapterType: offer.providerId.adapterType
            });
            verificationResult = await adapter.verifyBroadband({
                serviceID: providerServiceCode,
                variation_code: offer.providerCode,
                identifier: normalizedIdentifier,
                ...(normalizedAmount !== undefined ? { amount: normalizedAmount } : {})
            });
            if (!verificationResult?.success || verificationResult.outcome !== PROVIDER_OUTCOMES.SUCCESS) {
                throw serviceError('Customer verification could not be completed', 422);
            }
            if (evidenceRequired
                && (typeof verificationResult.verificationReference !== 'string'
                    || !verificationResult.verificationReference.trim())) {
                throw serviceError('Provider verification evidence is required but was not returned', 422);
            }
        }

        const pricing = await pricingService.resolvePricing(customer, service, offer, normalizedAmount);
        const ttlSeconds = identity.verificationPolicy.ttlSeconds || 300;
        const jti = crypto.randomUUID();
        const verificationContext = issueBroadbandVerificationContext({
            user: customer,
            ttlSeconds,
            jti,
            claims: {
                canonicalServiceId: String(service._id),
                ...(identity.purchaseMode === 'plan' ? { planId: String(service._id) } : {}),
                serviceIdentityId: String(identity._id),
                offerId: String(offer._id),
                providerId: String(offer.providerId._id),
                providerCode: String(offer.providerCode),
                providerServiceCode: String(offer.providerServiceCode),
                providerAmount: normalizedAmount ?? offer.costPrice,
                identifier: normalizedIdentifier,
                contactPhone: String(customer.phone),
                purchaseMode: identity.purchaseMode,
                identityUpdatedAt: timestamp(identity.updatedAt),
                verificationMode,
                verificationEvidenceRequired: evidenceRequired,
                quotedPrice: pricing.salePrice,
                ...(normalizedAmount !== undefined ? { amount: normalizedAmount } : {}),
                ...(verificationResult?.verificationReference
                    ? { verificationReference: String(verificationResult.verificationReference) }
                    : {}),
                offerUpdatedAt: timestamp(offer.updatedAt),
                providerRoutingVersion: Number(offer.providerId.routingVersion || 1)
            }
        });

        return serializeBroadbandVerification({
            customerName: verificationResult?.customer?.name,
            verified: Boolean(verificationResult),
            identifierMasked: maskIdentifier(normalizedIdentifier),
            verificationContext,
            idempotencyKey: jti,
            serviceIdentityId: String(identity._id),
            ...(identity.purchaseMode === 'plan' ? { planId: String(service._id) } : {}),
            expiresAt: new Date(Date.now() + (ttlSeconds * 1000)).toISOString(),
            price: pricing
        });
    }

    async purchase(user, { verificationContext, idempotencyKey, pin, expectedPrice, amount }) {
        if (!idempotencyKey || typeof idempotencyKey !== 'string') {
            throw serviceError('Idempotency-Key header is required');
        }

        const transactionIdempotencyKey = `bbv:${idempotencyKey}`;
        const existingResult = await this.replay(user, idempotencyKey, {
            verificationContext,
            expectedPrice,
            amount,
            pin
        }, { allowResume: true });
        if (existingResult) return existingResult;
        if (!pin) throw serviceError('PIN is required', 400, 'TRANSACTION_PIN_REQUIRED');
        if (expectedPrice === undefined || expectedPrice === null || !Number.isFinite(Number(expectedPrice))) {
            throw serviceError('Expected price is required');
        }

        const context = verifyBroadbandVerificationContext(verificationContext, {
            user,
            maxTtlSeconds: 1800
        });
        if (context.jti !== idempotencyKey) throw serviceError('Idempotency key does not match verification context');

        const { service, identity } = await this._loadServiceAndIdentity({
            planId: context.planId,
            serviceIdentityId: context.serviceIdentityId,
            canonicalServiceId: context.canonicalServiceId
        });
        if (String(identity._id) !== context.serviceIdentityId || context.purchaseMode !== identity.purchaseMode
            || timestamp(identity.updatedAt) !== context.identityUpdatedAt
            || identity.verificationPolicy.mode !== context.verificationMode
            || Boolean(identity.verificationPolicy.evidenceRequired) !== context.verificationEvidenceRequired) {
            throw serviceError('Broadband verification context is no longer valid');
        }
        if ((context.exp - context.iat) > (identity.verificationPolicy.ttlSeconds || 300)) {
            throw serviceError('Broadband verification context is no longer valid');
        }

        const identifier = normalizeIdentifier(context.identifier, identity.identifierPolicy);
        if (identity.purchaseMode === 'plan' && amount !== undefined) {
            throw serviceError('Amount is not accepted for Broadband PLAN purchase');
        }
        const normalizedAmount = normalizeAmount(amount, identity.purchaseMode, identity.amountPolicy);
        if ((context.amount ?? null) !== (normalizedAmount ?? null)) {
            throw serviceError('Purchase amount does not match the verified Broadband amount');
        }
        if (Number(expectedPrice) !== Number(context.quotedPrice)) {
            throw serviceError('Expected price does not match the verified quote');
        }
        const requestFingerprint = createBroadbandRequestFingerprint(context, {
            expectedPrice,
            amount: normalizedAmount
        });
        const purchaseAmount = normalizedAmount ?? service.price;
        const providerPayload = {
            serviceID: context.providerServiceCode,
            variation_code: context.providerCode,
            identifier,
            amount: context.providerAmount,
            phone: context.contactPhone,
            verification_reference: context.verificationReference
        };
        try {
            return await purchaseService.processPurchase(user._id || user.id, {
                type: 'broadband',
                serviceId: service.code,
                canonicalService: service,
                amount: purchaseAmount,
                pin,
                expectedPrice,
                idempotencyKey: transactionIdempotencyKey,
                requestFingerprint,
                requiredProviderOfferId: context.offerId,
                requiredOperations: [PROVIDER_OPERATIONS.PURCHASE_BROADBAND],
                recoveryPayload: encryptSecret(JSON.stringify(providerPayload)),
                providerSelectionValidator: offer => {
                    this._validateOffer(offer, service, identity);
                    if (String(offer.providerId._id) !== context.providerId
                        || timestamp(offer.updatedAt) !== context.offerUpdatedAt
                        || Number(offer.providerId.routingVersion || 1) !== context.providerRoutingVersion) {
                        throw serviceError('Broadband provider configuration changed; verify the customer again', 409);
                    }
                },
                details: {
                    productName: service.name,
                    identifierMasked: maskIdentifier(identifier),
                    purchaseMode: identity.purchaseMode,
                    roles: user.roles
                },
                providerPreflight: selection => providerService.getAdapterInstance(selection.provider, {
                    providerId: selection.providerId,
                    adapterType: selection.providerAdapterType,
                    configSnapshot: selection.providerConfigSnapshot,
                    credentialSnapshot: selection.providerCredentialSnapshot
                }),
                providerCall: (requestId, resolvedCost, selection) => selection.adapter.purchaseBroadband({
                    request_id: requestId,
                    serviceID: selection.providerServiceCode,
                    variation_code: selection.providerCode,
                    identifier,
                    amount: normalizedAmount ?? resolvedCost,
                    phone: context.contactPhone,
                    verification_reference: context.verificationReference
                })
            });
        } catch (error) {
            const safe = resolveCustomerError(error, { allowedCodes: PURCHASE_ERROR_CODES });
            if (safe) throw createControlledBroadbandError(safe.message, safe.statusCode, error.code);
            console.error('[Broadband Purchase] Internal failure', {
                errorCode: error.code || error.name || 'ERROR'
            });
            throw createPolicyError('BROADBAND_PURCHASE_UNAVAILABLE');
        }
    }
}

module.exports = new BroadbandService();
