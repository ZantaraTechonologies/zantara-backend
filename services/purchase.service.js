const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const walletService = require('./wallet.service');
const refundService = require('./refund.service');
const providerService = require('./provider.service');
const pinService = require('./pin.service');
const { generateTransactionId, generateReference } = require('../utils/generateID');
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

            const wallet = await Wallet.findOne({ userId });
            const finalAmount = await calculateServicePrice(details.roles || [], amount);

            if (!wallet || wallet.balance < finalAmount) {
                throw new Error('Insufficient wallet balance');
            }

            // 0.5 Check KYC Limits (Example: Tier 1=2k, Tier 2=50k, Tier 3=Unlimited)
            const user = await User.findById(userId);
            const kycLimits = { 1: 2000, 2: 50000, 3: 10000000 };
            const userLimit = kycLimits[user.kycLevel || 1];
            if (finalAmount > userLimit) {
                throw new Error(`Transaction amount exceeds your Tier ${user.kycLevel || 1} limit of ${userLimit}. Please upgrade your KYC.`);
            }

            // 1. Create PENDING Transaction Record
            const transactionId = generateTransactionId();
            const reference = details.request_id || generateReference();
            
            // Calculate business metrics
            const costPrice = await getProviderCost(serviceId, amount);
            const profit = finalAmount - costPrice;

            transaction = await Transaction.create({
                userId,
                transactionId,
                refId: reference,
                type,
                service: serviceId,
                amount: finalAmount,
                costPrice,
                salePrice: finalAmount,
                profit,
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

            // 5. Finalize transaction on success
            transaction.status = 'success';
            transaction.response = response.raw;
            await transaction.save();

            // Notify user of success
            await notificationService.sendInApp(userId, {
                title: `${type.toUpperCase()} Purchase Successful`,
                message: `Your purchase of ${serviceId} for ${finalAmount} was successful.`,
                type: 'transaction',
                metadata: { transactionId: transaction._id }
            });

            // 6. Referral Bonus
            processReferralBonus(userId, referralAmount || amount, transaction.refId);

            return { success: true, data: response.raw, transactionId: transaction._id };

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
