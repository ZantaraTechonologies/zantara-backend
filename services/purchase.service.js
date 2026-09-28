const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const walletService = require('./wallet.service');
const refundService = require('./refund.service');
const pinService = require('./pin.service');
const { generateTransactionId, generateReference, generateProviderRequestId } = require('../utils/generateID');
const { createWithIdentifierRetry, isDuplicateKeyFor } = require('../utils/identifierRetry');
const notificationService = require('./notification.service');
const Expense = require('../models/Expense');
const { serializePurchaseResult } = require('../utils/customerResponseSerializer');

const pricingEngine = require('./pricing.service');
const procurementEngine = require('./procurement.service');
const {
    logPriceMismatch,
    logMissingExpectedPrice,
} = require('../utils/pricingLogger');
const { resolvePinQuantity } = require('../utils/pinQuantity');
const { PROVIDER_OUTCOMES, normalizeProviderOutcome } = require('../utils/providerOutcome');
const transactionIdempotencyIndexService = require('./transactionIdempotencyIndex.service');
const { fingerprintsMatch } = require('../utils/broadbandRequestFingerprint');
const {
    normalizeFulfillment,
    encryptFulfillment,
    decryptFulfillment,
    redactProviderEvidence,
    expectedFulfillmentQuantity,
} = require('../utils/fulfillment');

const purchaseError = (message, code, statusCode = 400) => {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
};

const customerPurchaseReference = transaction => {
    return transaction?.providerRequestId
        ? transaction.transactionId
        : transaction?.refId;
};

const customerOutcomeMessage = (transaction, outcome) => {
    const service = transaction?.type === 'broadband' ? 'Broadband purchase' : 'Purchase';
    if (outcome === PROVIDER_OUTCOMES.SUCCESS) return `${service} completed successfully.`;
    if (outcome === PROVIDER_OUTCOMES.DEFINITIVE_FAILURE) return `The ${service.toLowerCase()} could not be completed.`;
    return `Your ${service.toLowerCase()} is being processed. Please check the transaction status before trying again.`;
};

class PurchaseService {
    _assertIdempotencyFingerprint(transaction, requestFingerprint) {
        if (fingerprintsMatch(transaction?.requestFingerprint, requestFingerprint)) return;
        const error = new Error('Idempotency key was already used for a different Broadband purchase');
        error.code = 'IDEMPOTENCY_CONFLICT';
        error.statusCode = 409;
        throw error;
    }

    async _findIdempotentTransaction(userId, idempotencyKey) {
        const query = Transaction.findOne({ userId, idempotencyKey });
        return typeof query?.select === 'function'
            ? query.select('+requestFingerprint +recoveryPayload +providerCredentialSnapshot')
            : query;
    }

    _serializeResultData(transaction, evidence = transaction?.providerEvidence || {}) {
        const fulfillment = decryptFulfillment(transaction?.fulfillment);
        return serializePurchaseResult({
            ...evidence,
            message: customerOutcomeMessage(transaction, PROVIDER_OUTCOMES.SUCCESS),
            ...(fulfillment.complete ? { fulfillment } : {}),
        }, {
            reference: transaction?.refId,
            transactionId: transaction?.transactionId,
        });
    }

    _pendingResult(transaction, outcome, message) {
        return {
            success: false,
            status: 'pending',
            providerOutcome: outcome,
            message: message || customerOutcomeMessage(transaction, outcome),
            transactionId: transaction._id,
            reference: transaction.refId,
            data: {
                status: 'pending',
                providerOutcome: outcome,
                reference: transaction.refId,
                transactionId: transaction.transactionId,
            },
        };
    }

    _existingTransactionResult(transaction) {
        if (transaction.status === 'success') {
            return {
                success: true,
                status: 'success',
                providerOutcome: transaction.providerOutcome,
                transactionId: transaction._id,
                reference: transaction.refId,
                data: this._serializeResultData(transaction)
            };
        }
        if (transaction.status === 'failed' || transaction.status === 'reversed' || transaction.isLoss) {
            return {
                success: false,
                status: 'failed',
                providerOutcome: transaction.providerOutcome,
                refunded: Boolean(transaction.isLoss),
                message: customerOutcomeMessage(transaction, PROVIDER_OUTCOMES.DEFINITIVE_FAILURE),
                transactionId: transaction._id,
                reference: transaction.refId,
                data: null
            };
        }
        return this._pendingResult(
            transaction,
            transaction.providerOutcome || PROVIDER_OUTCOMES.UNKNOWN,
            'Transaction is awaiting provider confirmation.'
        );
    }

