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

class PurchaseService {
    /**
     * Generic execution flow for all utility purchases
     */
    async processPurchase(userId, { type, serviceId, amount, details, providerCall, referralAmount, pin }) {
        let transaction;
        try {
            // 0. Verify Transaction PIN first
            await pinService.verifyPin(userId, pin);

            const user = await User.findById(userId);
            const standardPrice = amount; // What normal users pay
            const finalAmount = await calculateServicePrice(user, standardPrice);

            const wallet = await Wallet.findOne({ userId });
            if (!wallet || wallet.balance < finalAmount) {
                throw new Error('Insufficient wallet balance');
            }

            // 0.5 Check KYC Limits (Example: Tier 1=2k, Tier 2=50k, Tier 3=Unlimited)
            const kycLimits = { 1: 10000, 2: 100000, 3: 10000000 };
            const userLimit = kycLimits[user.kycLevel || 1];
            if (finalAmount > userLimit) {
                throw new Error(`Transaction amount exceeds your Tier ${user.kycLevel || 1} limit of ${userLimit}. Please upgrade your KYC.`);
            }

            // 1. Create PENDING Transaction Record
            const transactionId = generateTransactionId();
            // VTPass REQUIRES YYYYMMDDHHII format for request_id
            const reference = details.request_id || generateVTPassRequestId();
            
            // Calculate business metrics
            const costPrice = await getProviderCost(serviceId, amount);
            const profit = finalAmount - costPrice;

            // --- HARDENING: Profit Safety Check (Step 3) ---
            if (profit <= 0) {
                throw new Error(`Transaction aborted: Unsafe pricing (Potential Loss of ${costPrice - finalAmount} NGN). Please contact support to adjust agent discount settings.`);
            }

            transaction = await Transaction.create({
                userId,
                transactionId,
                refId: reference,
                type,
                service: serviceId,
                amount: finalAmount,
                costPrice,
                salePrice: standardPrice,
                agentPrice: finalAmount, // What the agent/reseller paid
                profit,
                userRole: user.role,
                provider: 'VTPass', // Default primary provider for now
                status: 'pending',
                details: { ...details, originalAmount: amount, request_id: reference }
            });

            // 2. Debit Wallet FIRST (with Ledger entry)
            await walletService.debit(userId, finalAmount, reference, `${type}_purchase`, transaction._id);

            // 3. Call External Provider
            const response = await providerCall(reference);

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
                await transaction.save({ session });

                // 6. Referral Bonus (Lifetime Commission)
                const { processLifetimeCommission } = require('../utils/referral');
                await processLifetimeCommission(userId, finalAmount, transaction._id, transaction.transactionId, session);

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
            console.error(`${type} purchase service error:`, err.message);
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
                    console.error('CRITICAL: Refund failed after error:', refundErr.message);
                }
            }
            throw err;
        }
    }
}

module.exports = new PurchaseService();
