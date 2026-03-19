const Withdrawal = require('../models/Withdrawal')
const Wallet = require('../models/Wallet')
const User = require('../models/User')
const { sendEmail } = require('../utils/mailer')

const walletService = require('../services/wallet.service')

// User requests withdrawal
const requestWithdrawal = async (req, res) => {
    try {
        const { amount, bankName, accountNumber, accountName, pin } = req.body
        const userId = req.user.id
        const refId = 'WTH-' + Date.now()

        if (!amount || amount <= 0) return res.status(400).json({ message: 'Invalid amount' })
        if (!bankName || !accountNumber || !accountName) return res.status(400).json({ message: 'Missing bank details' })

        // 1. PIN Validation
        const user = await User.findById(userId).select('+transactionPin');
        if (!user.isPinSet) {
            return res.status(400).json({ message: 'Transaction PIN not set' });
        }
        
        const bcrypt = require('bcryptjs');
        const isMatch = await bcrypt.compare(pin, user.transactionPin);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid transaction PIN' });
        }

        // 2. Freeze the amount via WalletService (creates ledger entry)
        await walletService.freeze(userId, amount, refId, 'withdrawal_request')

        const request = await Withdrawal.create({
            userId,
            amount,
            bankName,
            accountNumber,
            accountName,
            refId // store refId for tracing
        })

        // Send alert to admin
        await sendEmail(
            process.env.ADMIN_EMAIL,
            'New Withdrawal Request',
            `<p>User: ${user.name} (${user.phone})<br>Amount: ₦${amount}<br>Bank: ${bankName} (${accountNumber})<br>Status: Pending</p>`
        )

        res.json({ message: 'Withdrawal request submitted', request })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
}

// Admin approves/rejects withdrawal
const processWithdrawal = async (req, res) => {
    try {
        const { status, adminNote } = req.body
        const request = await Withdrawal.findById(req.params.id)
        if (!request || request.status !== 'pending') {
            return res.status(400).json({ error: 'Invalid request or already processed' })
        }

        const wallet = await Wallet.findOne({ userId: request.userId })

        if (status === 'approved') {
            // Unfreeze and debit permanently via WalletService
            await walletService.unfreeze(request.userId, request.amount, request.refId || request._id, 'withdrawal_approval')
            await walletService.debit(request.userId, request.amount, request.refId || request._id, 'withdrawal_payout')
        } else if (status === 'rejected') {
            // Return funds via WalletService
            await walletService.unfreeze(request.userId, request.amount, request.refId || request._id, 'withdrawal_rejection')
        }

        request.adminNote = adminNote
        await request.save()

        // ⬇️ Log Admin Action
        const { logAction } = require('./auditController');
        await logAction(
            req.user.id,
            req.user.name,
            'WITHDRAWAL_PROCESS',
            `Withdrawal ID: ${request._id}`,
            { status, adminNote }
        );

        const user = await User.findById(request.userId)
        const statusMsg = status === 'approved'
            ? `Your withdrawal of ₦${request.amount} has been approved.`
            : `Your withdrawal of ₦${request.amount} was rejected. Reason: ${adminNote}`

        await sendEmail(
            user.email,
            `Withdrawal ${status.charAt(0).toUpperCase() + status.slice(1)}`,
            `<p>Hello ${user.name},</p><p>${statusMsg}</p>`
        )

        res.json({ message: `Withdrawal ${status}`, request })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
}

// Admin views all withdrawal requests
const getAllWithdrawals = async (req, res) => {
    const requests = await Withdrawal.find().populate('userId', 'name email').sort({ createdAt: -1 })
    res.json(requests)
}

// User views their own withdrawal history
const getMyWithdrawals = async (req, res) => {
    const requests = await Withdrawal.find({ userId: req.user.id }).sort({ createdAt: -1 })
    res.json(requests)
}


module.exports = {
    requestWithdrawal,
    processWithdrawal,
    getAllWithdrawals,
    getMyWithdrawals
}