    async findIdempotentPurchase(userId, idempotencyKey) {
        const existing = await this.findIdempotentTransaction(userId, idempotencyKey);
        return existing ? this._existingTransactionResult(existing) : null;
    }

    async findIdempotentTransaction(userId, idempotencyKey) {
        if (!idempotencyKey) return null;
        await transactionIdempotencyIndexService.assertInstalled();
        return this._findIdempotentTransaction(userId, idempotencyKey);
    }

    resultFromExistingTransaction(transaction) {
        return this._existingTransactionResult(transaction);
    }

    async _postDispatchFailureResult(transaction, error, {
        preserveDispatchState = false,
        knownResponse = null
    } = {}) {
        const observedOutcome = knownResponse
            ? normalizeProviderOutcome(knownResponse).outcome
            : PROVIDER_OUTCOMES.UNKNOWN;
        const outcomeStrength = {
            [PROVIDER_OUTCOMES.UNKNOWN]: 0,
            [PROVIDER_OUTCOMES.PENDING]: 1,
            [PROVIDER_OUTCOMES.DEFINITIVE_FAILURE]: 2,
            [PROVIDER_OUTCOMES.SUCCESS]: 3,
        };
        const currentOutcome = transaction.providerOutcome || PROVIDER_OUTCOMES.UNKNOWN;
        const strongestOutcome = outcomeStrength[observedOutcome] > outcomeStrength[currentOutcome]
            ? observedOutcome
            : currentOutcome;
        const replaceableOutcomes = {
            [PROVIDER_OUTCOMES.UNKNOWN]: [null, PROVIDER_OUTCOMES.UNKNOWN],
            [PROVIDER_OUTCOMES.PENDING]: [null, PROVIDER_OUTCOMES.UNKNOWN, PROVIDER_OUTCOMES.PENDING],
            [PROVIDER_OUTCOMES.DEFINITIVE_FAILURE]: [
                null,
                PROVIDER_OUTCOMES.UNKNOWN,
                PROVIDER_OUTCOMES.PENDING,
                PROVIDER_OUTCOMES.DEFINITIVE_FAILURE,
            ],
            [PROVIDER_OUTCOMES.SUCCESS]: [
                null,
                PROVIDER_OUTCOMES.UNKNOWN,
                PROVIDER_OUTCOMES.PENDING,
                PROVIDER_OUTCOMES.DEFINITIVE_FAILURE,
                PROVIDER_OUTCOMES.SUCCESS,
            ],
        };
        console.error('[Purchase Resolution] Post-dispatch processing failed', {
            transactionId: String(transaction._id || ''),
            errorCode: error.code || error.name || 'ERROR'
        });
        await Transaction.updateOne(
            {
                _id: transaction._id,
                status: 'pending',
                isLoss: false,
                providerOutcome: { $in: replaceableOutcomes[strongestOutcome] },
            },
            {
                $set: {
                    providerOutcome: strongestOutcome,
                    ...(!preserveDispatchState ? { dispatchState: 'dispatching' } : {}),
                    resolutionState: 'unresolved',
                    resolutionError: error.message,
                },
            }
        ).catch(() => {});

        let latest = null;
        try {
            latest = await Transaction.findById(transaction._id);
        } catch (_) {}
        if (latest && (latest.status === 'success'
            || latest.status === 'failed'
            || latest.status === 'reversed'
            || latest.isLoss)) {
            return this._existingTransactionResult(latest);
        }
        const unresolved = latest || transaction;
        if (!unresolved.providerOutcome || unresolved.providerOutcome === PROVIDER_OUTCOMES.UNKNOWN) {
            unresolved.providerOutcome = strongestOutcome;
        }
        return this._pendingResult(
            unresolved,
            unresolved.providerOutcome || PROVIDER_OUTCOMES.UNKNOWN,
            customerOutcomeMessage(unresolved, PROVIDER_OUTCOMES.UNKNOWN)
        );
    }

