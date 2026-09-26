const Wallet = require('../models/Wallet')
const User = require('../models/User')
const Transaction = require('../models/Transaction')
const mongoose = require('mongoose')
const { generateTransactionId } = require('../utils/generateID')

const walletService = require('../services/wallet.service')

const getWallet = async (req, res) => {
    const wallet = await Wallet.findOne({ userId: req.user.id })
    res.json(wallet)
}

const bcrypt = require('bcryptjs')

const redeemEarnings = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const userId = req.user.id;
        const { amount, pin } = req.body;
        const amountNum = Number(amount);

        if (!amountNum || amountNum <= 0) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Invalid amount' });
        }

        // Verify PIN
        const user = await User.findById(userId).select('+transactionPin').session(session);
        if (!user || !user.isPinSet) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Transaction PIN not set' });
        }

        if (!pin) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Transaction PIN is required' });
        }

        const pinMatch = await bcrypt.compare(pin, user.transactionPin);
        if (!pinMatch) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Invalid transaction PIN' });
        }

        if ((user.referralBalance || 0) < amountNum) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Insufficient referral balance' });
        }

        const refId = 'RED-' + Date.now();

        // Reserve the globally unique transaction identity before any wallet
        // mutation. The enclosing MongoDB transaction keeps the write atomic.
        await Transaction.create([{
            userId,
            transactionId: generateTransactionId(),
            refId,
            type: 'referral_redeem',
            service: 'Referral',
            amount: amountNum,
            status: 'success',
            details: { message: 'Referral earnings redemption' }
        }], { session });

        // 1. Debit Referral Balance
        user.referralBalance -= amountNum;
        await user.save({ session });

        // 2. Credit Main Wallet
        await walletService.credit(userId, amountNum, refId, 'referral_redemption', null, session);

        await session.commitTransaction();
        session.endSession();

        const notificationService = require('../services/notification.service');
        await notificationService.sendInApp(userId, {
            title: 'Earnings Redeemed',
            message: `₦${amount.toLocaleString()} from your referral wallet has been added to your main balance.`,
            type: 'transaction'
        });

        res.json({ 
            success: true, 
            message: 'Earnings redeemed successfully', 
            newBalance: user.referralBalance 
        });
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        console.error('Redeem error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
}

const verifyTransferRecipient = async (req, res) => {
    try {
        const { identifier } = req.query; // phone or email
        if (!identifier) return res.status(400).json({ message: 'Recipient identifier is required' });

        const recipient = await User.findOne({
            $or: [
                { phone: identifier },
                { email: identifier.toLowerCase() }
            ]
        }).select('name phone email');

        if (!recipient) return res.status(404).json({ message: 'User not found' });
        if (recipient._id.toString() === req.user.id) return res.status(400).json({ message: 'You cannot transfer to yourself' });

        res.json({ name: recipient.name, identifier: recipient.phone });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

const transferMoney = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { identifier, amount, pin, remarks } = req.body;
        const senderId = req.user.id;
        const amountNum = Number(amount);

        if (!amountNum || amountNum < 100) throw new Error('Minimum transfer is ₦100');

        // 1. PIN Validation
        const sender = await User.findById(senderId).select('+transactionPin name phone isPinSet').session(session);
        if (!sender.isPinSet) throw new Error('Transaction PIN not set');
        const pinMatch = await bcrypt.compare(pin, sender.transactionPin);
        if (!pinMatch) throw new Error('Invalid transaction PIN');

        // 2. Resolve Recipient
        const receiver = await User.findOne({
            $or: [
                { phone: identifier },
                { email: identifier.toLowerCase() }
            ]
        }).session(session);
        if (!receiver) throw new Error('Recipient not found');
        if (receiver._id.toString() === senderId) throw new Error('Cannot transfer to yourself');

        // 3. Fee Calculation
        const settingsService = require('../services/settings.service');
        const feeConfig = await settingsService.getSetting('TRANSFER_FEE_CONFIG', {
            type: 'tiered',
            increment: 500,
            feePerIncrement: 20
        });

        let fee = 0;
        if (feeConfig.type === 'tiered') {
            fee = Math.ceil(amountNum / (feeConfig.increment || 500)) * (feeConfig.feePerIncrement || 20);
        } else if (feeConfig.type === 'flat') {
            fee = feeConfig.value || 0;
        } else if (feeConfig.type === 'percentage') {
            fee = (amountNum * (feeConfig.value || 0)) / 100;
        }

        const totalDebit = amountNum + fee;

        const reference = 'TRF-' + Date.now();

        // Reserve both customer transaction identities before wallet entries.
        // A duplicate-key failure therefore aborts before financial writes run.
        await Transaction.create([{
            userId: senderId,
            transactionId: generateTransactionId(),
            refId: reference + '-S',
            type: 'transfer_out',
            service: 'Local Transfer',
            amount: amountNum,
            fee: fee,
            status: 'success',
            details: { recipientName: receiver.name, recipientPhone: receiver.phone, remarks }
        }, {
            userId: receiver._id,
            transactionId: generateTransactionId(),
            refId: reference + '-R',
            type: 'transfer_in',
            service: 'Local Transfer',
            amount: amountNum,
            status: 'success',
            details: { senderName: sender.name, senderPhone: sender.phone, remarks }
        }], { session });

        // 4. Atomic Debit & Credit
        await walletService.debit(senderId, totalDebit, reference, 'wallet_transfer_out', null, session);
        await walletService.credit(receiver._id, amountNum, reference, 'wallet_transfer_in', null, session);

        await session.commitTransaction();
        session.endSession();

        // 6. Notifications
        const notificationService = require('../services/notification.service');
        await notificationService.sendInApp(senderId, {
            title: 'Transfer Successful',
            message: `You sent ₦${amountNum.toLocaleString()} to ${receiver.name}. Fee: ₦${fee}`,
            type: 'transaction'
        });

        await notificationService.sendInApp(receiver._id, {
            title: 'Money Received',
            message: `You received ₦${amountNum.toLocaleString()} from ${sender.name}.`,
            type: 'transaction'
        });

        res.json({ success: true, message: 'Transfer successful', fee });

    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        console.error('Transfer error:', err);
        res.status(400).json({ error: err.message });
    }
}

module.exports = {
    getWallet,
    redeemEarnings,
    verifyTransferRecipient,
    transferMoney
}
