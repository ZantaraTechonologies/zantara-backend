const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const walletService = require('./wallet.service');
const refundService = require('./refund.service');
const providerService = require('./provider.service');
const pinService = require('./pin.service');
const { generateTransactionId, generateReference, generateVTPassRequestId } = require('../utils/generateID');
const { processReferralBonus } = require('../utils/referral');
const { calculateServicePrice, getProviderCost } = require('../utils/pricing');
const notificationService = require('./notification.service');
const Expense = require('../models/Expense');

const Service = require('../models/Service');
const pricingEngine = require('./pricing.service');
const procurementEngine = require('./procurement.service');
const {
    logPriceMismatch,
    logPreviewFailure,
    logMissingExpectedPrice,
    logLegacyPricingFallback,
} = require('../utils/pricingLogger');

class PurchaseService {
    /**
     * Generic execution flow for all utility purchases
     */
    async processPurchase(userId, { type, serviceId, amount, details, providerCall, referralAmount, pin, provider = 'VTPass', expectedPrice }) {
        let transaction;
        try {
            // 0. Verify Transaction PIN first
            await pinService.verifyPin(userId, pin);

            const user = await User.findById(userId);
            if (!user) throw new Error('User not found');

            let costPrice, finalAmount, pricingSnapshot = null;
            let currentProvider = provider;

            // --- BATCH 2: NEW ENGINES INTEGRATION ---
            // Try to find the normalized service by its code (e.g., MTN_DATA_1GB)
            let service = await Service.findOne({ code: serviceId });
            
            // Fallback: If not found by code, check if serviceId is a ServiceIdentity slug (e.g. mtnairtime)
            if (!service) {
                const ServiceIdentity = require('../models/ServiceIdentity');
                const identity = await ServiceIdentity.findOne({ slug: String(serviceId).toLowerCase() });
                if (identity) {
                    service = await Service.findOne({ identityId: identity._id });
                }
            }

            let offer = null;
            let pricingResult = null;

            if (service) {
                // 1. Select the best provider offer (manual_priority strategy)
                offer = await procurementEngine.selectBestOffer(service._id);
                if (offer) {
                    currentProvider = offer.providerId.name;
                    // 2. Resolve pricing based on rules
                    pricingResult = await pricingEngine.resolvePricing(user, service, offer, amount);
                }
            }

            if (pricingResult) {
                // Use results from the new engines
                costPrice = pricingResult.baseCostPrice;
                finalAmount = pricingResult.salePrice;
                pricingSnapshot = {
                    serviceId: service._id,
                    providerId: offer.providerId._id,
                    providerOfferId: offer._id,
                    ...pricingResult
                };
            } else {
                // --- FALLBACK TO LEGACY PRICING ---
                logLegacyPricingFallback({
                    userId,
                    serviceId,
                    type,
                    amount,
                    source: 'purchase.service/processPurchase',
                });
                costPrice = await getProviderCost(serviceId, amount);
                finalAmount = await calculateServicePrice(user, amount, costPrice);
            }

            // --- BATCH 3.1: PURCHASE CHECKSUM (MISMATCH PREVENTION) ---
            if (expectedPrice !== undefined && expectedPrice !== null) {
                if (Number(expectedPrice) !== Number(finalAmount)) {
                    // Log structured mismatch event before throwing
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
                // No expectedPrice = legacy or un-migrated client path
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

            // --- PROFIT SAFETY CHECK ---
            const profit = finalAmount - costPrice;
            if (profit < 0) {
                throw new Error(`Transaction aborted: Unsafe pricing (Potential Loss). Cost: ${costPrice}, Sale: ${finalAmount}.`);
            }

            const wallet = await Wallet.findOne({ userId });
            if (!wallet) throw new Error('Wallet not found');
            if (wallet.balance < finalAmount) throw new Error('Insufficient wallet balance');

            // KYC Checks
            const kycLimits = { 1: 50000, 2: 500000, 3: 100000000 };
            const userLimit = kycLimits[user.kycLevel || 1];
            if (finalAmount > userLimit) {
                throw new Error(`Transaction amount exceeds your Tier ${user.kycLevel || 1} limit.`);
            }

            // 1. Create Transaction Record
            const transactionId = generateTransactionId();
            const reference = details.request_id || generateReference();

            transaction = await Transaction.create({
                userId,
                transactionId,
                refId: reference,
                type,
                service: serviceId,
                amount: finalAmount,
                costPrice, // Authoritative (estimated for now)
                estimatedCostPrice: costPrice,
                salePrice: amount, // Requested face value
                agentPrice: finalAmount, 
                profit, // Authoritative (estimated for now)
                estimatedProfit: profit,
                userRole: user.role && user.role !== 'user' ? user.role : (user.accountType || user.role),
                provider: currentProvider,
                status: 'pending',
                details: { ...details, originalAmount: amount, request_id: reference },
                pricingSnapshot: pricingSnapshot // Persist the engine snapshot
            });

            // 2. Debit Wallet
            await walletService.debit(userId, finalAmount, reference, `${type}_purchase`, transaction._id);

            // 3. Call External Provider
            const response = await providerCall(reference, costPrice);

            if (!response.success) {

                // 4. Automated Refund if provider fails
                await refundService.processRefund(transaction._id, response.message || 'Provider failed');

                return { success: false, message: response.message, error: response };
            }

            // 5. Finalize transaction on success with atomicity

            const session = await mongoose.startSession();
            session.startTransaction();
            try {
                transaction.status = 'success';
                transaction.response = response.raw;

                // --- Hybrid Accounting Update ---
                let finalProviderCost = costPrice; // Fallback to estimated
                if (response.financials && response.financials.source === 'actual') {
                    const { vendorCost, vendorCommission, providerUnitPrice, convenienceFee } = response.financials;
                    
                    transaction.actualCostPrice = vendorCost;
                    transaction.vendorCommission = vendorCommission;
                    transaction.providerUnitPrice = providerUnitPrice;
                    transaction.convenienceFee = convenienceFee;
                    transaction.accountingSource = 'actual';
                    
                    // Update authoritative profit and cost fields
                    finalProviderCost = vendorCost;
                    transaction.costPrice = vendorCost;
                    transaction.actualProfit = transaction.amount - vendorCost;
                    transaction.profit = transaction.actualProfit;
                }
                
                // 6. Referral Bonus (Lifetime Commission)
                // Note: processLifetimeCommission also writes netProfitAfterCommission on the parent txn
                const { processLifetimeCommission } = require('../utils/referral');
                const commissionPaid = await processLifetimeCommission(userId, finalAmount, transaction._id, transaction.transactionId, session);
                
                const finalCommission = commissionPaid || 0;
                transaction.netProfitAfterCommission = transaction.profit - finalCommission;
                console.log(`[PurchaseService] Hybrid Accounting: ${transaction.accountingSource}. Cost: ${transaction.costPrice}, Profit: ${transaction.profit}. Commission: ${finalCommission}`);
                
                await transaction.save({ session });

                // 8. Log the vendor cost as an Expense for financial tracking
                await Expense.create([{
                    category: 'API_COST',
                    title: `${provider} Cost: ${serviceId}`,
                    amount: finalProviderCost,
                    vendor: provider,
                    date: new Date(),
                    paymentSource: 'Business Float',
                    notes: `Transaction ID: ${transaction.transactionId} | Source: ${transaction.accountingSource}`,
                    createdBy: userId 
                }], { session });

                await session.commitTransaction();

            } catch (error) {
                await session.abortTransaction();

                throw error;
            } finally {
                session.endSession();
            }

            // Notify user of success (outside of session for performance)

            await notificationService.sendInApp(userId, {
                title: `${type.toUpperCase()} Purchase Successful`,
                message: `Your purchase of ${serviceId} for ${finalAmount} was successful.`,
                type: 'transaction',
                metadata: { transactionId: transaction._id }
            });

            return { success: true, data: response, transactionId: transaction._id };

        } catch (err) {

            if (transaction && transaction.status === 'pending') {
                try {

                    await refundService.processRefund(transaction._id, err.message);

                    // Notify user of failure
                    await notificationService.sendInApp(userId, {
                        title: `${type.toUpperCase()} Purchase Failed`,
                        message: `Your purchase of ${serviceId} failed: ${err.message}. Your wallet has been refunded.`,
                        type: 'transaction',
                        metadata: { transactionId: transaction._id }
                    });
                } catch (refundErr) {

                }
            }
            throw err;
        }
    }
}

module.exports = new PurchaseService();