    async resumeUndispatchedPurchase(transaction, providerCall) {
        if (!transaction || transaction.status !== 'pending' || transaction.dispatchState !== 'not_dispatched') {
            return this._existingTransactionResult(transaction);
        }
        const claim = await Transaction.updateOne(
            { _id: transaction._id, status: 'pending', isLoss: false, dispatchState: 'not_dispatched' },
            { $set: { dispatchState: 'dispatching' } }
        );
        if (claim.modifiedCount !== 1) {
            const latest = await Transaction.findById(transaction._id);
            return this._existingTransactionResult(latest || transaction);
        }
        transaction.dispatchState = 'dispatching';

        let response;
        try {
            response = await providerCall(transaction.providerRequestId);
        } catch (error) {
            response = {
                success: false,
                status: 'unknown',
                outcome: PROVIDER_OUTCOMES.UNKNOWN,
                message: error.message || 'Provider request outcome is unknown',
                raw: {}
            };
        }
        try {
            return await this.resolveExistingTransaction(transaction._id, response);
        } catch (error) {
            return this._postDispatchFailureResult(transaction, error);
        }
    }

    _retryCredentialNotification(transaction) {
        const fulfillment = decryptFulfillment(transaction?.fulfillment);
        if (!fulfillment.complete || fulfillment.items.length === 0) return;

        User.findById(transaction.userId).then(user => {
            if (!user) return;
            notificationService.notifyPurchaseSuccess(user, {
                type: transaction.type,
                serviceId: transaction.service,
                amount: transaction.amount,
                reference: customerPurchaseReference(transaction),
                details: transaction.details,
                fulfillment,
                greetingName: user.name,
            }).catch(error => {
                console.error('[Notification Background Error] Credential notification retry failed:', error?.message);
            });
        }).catch(error => {
            console.error('[Notification Background Error] Credential notification customer lookup failed:', error?.message);
        });
    }

    async _recordProviderEvidence(transaction, response, isRequery = false) {
        const normalized = normalizeProviderOutcome(response);
        const receivedFulfillment = normalizeFulfillment(normalized);
        const existingFulfillment = decryptFulfillment(transaction.fulfillment);
        const expectedQuantity = expectedFulfillmentQuantity(transaction);
        const receivedIsComplete = expectedQuantity === 0 || receivedFulfillment.items.length === expectedQuantity;
        const fulfillment = existingFulfillment.complete && !receivedIsComplete
            ? existingFulfillment
            : receivedFulfillment.items.length > 0
                ? receivedFulfillment
                : existingFulfillment;
        const uniqueItemCount = new Set(
            fulfillment.items.map(item => `${item.code}\u0000${item.serial || ''}`)
        ).size;
        const fulfillmentComplete = expectedQuantity === 0
            || (fulfillment.items.length === expectedQuantity && uniqueItemCount === expectedQuantity);
        const encryptedFulfillment = (expectedQuantity > 0 || fulfillment.items.length > 0)
            ? encryptFulfillment(fulfillment, { expectedQuantity, complete: fulfillmentComplete })
            : undefined;
        const { token, fulfillment: ignoredFulfillment, ...evidenceWithoutFulfillment } = normalized;
        const safeEvidence = redactProviderEvidence(evidenceWithoutFulfillment, {
            items: [...existingFulfillment.items, ...receivedFulfillment.items],
        });
        const now = new Date();
        const update = {
            providerOutcome: normalized.outcome,
            dispatchState: 'dispatched',
            providerEvidence: safeEvidence,
            response: safeEvidence.raw,
            lastProviderResponseAt: now,
            resolutionError: normalized.outcome === PROVIDER_OUTCOMES.SUCCESS && !fulfillmentComplete
                ? 'FULFILLMENT_QUANTITY_MISMATCH'
                : null,
        };
        if (encryptedFulfillment) update.fulfillment = encryptedFulfillment;
        if (normalized.transactionId) update.providerRef = normalized.transactionId;
        if (isRequery) update.lastRequeryAt = now;

        const replaceableOutcomes = {
            [PROVIDER_OUTCOMES.SUCCESS]: [
                null,
                PROVIDER_OUTCOMES.UNKNOWN,
                PROVIDER_OUTCOMES.PENDING,
                PROVIDER_OUTCOMES.DEFINITIVE_FAILURE,
                PROVIDER_OUTCOMES.SUCCESS,
            ],
            [PROVIDER_OUTCOMES.DEFINITIVE_FAILURE]: [
                null,
                PROVIDER_OUTCOMES.UNKNOWN,
                PROVIDER_OUTCOMES.PENDING,
                PROVIDER_OUTCOMES.DEFINITIVE_FAILURE,
            ],
            [PROVIDER_OUTCOMES.PENDING]: [null, PROVIDER_OUTCOMES.UNKNOWN, PROVIDER_OUTCOMES.PENDING],
            [PROVIDER_OUTCOMES.UNKNOWN]: [null, PROVIDER_OUTCOMES.UNKNOWN],
        };

        const recorded = await Transaction.updateOne(
            {
                _id: transaction._id,
                status: 'pending',
                isLoss: false,
                providerOutcome: { $in: replaceableOutcomes[normalized.outcome] },
                ...(normalized.outcome === PROVIDER_OUTCOMES.SUCCESS && expectedQuantity > 0 && !fulfillmentComplete
                    ? { 'fulfillment.complete': { $ne: true } }
                    : {}),
            },
            { $set: update }
        );
        if (recorded.modifiedCount > 0) {
            Object.assign(transaction, update);
            return normalized;
        }

        const latest = await Transaction.findById(transaction._id);
        if (!latest) throw new Error('Transaction not found after provider response');
        Object.assign(transaction, latest.toObject ? latest.toObject() : latest);
        return normalizeProviderOutcome(latest.providerEvidence);
    }

