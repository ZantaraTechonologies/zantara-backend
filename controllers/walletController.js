const Wallet = require('../models/Wallet')
const User = require('../models/User')
const Transaction = require('../models/Transaction')
const mongoose = require('mongoose')

const { logTransaction } = require('../utils/transaction')
// We can use a simple timestamp ref or import generator if available
const generateRef = () => 'MAN-' + Date.now() + Math.floor(Math.random() * 1000)

const walletService = require('../services/wallet.service')

const getWallet = async (req, res) => {
    const wallet = await Wallet.findOne({ userId: req.user.id })
    res.json(wallet)
}

const debitWallet = async (req, res) => {
    try {
        const userId = req.user.id
        const amount = Number(req.body.amount)
        const refId = 'MAN-' + Date.now()
        
        await walletService.debit(userId, amount, refId, 'admin_debit')

        res.json({ message: 'Wallet debited successfully', refId })
    } catch (err) {
        res.status(400).json({ error: err.message })
    }
}

const creditWallet = async (req, res) => {
    try {
        const userId = req.user.id
        const amount = Number(req.body.amount)
        const refId = 'MAN-' + Date.now()

        await walletService.credit(userId, amount, refId, 'admin_credit')

        res.json({ message: 'Wallet credited successfully', refId })
    } catch (err) {
        res.status(400).json({ error: err.message })
    }
}

const freezeWallet = async (req, res) => {
    res.json("Wallet Freeze")
}

const unfreezeWallet = async (req, res) => {
    res.json("Wallet UnFreeze")
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

        // 1. Debit Referral Balance
        user.referralBalance -= amountNum;
        await user.save({ session });

        // 2. Credit Main Wallet
        await walletService.credit(userId, amountNum, refId, 'referral_redemption', null, session);

        // 3. Log Transaction
        await Transaction.create([{
            userId,
            transactionId: refId,
            refId,
            type: 'referral_redeem',
            service: 'Referral',
            amount: amountNum,
            status: 'success',
            details: { message: 'Referral earnings redemption' }
        }], { session });

        await session.commitTransaction();
        session.endSession();

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


module.exports = {
    getWallet,
    debitWallet,
    creditWallet,
    freezeWallet,
    unfreezeWallet,
    redeemEarnings
}