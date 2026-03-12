const walletService = require('./wallet.service');
const Transaction = require('../models/Transaction');

class RefundService {
    /**
     * Process a refund for a failed transaction.
     */
    static async processRefund(transactionId, reason) {
        try {
            const transaction = await Transaction.findById(transactionId);
            if (!transaction) throw new Error('Transaction not found');
            if (transaction.status === 'refunded') return; // Already refunded

            // Credit the user back
            await walletService.credit(
                transaction.userId,
                transaction.amount,
                `REFUND_${transaction.refId}`,
                'refund',
                transaction._id
            );

            // Update transaction status
            transaction.status = 'failed'; // Or 'refunded' if added to enum
            transaction.metadata = { 
                ...(transaction.metadata || {}), 
                refundReason: reason,
                refundedAt: new Date()
            };
            await transaction.save();

            return { success: true };
        } catch (error) {
            console.error('Refund processing failed:', error.message);
            throw error;
        }
    }
}

module.exports = RefundService;