    async _finalizeSuccessfulPurchase(transactionId, { requireFulfillment = false } = {}) {
        const session = await mongoose.startSession();
        session.startTransaction();
        let referralNotificationIntent = null;
        let transaction;
        let user;

        try {
            transaction = await Transaction.findOneAndUpdate(
                {
                    _id: transactionId,
                    status: 'pending',
                    isLoss: false,
                    providerOutcome: PROVIDER_OUTCOMES.SUCCESS,
                    resolutionState: { $ne: 'finalizing' },
                    ...(requireFulfillment ? { 'fulfillment.complete': true } : {}),
                },
                { $set: { resolutionState: 'finalizing', resolutionError: null } },
                { new: true, session }
            );

            if (!transaction) {
                await session.abortTransaction();
                const existing = await Transaction.findById(transactionId);
                if (existing?.status === 'success') {
                    return {
                        success: true,
                        status: 'success',
                        providerOutcome: PROVIDER_OUTCOMES.SUCCESS,
                        transactionId: existing._id,
                        reference: existing.refId,
                        data: this._serializeResultData(existing),
                    };
                }
                return this._pendingResult(existing || { _id: transactionId }, existing?.providerOutcome || PROVIDER_OUTCOMES.SUCCESS);
            }

            user = await User.findById(transaction.userId).session(session);
            if (!user) throw new Error('User not found during purchase finalization');

            const response = normalizeProviderOutcome(transaction.providerEvidence);
            let finalProviderCost = transaction.costPrice;
            if (response.financials?.source === 'actual') {
                const { vendorCost, vendorCommission, providerUnitPrice, convenienceFee } = response.financials;
                transaction.actualCostPrice = vendorCost;
                transaction.vendorCommission = vendorCommission;
                transaction.providerUnitPrice = providerUnitPrice;
                transaction.convenienceFee = convenienceFee;
                transaction.accountingSource = 'actual';
                finalProviderCost = vendorCost;
                transaction.costPrice = vendorCost;
                transaction.actualProfit = transaction.amount - vendorCost;
                transaction.profit = transaction.actualProfit;
            }

            transaction.status = 'success';
            transaction.response = response.raw;
            transaction.providerRef = response.transactionId || transaction.providerRef;
            await transaction.save({ session });

            const { processLifetimeCommission } = require('../utils/referral');
            const referralResult = await processLifetimeCommission(
                transaction.userId,
                transaction.amount,
                transaction._id,
                transaction.transactionId,
                session
            );
            const finalCommission = referralResult && typeof referralResult === 'object'
                ? Number(referralResult.commission) || 0
                : Number(referralResult) || 0;
            referralNotificationIntent = referralResult && typeof referralResult === 'object'
                ? referralResult.notificationIntent
                : null;

            transaction.netProfitAfterCommission = transaction.profit - finalCommission;
            transaction.resolutionState = 'resolved';
            transaction.resolvedAt = new Date();
            transaction.resolutionError = null;
            await transaction.save({ session });

            await Expense.create([{
                category: 'API_COST',
                title: `${transaction.provider} Cost: ${transaction.service}`,
                amount: finalProviderCost,
                vendor: transaction.provider,
                date: new Date(),
                paymentSource: 'Business Float',
                notes: `Transaction ID: ${transaction.transactionId} | Source: ${transaction.accountingSource}`,
                createdBy: transaction.userId,
            }], { session });

            await session.commitTransaction();

            if (referralNotificationIntent) {
                notificationService.notifyReferralEarned(referralNotificationIntent).catch(error => {
                    console.error('[Referral Notification Background Error]', error?.message);
                });
            }
            notificationService.notifyPurchaseSuccess(user, {
                type: transaction.type,
                serviceId: transaction.service,
                amount: transaction.amount,
                reference: customerPurchaseReference(transaction),
                details: transaction.details,
                fulfillment: decryptFulfillment(transaction.fulfillment),
                greetingName: user.name,
            }).catch(error => {
                console.error('[Notification Background Error] Success notification failed:', error?.message);
            });

            return {
                success: true,
                status: 'success',
                providerOutcome: PROVIDER_OUTCOMES.SUCCESS,
                data: this._serializeResultData(transaction, response),
                transactionId: transaction._id,
                reference: transaction.refId,
            };
        } catch (error) {
            await session.abortTransaction();
            await Transaction.updateOne(
                { _id: transactionId, status: 'pending', isLoss: false },
                { $set: { resolutionState: 'unresolved', resolutionError: error.message } }
            ).catch(() => {});
            throw error;
        } finally {
            session.endSession();
        }
    }

