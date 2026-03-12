const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletLedger = require('../models/WalletLedger');

class WalletService {
    /**
     * Credit a user's wallet and record a ledger entry.
     */
    static async credit(userId, amount, reference, source, transactionId = null) {
        if (amount <= 0) throw new Error('Amount must be greater than zero');

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const wallet = await Wallet.findOne({ userId }).session(session);
            if (!wallet) throw new Error('Wallet not found');

            const balanceBefore = wallet.balance;
            wallet.balance += amount;
            await wallet.save({ session });

            const balanceAfter = wallet.balance;

            // Create ledger entry
            await WalletLedger.create([{
                walletId: wallet._id,
                userId,
                transactionId,
                reference,
                entryType: 'credit',
                source,
                amount,
                balanceBefore,
                balanceAfter
            }], { session });

            await session.commitTransaction();
            return { balance: balanceAfter };
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
    }

    /**
     * Debit a user's wallet and record a ledger entry.
     */
    static async debit(userId, amount, reference, source, transactionId = null) {
        if (amount <= 0) throw new Error('Amount must be greater than zero');

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const wallet = await Wallet.findOne({ userId }).session(session);
            if (!wallet || wallet.balance < amount) {
                throw new Error('Insufficient wallet balance');
            }

            const balanceBefore = wallet.balance;
            wallet.balance -= amount;
            await wallet.save({ session });

            const balanceAfter = wallet.balance;

            // Create ledger entry
            await WalletLedger.create([{
                walletId: wallet._id,
                userId,
                transactionId,
                reference,
                entryType: 'debit',
                source,
                amount,
                balanceBefore,
                balanceAfter
            }], { session });

            await session.commitTransaction();
            return { balance: balanceAfter };
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
    }

    /**
     * Freeze an amount in user's wallet.
     */
    static async freeze(userId, amount, reference, source) {
        if (amount <= 0) throw new Error('Amount must be greater than zero');

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const wallet = await Wallet.findOne({ userId }).session(session);
            if (!wallet || wallet.balance < amount) throw new Error('Insufficient balance to freeze');

            const balanceBefore = wallet.balance;
            wallet.balance -= amount;
            wallet.frozen += amount;
            await wallet.save({ session });

            const balanceAfter = wallet.balance;

            await WalletLedger.create([{
                walletId: wallet._id,
                userId,
                reference,
                entryType: 'debit',
                source: `${source}_freeze`,
                amount,
                balanceBefore,
                balanceAfter,
                metadata: { action: 'freeze', frozenAmount: amount }
            }], { session });

            await session.commitTransaction();
            return { balance: balanceAfter, frozen: wallet.frozen };
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
    }

    /**
     * Unfreeze an amount and return to balance.
     */
    static async unfreeze(userId, amount, reference, source) {
        if (amount <= 0) throw new Error('Amount must be greater than zero');

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const wallet = await Wallet.findOne({ userId }).session(session);
            if (!wallet || wallet.frozen < amount) throw new Error('Insufficient frozen funds');

            const balanceBefore = wallet.balance;
            wallet.frozen -= amount;
            wallet.balance += amount;
            await wallet.save({ session });

            const balanceAfter = wallet.balance;

            await WalletLedger.create([{
                walletId: wallet._id,
                userId,
                reference,
                entryType: 'credit',
                source: `${source}_unfreeze`,
                amount,
                balanceBefore,
                balanceAfter,
                metadata: { action: 'unfreeze', unfrozenAmount: amount }
            }], { session });

            await session.commitTransaction();
            return { balance: balanceAfter, frozen: wallet.frozen };
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
    }
}

module.exports = WalletService;
