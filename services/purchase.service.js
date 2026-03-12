const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const walletService = require('./wallet.service');
const refundService = require('./refund.service');
const providerService = require('./provider.service');
const pinService = require('./pin.service');
const { processReferralBonus } = require('../utils/referral');
const { calculateServicePrice } = require('../utils/pricing');

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

            // 1. Create PENDING Transaction Record
            transaction = await Transaction.create({
                userId,
                refId: details.request_id || `TXN_${Date.now()}`,
                type,
                service: serviceId,
                amount: finalAmount,
                status: 'pending',
                details: { ...details, originalAmount: amount }
            });

            // 2. Debit Wallet FIRST (with Ledger entry)
            await walletService.debit(userId, finalAmount, transaction.refId, `${type}_purchase`, transaction._id);

            // 3. Call External Provider
            const response = await providerCall(transaction.refId);

            if (!response.success) {
                // 4. Automated Refund if provider fails
                await refundService.processRefund(transaction._id, response.message || 'Provider failed');
                return { success: false, message: response.message, error: response };
            }

            // 5. Finalize transaction on success
            transaction.status = 'success';
            transaction.response = response.raw;
            await transaction.save();

            // 6. Referral Bonus
            processReferralBonus(userId, referralAmount || amount, transaction.refId);

            return { success: true, data: response.raw, transactionId: transaction._id };

        } catch (err) {
            console.error(`${type} purchase service error:`, err.message);
            if (transaction && transaction.status === 'pending') {
                try {
                    await refundService.processRefund(transaction._id, err.message);
                } catch (refundErr) {
                    console.error('CRITICAL: Refund failed after error:', refundErr.message);
                }
            }
            throw err;
        }
    }
}

module.exports = new PurchaseService();