    async resolveExistingTransaction(transactionId, response, { isRequery = false } = {}) {
        const transaction = await Transaction.findById(transactionId);
        if (!transaction) throw new Error('Transaction not found');

        if (transaction.status === 'success') {
            this._retryCredentialNotification(transaction);
            return {
                success: true,
                status: 'success',
                providerOutcome: PROVIDER_OUTCOMES.SUCCESS,
                transactionId: transaction._id,
                reference: transaction.refId,
                data: this._serializeResultData(transaction),
            };
        }
        if (transaction.status === 'failed' || transaction.isLoss) {
            return {
                success: false,
                status: 'failed',
                providerOutcome: transaction.providerOutcome,
                refunded: Boolean(transaction.isLoss),
                transactionId: transaction._id,
                reference: transaction.refId,
            };
        }

        const normalized = await this._recordProviderEvidence(transaction, response, isRequery);

        if (transaction.status === 'success') {
            this._retryCredentialNotification(transaction);
            return {
                success: true,
                status: 'success',
                providerOutcome: PROVIDER_OUTCOMES.SUCCESS,
                transactionId: transaction._id,
                reference: transaction.refId,
                data: this._serializeResultData(transaction),
            };
        }
        if (transaction.status === 'failed' || transaction.isLoss) {
            return {
                success: false,
                status: 'failed',
                providerOutcome: transaction.providerOutcome,
                refunded: Boolean(transaction.isLoss),
                transactionId: transaction._id,
                reference: transaction.refId,
            };
        }

        if (normalized.outcome === PROVIDER_OUTCOMES.SUCCESS) {
            const expectedQuantity = expectedFulfillmentQuantity(transaction);
            if (expectedQuantity > 0 && !transaction.fulfillment?.complete) {
                return this._pendingResult(
                    transaction,
                    PROVIDER_OUTCOMES.SUCCESS,
                    'Provider confirmed fulfillment; credential delivery is pending reconciliation.'
                );
            }
            try {
                return await this._finalizeSuccessfulPurchase(transaction._id, {
                    requireFulfillment: expectedQuantity > 0,
                });
            } catch (error) {
                return this._pendingResult(
                    transaction,
                    PROVIDER_OUTCOMES.SUCCESS,
                    'Provider confirmed fulfillment; local finalization is pending reconciliation.'
                );
            }
        }

        if (normalized.outcome === PROVIDER_OUTCOMES.DEFINITIVE_FAILURE) {
            const refund = await refundService.processRefund(
                transaction._id,
                normalized.message || 'Provider definitively rejected the transaction',
                { mode: 'provider_failure' }
            );
            const customer = await User.findById(transaction.userId);
            if (!refund.alreadyRefunded && customer) {
                notificationService.notifyPurchaseFailure(customer, {
                    type: transaction.type,
                    serviceId: transaction.service,
                    amount: transaction.amount,
                    reference: customerPurchaseReference(transaction),
                    reason: {
                        customerMessage: customerOutcomeMessage(transaction, PROVIDER_OUTCOMES.DEFINITIVE_FAILURE)
                    },
                    refunded: true,
                    greetingName: customer.name,
                }).catch(error => {
                    console.error('[Notification Background Error] Failure notification failed:', error?.message);
                });
            }
            return {
                success: false,
                status: 'failed',
                providerOutcome: PROVIDER_OUTCOMES.DEFINITIVE_FAILURE,
                refunded: true,
                message: customerOutcomeMessage(transaction, PROVIDER_OUTCOMES.DEFINITIVE_FAILURE),
                transactionId: transaction._id,
                reference: transaction.refId,
                data: null,
            };
        }

        return this._pendingResult(transaction, normalized.outcome);
    }

