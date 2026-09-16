const mongoose = require('mongoose');
const walletService = require('./wallet.service');
const Transaction = require('../models/Transaction');
const WalletLedger = require('../models/WalletLedger');

class RefundService {
    /**
     * Process a refund for a failed transaction.
     *
     * ATOMICITY: the idempotency claim (isLoss false → true), the debit-proven
     * check, the wallet credit, and the transaction finalization all run inside
     * a SINGLE MongoDB session/transaction. There is NO crash window between
     * "claim" and "credit": if anything throws (or the process dies) before
     * commit, the whole operation rolls back, isLoss stays false, and a retry
     * can legitimately refund the user. Previously the claim was an autocommitted
     * write ahead of the credit, so a crash after the claim permanently
     * suppressed the refund while the user's debit stood.
     *
     * IDEMPOTENCY: only one concurrent caller sees isLoss=false and wins the
     * claim (modifiedCount === 1); all others return alreadyRefunded with zero
     * concurrent credits. (The old 'refunded' status guard was dead code because
     * models/Transaction.js status enum does not include 'refunded'.)
     *
     * DEBIT-PROVEN: before crediting, verify a WalletLedger debit entry exists
     * for this transaction (in the same session). Prevents wallet inflation when
     * processRefund is called for a transaction whose debit never succeeded
     * (e.g. purchase.service.js catch block fires after debit throws). If no
     * debit exists, the claim is rolled back too — a transaction that never took
     * money is not marked as a loss, and a later retry can still re-check.
     */
    static async processRefund(transactionId, reason) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const transaction = await Transaction.findById(transactionId).session(session);
            if (!transaction) throw new Error('Transaction not found');

            // Concurrency-safe idempotency: atomic claim via updateOne inside the session.
            // Only one concurrent caller will see isLoss=false and succeed;
            // all others get modifiedCount=0 and skip.
            const claimResult = await Transaction.updateOne(
                { _id: transaction._id, isLoss: false },
                { $set: { isLoss: true } },
                { session }
            );
            if (claimResult.modifiedCount === 0) {
                await session.abortTransaction();
                return { success: true, alreadyRefunded: true };
            }

            // Debit-proven guard: confirm a debit ledger entry exists for this
            // transaction before crediting back.
            const debitEntry = await WalletLedger.findOne({
                transactionId: transaction._id,
                entryType: 'debit'
            }).session(session);
            if (!debitEntry) {
                // No money was ever taken — nothing to refund. Rolling back the
                // claim keeps the transaction unclaimed (isLoss=false) so a retry
                // can re-check safely and no "loss" is recorded for a non-debit.
                await session.abortTransaction();
                return { success: true, skipped: true, reason: 'no_debit_found' };
            }

            // Credit the user back (joins this session; commits together below)
            await walletService.credit(
                transaction.userId,
                transaction.amount,
                `REFUND_${transaction.refId}`,
                'refund',
                transaction._id,
                session
            );

            // Update transaction status (isLoss already set by atomic claim above)
            transaction.status = 'failed';
            transaction.isLoss = true;
            transaction.details = {
                ...(transaction.details || {}),
                refundReason: reason,
                refundedAt: new Date()
            };
            await transaction.save({ session });

            await session.commitTransaction();
            return { success: true };
        } catch (error) {
            await session.abortTransaction();
            console.error('Refund processing failed:', error.message);
            throw error;
        } finally {
            session.endSession();
        }
    }
}

module.exports = RefundService;