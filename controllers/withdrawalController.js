const Withdrawal = require('../models/Withdrawal')
const Wallet = require('../models/Wallet')
const User = require('../models/User')
const { sendEmail } = require('../utils/mailer')
const notificationService = require('../services/notification.service')
const walletService = require('../services/wallet.service')
const { createTransferRecipient, initiateTransfer } = require('../utils/paystack')

// User requests withdrawal
const requestWithdrawal = async (req, res) => {
    try {
        const { amount, accountId, pin } = req.body
        const userId = req.user.id
        const refId = 'WTH-' + Date.now()

        if (!amount || amount < 500) return res.status(400).json({ message: 'Minimum withdrawal is ₦500.00' })
        if (!accountId) return res.status(400).json({ message: 'Target bank account is required' })

        // 1. PIN Validation
        const user = await User.findById(userId).select('+transactionPin +linkedAccounts');
        if (!user || !user.isPinSet) {
            return res.status(400).json({ message: 'Transaction PIN not set' });
        }
        
        const bcrypt = require('bcryptjs');
        const isMatch = await bcrypt.compare(pin, user.transactionPin);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid transaction PIN' });
        }

        // 2. Resolve Linked Account
        const account = user.linkedAccounts.id(accountId);
        if (!account) return res.status(404).json({ message: 'Linked bank account not found' });
        
        const { bankName, accountNumber, accountName, bankCode } = account;

        // 3. Fee Calculation (10%)
        const fee = Math.round(amount * 0.10);
        const totalDebit = amount + fee;

        // 4. Freeze the totalDebit via WalletService
        await walletService.freeze(userId, totalDebit, refId, 'withdrawal_request')

        // 5. Create Withdrawal Record
        const request = await Withdrawal.create({
            userId,
            amount,
            fee,
            totalDebit,
            bankName,
            accountNumber,
            accountName,
            reference: refId,
            status: 'processing'
        })

        // 6. Paystack Integration (Instant)
        try {
            const recipientCode = await createTransferRecipient(accountName, accountNumber, bankCode);
            const transfer = await initiateTransfer(amount, recipientCode, refId);

            if (transfer.status) {
                // Success - Unfreeze and debit permanently
                await walletService.unfreeze(userId, totalDebit, refId, 'withdrawal_success');
                await walletService.debit(userId, totalDebit, refId, 'withdrawal_payout');
                
                request.status = 'completed';
                await request.save();

                await notificationService.sendInApp(userId, {
                    title: 'Withdrawal Successful',
                    message: `Withdrawal of ₦${amount.toLocaleString()} (Fee: ₦${fee.toLocaleString()}) was successful.`,
                    type: 'transaction',
                    metadata: { withdrawalId: request._id }
                });

                return res.json({ message: 'Withdrawal processed successfully', request });
            } else {
                throw new Error(transfer.message || 'Transfer failed at Paystack');
            }
        } catch (paystackError) {
            console.error('Paystack Transfer Error:', paystackError);
            
            // Fail - Unfreeze and return funds to user balance
            await walletService.unfreeze(userId, totalDebit, refId, 'withdrawal_failed');
            
            request.status = 'failed';
            request.notes = paystackError.message;
            await request.save();

            return res.status(500).json({ message: 'Transfer failed: ' + paystackError.message });
        }
    } catch (err) {
        console.error('Withdrawal error:', err);
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
        const { notifySuperAdmins } = require('../services/notificationService');

        await logAction(
            req.user.id,
            req.user.name,
            'WITHDRAWAL_PROCESS',
            `Withdrawal ID: ${request._id} (User: ${request.userId})`,
            { amount: request.amount, status, adminNote },
            'success',
            req
        );

        if (status === 'approved' && request.amount >= 50000) {
            await notifySuperAdmins(
                `💰 Large Withdrawal Approved: ₦${request.amount.toLocaleString()}`,
                `<p>Admin <b>${req.user.name}</b> approved a large withdrawal of <b>₦${request.amount.toLocaleString()}</b> for User ${request.userId}.</p>`
            );
        }

        const user = await User.findById(request.userId)
        const statusMsg = status === 'approved'
            ? `Your withdrawal of ₦${request.amount} has been approved.`
            : `Your withdrawal of ₦${request.amount} was rejected. Reason: ${adminNote}`

        await sendEmail(
            user.email,
            `Withdrawal ${status.charAt(0).toUpperCase() + status.slice(1)}`,
            `<p>Hello ${user.name},</p><p>${statusMsg}</p>`
        )

        // ⬇️ Push/In-App Notification
        await notificationService.sendInApp(request.userId, {
            title: `Withdrawal ${status.charAt(0).toUpperCase() + status.slice(1)}`,
            message: statusMsg,
            type: 'transaction',
            metadata: { withdrawalId: request._id }
        });

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