    /** Generic execution flow for all utility purchases. */
    async processPurchase(userId, {
        type,
        serviceId,
        canonicalService,
        amount,
        details,
        providerCall,
        providerPreflight,
        pin,
        expectedPrice,
        idempotencyKey,
        requiredProviderOfferId,
        requiredOperations = [],
        providerSelectionValidator,
        recoveryPayload,
        requestFingerprint
    }) {
        let transaction;
        let user;
        let reference;
        let providerRequestId;
        let walletDebited = false;
        let dispatchMayHaveOccurred = false;
        let resumedUndispatched = false;

        try {
            await pinService.verifyPin(userId, pin);
            user = await User.findById(userId);
            if (!user) throw new Error('User not found');

            if (!canonicalService?._id || canonicalService.status === false) {
                throw new Error('A valid canonical service is required for purchase');
            }

            if (idempotencyKey) {
                if (typeof idempotencyKey !== 'string' || idempotencyKey.length > 100) {
                    throw new Error('Invalid purchase idempotency key');
                }
                if (!/^[a-f0-9]{64}$/.test(requestFingerprint || '')) {
                    throw new Error('A valid request fingerprint is required for idempotent purchase');
                }
                await transactionIdempotencyIndexService.assertInstalled();
                const existing = await this._findIdempotentTransaction(userId, idempotencyKey);
                if (existing) {
                    this._assertIdempotencyFingerprint(existing, requestFingerprint);
                    if (existing.status === 'pending' && existing.dispatchState === 'not_dispatched') {
                        transaction = existing;
                        reference = existing.refId;
                        providerRequestId = existing.providerRequestId;
                        walletDebited = true;
                        resumedUndispatched = true;
                    } else {
                        return this._existingTransactionResult(existing);
                    }
                }
            }

            const quantity = resolvePinQuantity(details?.quantity);
            const service = canonicalService;
            const offer = await procurementEngine.selectBestOffer(service._id, {
                providerOfferId: requiredProviderOfferId,
                requiredOperations
            });
            if (!offer) throw purchaseError(
                'No active provider offer is configured for this service',
                'PROVIDER_OFFER_UNAVAILABLE',
                503
            );
            if (offer.status === false || offer.providerId?.status === 'inactive') {
                throw purchaseError('Selected provider offer is not active', 'PROVIDER_OFFER_UNAVAILABLE', 503);
            }
            if (!offer.providerId?.name || !String(offer.providerCode || '').trim()) {
                throw purchaseError('Selected provider offer is invalid', 'PROVIDER_OFFER_UNAVAILABLE', 503);
            }
            const offerServiceId = offer.serviceId?._id || offer.serviceId;
            if (!offerServiceId || String(offerServiceId) !== String(service._id)) {
                throw new Error('Selected provider offer does not belong to the canonical service');
            }
            if (typeof providerSelectionValidator === 'function') {
                await providerSelectionValidator(offer, service);
            }

            const currentProvider = offer.providerId.name;
            const providerServiceCode = procurementEngine.resolveProviderServiceCode(service, offer);
            const pricingResult = await pricingEngine.resolvePricing(user, service, offer, amount, quantity);

            const selection = {
                provider: currentProvider,
                providerId: offer.providerId._id,
                providerAdapterType: offer.providerId.adapterType,
                providerConfigSnapshot: {
                    baseUrl: offer.providerId.baseUrl,
                    publicKey: offer.providerId.publicKey,
                    metadata: offer.providerId.metadata instanceof Map
                        ? Object.fromEntries(offer.providerId.metadata)
                        : (offer.providerId.metadata || {}),
                },
                providerCredentialSnapshot: {
                    apiKey: offer.providerId.apiKey,
                    secretKey: offer.providerId.secretKey,
                },
                providerCode: offer.providerCode,
                providerServiceCode,
                providerOfferId: offer._id,
            };
            if (typeof providerPreflight === 'function') {
                selection.adapter = await providerPreflight(selection);
                if (!selection.adapter) {
                    throw purchaseError('Selected provider could not be initialized', 'PROVIDER_OFFER_UNAVAILABLE', 503);
                }
            }

            const costPrice = pricingResult.baseCostPrice;
            const finalAmount = pricingResult.salePrice;
            const pricingSnapshot = {
                serviceId: service._id,
                providerId: offer.providerId._id,
                providerOfferId: offer._id,
                ...pricingResult,
            };

            if (expectedPrice !== undefined && expectedPrice !== null) {
                if (Number(expectedPrice) !== Number(finalAmount)) {
                    logPriceMismatch({
                        userId,
                        userRole: user.accountType || user.role,
                        serviceId,
                        type,
                        expectedPrice,
                        computedPrice: finalAmount,
                        source: 'purchase.service/processPurchase',
                        clientType: details?.clientType || 'unknown',
                    });
                    throw purchaseError(
                        `The price changed before checkout. Expected: ₦${expectedPrice}, but actual price is ₦${finalAmount}. Please review the updated price and try again.`,
                        'PURCHASE_PRICE_CHANGED',
                        409
                    );
                }
            } else {
                logMissingExpectedPrice({
                    userId,
                    userRole: user.accountType || user.role,
                    serviceId,
                    type,
                    amount,
                    source: 'purchase.service/processPurchase',
                    clientType: details?.clientType || 'legacy',
                });
            }

            const profit = finalAmount - costPrice;
            if (profit < 0) throw new Error(`Transaction aborted: Unsafe pricing (Potential Loss). Cost: ${costPrice}, Sale: ${finalAmount}.`);

            if (!resumedUndispatched) {
                const wallet = await Wallet.findOne({ userId });
                if (!wallet) throw new Error('Wallet not found');
                if (wallet.balance < finalAmount) {
                    throw purchaseError('Insufficient wallet balance', 'INSUFFICIENT_WALLET_BALANCE');
                }
            }
            const kycLimits = { 1: 50000, 2: 500000, 3: 100000000 };
            if (finalAmount > kycLimits[user.kycLevel || 1]) {
                throw purchaseError(
                    `Transaction amount exceeds your Tier ${user.kycLevel || 1} limit.`,
                    'PURCHASE_LIMIT_EXCEEDED'
                );
            }

            const transactionData = identifiers => ({
                userId,
                ...identifiers,
                ...(idempotencyKey ? { idempotencyKey } : {}),
                ...(requestFingerprint ? { requestFingerprint } : {}),
                type,
                service: service.code,
                amount: finalAmount,
                costPrice,
                estimatedCostPrice: costPrice,
                salePrice: amount,
                agentPrice: finalAmount,
                profit,
                estimatedProfit: profit,
                userRole: user.role && user.role !== 'user' ? user.role : (user.accountType || user.role),
                provider: currentProvider,
                providerId: offer.providerId._id,
                providerAdapterType: selection.providerAdapterType,
                providerConfigSnapshot: selection.providerConfigSnapshot,
                providerCredentialSnapshot: selection.providerCredentialSnapshot,
                ...(recoveryPayload ? { recoveryPayload } : {}),
                providerOfferId: offer._id,
                providerOutcome: PROVIDER_OUTCOMES.UNKNOWN,
                dispatchState: 'not_dispatched',
                resolutionState: 'unresolved',
                status: 'pending',
                details: {
                    ...details,
                    ...(['pin', 'electricity'].includes(type) ? { productName: service.name } : {}),
                    originalAmount: amount,
                    request_id: identifiers.providerRequestId,
                    quantity,
                },
                pricingSnapshot,
            });

            if (!transaction) try {
                transaction = await createWithIdentifierRetry({
                    label: 'Purchase',
                    fields: ['transactionId', 'refId', 'providerRequestId'],
                    generate: () => ({
                        transactionId: generateTransactionId(),
                        refId: generateReference(),
                        providerRequestId: generateProviderRequestId(selection.providerAdapterType),
                    }),
                    create: async identifiers => {
                        if (!idempotencyKey) return Transaction.create(transactionData(identifiers));

                        const session = await mongoose.startSession();
                        session.startTransaction();
                        try {
                            const [created] = await Transaction.create([transactionData(identifiers)], { session });
                            await walletService.debit(
                                userId,
                                finalAmount,
                                created.refId,
                                `${type}_purchase`,
                                created._id,
                                session
                            );
                            await session.commitTransaction();
                            walletDebited = true;
                            return created;
                        } catch (error) {
                            await session.abortTransaction();
                            throw error;
                        } finally {
                            await session.endSession();
                        }
                    },
                });
            } catch (error) {
                if (!idempotencyKey || !isDuplicateKeyFor(error, 'idempotencyKey')) throw error;
                const existing = await this._findIdempotentTransaction(userId, idempotencyKey);
                if (!existing) throw error;
                this._assertIdempotencyFingerprint(existing, requestFingerprint);
                if (existing.status !== 'pending' || existing.dispatchState !== 'not_dispatched') {
                    return this._existingTransactionResult(existing);
                }
                transaction = existing;
                walletDebited = true;
                resumedUndispatched = true;
            }
            reference = transaction.refId;
            providerRequestId = transaction.providerRequestId;

            if (!idempotencyKey) {
                await walletService.debit(userId, finalAmount, reference, `${type}_purchase`, transaction._id);
                walletDebited = true;
            }

            const dispatchClaim = await Transaction.updateOne(
                {
                    _id: transaction._id,
                    status: 'pending',
                    isLoss: false,
                    ...(idempotencyKey ? { dispatchState: 'not_dispatched' } : {})
                },
                { $set: { dispatchState: 'dispatching' } }
            );
            if (idempotencyKey && dispatchClaim.modifiedCount !== 1) {
                const latest = await Transaction.findById(transaction._id);
                return this._existingTransactionResult(latest || transaction);
            }
            transaction.dispatchState = 'dispatching';
            dispatchMayHaveOccurred = true;

            let response;
            try {
                response = await providerCall(providerRequestId, costPrice, selection);
            } catch (error) {
                response = {
                    success: false,
                    status: 'unknown',
                    outcome: PROVIDER_OUTCOMES.UNKNOWN,
                    message: error.message || 'Provider request outcome is unknown',
                    raw: {},
                };
            }

            return await this.resolveExistingTransaction(transaction._id, response);
        } catch (error) {
            if (!transaction) throw error;

            if (dispatchMayHaveOccurred) {
                return this._postDispatchFailureResult(transaction, error);
            }

            if (walletDebited) {
                const refund = await refundService.processRefund(
                    transaction._id,
                    error.message,
                    { mode: 'pre_dispatch' }
                );
                return {
                    success: false,
                    status: 'failed',
                    providerOutcome: PROVIDER_OUTCOMES.UNKNOWN,
                    refunded: !refund.skipped,
                    message: 'Transaction was cancelled before provider dispatch.',
                    transactionId: transaction._id,
                    reference,
                };
            }

            await Transaction.updateOne(
                { _id: transaction._id, status: 'pending' },
                { $set: { status: 'failed', resolutionError: error.message, resolvedAt: new Date() } }
            ).catch(() => {});
            throw error;
        }
    }
}

module.exports = new PurchaseService();
