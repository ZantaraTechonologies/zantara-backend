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
            console.log(`[Service: purchaseService] -> START processPurchase for ${type}. userId: ${userId}, amount: ${amount}`);
            
            // 0. Verify Transaction PIN first
            console.log(`[Service: purchaseService] -> Verifying PIN...`);
            await pinService.verifyPin(userId, pin);
            console.log(`[Service: purchaseService] -> PIN Verified`);

            const user = await User.findById(userId);
            if (!user) {
                console.log(`[Service: purchaseService] -> User not found!`);
                throw new Error('User not found');
            }
            
            const standardPrice = amount; // What normal users pay
            const finalAmount = await calculateServicePrice(user, standardPrice);
            console.log(`[Service: purchaseService] -> Calculated final amount: ${finalAmount} (standard is ${standardPrice})`);

            const wallet = await Wallet.findOne({ userId });
            if (!wallet) {
                console.log(`[Service: purchaseService] -> Wallet not found!`);
                throw new Error('Wallet not found for user');
            }
            console.log(`[Service: purchaseService] -> Wallet balance: ${wallet.balance}`);
            
            if (wallet.balance < finalAmount) {
                console.log(`[Service: purchaseService] -> Insufficient balance! (needs ${finalAmount})`);
                throw new Error('Insufficient wallet balance');
            }

            // 0.5 Check KYC Limits (Example: Tier 1=2k, Tier 2=50k, Tier 3=Unlimited)
            const kycLimits = { 1: 10000, 2: 100000, 3: 10000000 };
            const userLimit = kycLimits[user.kycLevel || 1];
            console.log(`[Service: purchaseService] -> Checking KYC limit: Tier ${user.kycLevel}, Limit: ${userLimit}`);
            if (finalAmount > userLimit) {
                console.log(`[Service: purchaseService] -> KYC limit exceeded!`);
                throw new Error(`Transaction amount exceeds your Tier ${user.kycLevel || 1} limit of ${userLimit}. Please upgrade your KYC.`);
            }

            // 1. Create PENDING Transaction Record
            const transactionId = generateTransactionId();
            const reference = details.request_id || generateVTPassRequestId();
            console.log(`[Service: purchaseService] -> Generated Transaction ID: ${transactionId}, Ref: ${reference}`);
            
            // Calculate business metrics
            const costPrice = await getProviderCost(serviceId, amount);
            const profit = finalAmount - costPrice;
            console.log(`[Service: purchaseService] -> Cost Price: ${costPrice}, Profit: ${profit}`);

            // --- HARDENING: Profit Safety Check (Step 3) ---
            if (profit <= 0) {
                console.log(`[Service: purchaseService] -> Unsafe pricing triggered! Profit is negative or 0.`);
                throw new Error(`Transaction aborted: Unsafe pricing (Potential Loss of ${costPrice - finalAmount} NGN). Please contact support to adjust agent discount settings.`);
            }

            console.log(`[Service: purchaseService] -> Creating Pending Transaction...`);
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
            console.log(`[Service: purchaseService] -> Pending Transaction created: ${transaction._id}`);

            // 2. Debit Wallet FIRST (with Ledger entry)
            console.log(`[Service: purchaseService] -> Debiting wallet by ${finalAmount}...`);
            await walletService.debit(userId, finalAmount, reference, `${type}_purchase`, transaction._id);
            console.log(`[Service: purchaseService] -> Wallet debited.`);

            // 3. Call External Provider
            console.log(`[Service: purchaseService] -> Calling VTPass Provider Call...`);
            const response = await providerCall(reference);
            console.log(`[Service: purchaseService] -> Provider returned:`, JSON.stringify(response));

            if (!response.success) {
                console.log(`[Service: purchaseService] -> Provider call failed. Initiating refund...`);
                // 4. Automated Refund if provider fails
                await refundService.processRefund(transaction._id, response.message || 'Provider failed');
                console.log(`[Service: purchaseService] -> Refund completed.`);
                return { success: false, message: response.message, error: response };
            }

            // 5. Finalize transaction on success
            console.log(`[Service: purchaseService] -> Provider success. Saving transaction logic...`);
            transaction.status = 'success';
            transaction.response = response.raw;
            await transaction.save();
            console.log(`[Service: purchaseService] -> Transaction saved as success.`);

            // 6. Referral Bonus (Lifetime Commission)
            try {
                console.log(`[Service: purchaseService] -> Processing referral commission...`);
                const { processLifetimeCommission } = require('../utils/referral');
                await processLifetimeCommission(userId, finalAmount, transaction._id, transaction.transactionId);
                console.log(`[Service: purchaseService] -> Commission processed.`);
            } catch (refErr) {
                console.error('[Service: purchaseService] -> Referral commission error (non-fatal):', refErr.message);
            }

            // Notify user of success (outside of session for performance)
            console.log(`[Service: purchaseService] -> Sending success inApp notification...`);
            await notificationService.sendInApp(userId, {
                title: `${type.toUpperCase()} Purchase Successful`,
                message: `Your purchase of ${serviceId} for ${finalAmount} was successful.`,
                type: 'transaction',
                metadata: { transactionId: transaction._id }
            });

            console.log(`[Service: purchaseService] -> RETURNING TRUE.`);
            return { success: true, data: response, transactionId: transaction._id };

        } catch (err) {
            console.error(`[Service: purchaseService] -> MAIN CATCH BLOCK HIT:`, err);
            console.error(`[Service: purchaseService] -> STACK:`, err?.stack);
            
            if (transaction && transaction.status === 'pending') {
                try {
                    console.log(`[Service: purchaseService] -> Attempting refund for crashed transaction...`);
                    await refundService.processRefund(transaction._id, err.message);
                    console.log(`[Service: purchaseService] -> Refund successful.`);
                    
                    // Notify user of failure
                    await notificationService.sendInApp(userId, {
                        title: `${type.toUpperCase()} Purchase Failed`,
                        message: `Your purchase of ${serviceId} failed: ${err.message}. Your wallet has been refunded.`,
                        type: 'transaction',
                        metadata: { transactionId: transaction._id }
                    });
                } catch (refundErr) {
                    console.error('[Service: purchaseService] -> CRITICAL: Refund failed after error:', refundErr);
                }
            }
            throw err;
        }
    }
}

module.exports = new PurchaseService();
