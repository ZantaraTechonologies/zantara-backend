const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const walletService = require('./wallet.service');
const refundService = require('./refund.service');
const pinService = require('./pin.service');
const { generateTransactionId, generateReference, generateProviderRequestId } = require('../utils/generateID');
const { createWithIdentifierRetry } = require('../utils/identifierRetry');
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
const {
    normalizeFulfillment,
    encryptFulfillment,
    decryptFulfillment,
    redactProviderEvidence,
    expectedFulfillmentQuantity,
} = require('../utils/fulfillment');

const customerPurchaseReference = transaction => {
    return transaction?.providerRequestId
        ? transaction.transactionId
        : transaction?.refId;
};

class PurchaseService {
    _serializeResultData(transaction, evidence = transaction?.providerEvidence || {}) {
        const fulfillment = decryptFulfillment(transaction?.fulfillment);
        return serializePurchaseResult({
            ...evidence,
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
            message: message || 'Transaction is awaiting provider confirmation.',
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
                    reason: normalized,
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
                message: normalized.message || 'Provider could not complete the transaction.',
                transactionId: transaction._id,
                reference: transaction.refId,
                data: null,
            };
        }

        return this._pendingResult(transaction, normalized.outcome, normalized.message);
    }

    /** Generic execution flow for all utility purchases. */
    async processPurchase(userId, { type, serviceId, canonicalService, amount, details, providerCall, providerPreflight, pin, expectedPrice }) {
        let transaction;
        let user;
        let reference;
        let providerRequestId;
        let walletDebited = false;
        let dispatchMayHaveOccurred = false;

        try {
            await pinService.verifyPin(userId, pin);
            user = await User.findById(userId);
            if (!user) throw new Error('User not found');

            if (!canonicalService?._id || canonicalService.status === false) {
                throw new Error('A valid canonical service is required for purchase');
            }

            const quantity = resolvePinQuantity(details?.quantity);
            const service = canonicalService;
            const offer = await procurementEngine.selectBestOffer(service._id);
            if (!offer) throw new Error('No active provider offer is configured for this service');
            if (offer.status === false || offer.providerId?.status === 'inactive') {
                throw new Error('Selected provider offer is not active');
            }
            if (!offer.providerId?.name || !String(offer.providerCode || '').trim()) {
                throw new Error('Selected provider offer is invalid');
            }
            const offerServiceId = offer.serviceId?._id || offer.serviceId;
            if (!offerServiceId || String(offerServiceId) !== String(service._id)) {
                throw new Error('Selected provider offer does not belong to the canonical service');
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
                if (!selection.adapter) throw new Error('Selected provider could not be initialized');
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
                    throw new Error(`The price changed before checkout. Expected: ₦${expectedPrice}, but actual price is ₦${finalAmount}. Please review the updated price and try again.`);
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

            const wallet = await Wallet.findOne({ userId });
            if (!wallet) throw new Error('Wallet not found');
            if (wallet.balance < finalAmount) throw new Error('Insufficient wallet balance');
            const kycLimits = { 1: 50000, 2: 500000, 3: 100000000 };
            if (finalAmount > kycLimits[user.kycLevel || 1]) {
                throw new Error(`Transaction amount exceeds your Tier ${user.kycLevel || 1} limit.`);
            }

            transaction = await createWithIdentifierRetry({
                label: 'Purchase',
                fields: ['transactionId', 'refId', 'providerRequestId'],
                generate: () => ({
                    transactionId: generateTransactionId(),
                    refId: generateReference(),
                    providerRequestId: generateProviderRequestId(selection.providerAdapterType),
                }),
                create: identifiers => Transaction.create({
                    userId,
                    ...identifiers,
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
                }),
            });
            reference = transaction.refId;
            providerRequestId = transaction.providerRequestId;

            await walletService.debit(userId, finalAmount, reference, `${type}_purchase`, transaction._id);
            walletDebited = true;

            await Transaction.updateOne(
                { _id: transaction._id, status: 'pending', isLoss: false },
                { $set: { dispatchState: 'dispatching' } }
            );
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
                await Transaction.updateOne(
                    {
                        _id: transaction._id,
                        status: 'pending',
                        isLoss: false,
                        providerOutcome: { $in: [null, PROVIDER_OUTCOMES.UNKNOWN] },
                    },
                    {
                        $set: {
                            providerOutcome: PROVIDER_OUTCOMES.UNKNOWN,
                            dispatchState: 'dispatching',
                            resolutionState: 'unresolved',
                            resolutionError: error.message,
                        },
                    }
                ).catch(() => {});
                let latest = null;
                try {
                    latest = await Transaction.findById(transaction._id);
                } catch (_) {}
                if (latest?.status === 'success') {
                    return {
                        success: true,
                        status: 'success',
                        providerOutcome: PROVIDER_OUTCOMES.SUCCESS,
                        transactionId: latest._id,
                        reference: latest.refId,
                        data: this._serializeResultData(latest),
                    };
                }
                if (latest?.status === 'failed' || latest?.isLoss) {
                    return {
                        success: false,
                        status: 'failed',
                        providerOutcome: latest.providerOutcome,
                        refunded: Boolean(latest.isLoss),
                        transactionId: latest._id,
                        reference: latest.refId,
                    };
                }
                const unresolved = latest || transaction;
                return this._pendingResult(
                    unresolved,
                    unresolved.providerOutcome || PROVIDER_OUTCOMES.UNKNOWN,
                    'Provider resolution is pending reconciliation.'
                );
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
