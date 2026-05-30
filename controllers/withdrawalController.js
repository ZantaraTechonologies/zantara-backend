const Withdrawal = require('../models/Withdrawal')
const Wallet = require('../models/Wallet')
const User = require('../models/User')
const notificationService = require('../services/notification.service')
const walletService = require('../services/wallet.service')
const settingsService = require('../services/settings.service')
const { createTransferRecipient, initiateTransfer } = require('../utils/paystack')
const { sendEmail } = require('../utils/mailer')

/**
 * Calculate withdrawal fee based on WITHDRAWAL_FEE_CONFIG setting.
 * Mirrors the same logic used for TRANSFER_FEE_CONFIG in walletController.
 */
const calculateWithdrawalFee = (amount, feeConfig) => {
    if (feeConfig.type === 'tiered') {
        return Math.ceil(amount / (feeConfig.increment || 500)) * (feeConfig.feePerIncrement || 20);
    } else if (feeConfig.type === 'flat') {
        return feeConfig.value || 0;
    } else if (feeConfig.type === 'percentage') {
        return Math.round(amount * ((feeConfig.value || 10) / 100));
    }
    return 0;
};

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
        
        const { bankName, accountNumber, accountName } = account;

        // 3. Dynamic Fee Calculation from settings
        const feeConfig = await settingsService.getSetting('WITHDRAWAL_FEE_CONFIG', {
            type: 'percentage',
            value: 10
        });
        const fee = calculateWithdrawalFee(amount, feeConfig);
        const totalDebit = amount + fee;

        // 4. Freeze the totalDebit via WalletService
        await walletService.freeze(userId, totalDebit, refId, 'withdrawal_request')

        // 5. Create Withdrawal Record (Status: Pending)
        const request = await Withdrawal.create({
            userId,
            amount,
            fee,
            totalDebit,
            bankName,
            accountNumber,
            accountName,
            reference: refId,
            status: 'pending'
        })

        // 6. Notify Admin via Email
        await sendEmail(
            process.env.ADMIN_EMAIL,
            'New Withdrawal Request',
            `<p><b>New Withdrawal Request</b></p>
             <p>User: ${user.name} (${user.phone})</p>
             <p>Requested Amount: ₦${amount.toLocaleString()}</p>
             <p>Service Fee: ₦${fee.toLocaleString()} (${feeConfig.type === 'percentage' ? feeConfig.value + '%' : feeConfig.type === 'flat' ? 'flat' : `₦${feeConfig.feePerIncrement} per ₦${feeConfig.increment}`})</p>
             <p><b>Total Balance to Debit: ₦${totalDebit.toLocaleString()}</b></p>
             <hr>
             <p><b>Bank Details:</b></p>
             <p>Bank: ${bankName}</p>
             <p>Acc Number: ${accountNumber}</p>
             <p>Acc Name: ${accountName}</p>
             <p>Reference: ${refId}</p>
             <p>Please pay the user manually and approve the request in your admin dashboard.</p>`
        )

        // 7. Notify User via In-App/Push
        await notificationService.sendInApp(userId, {
            title: 'Withdrawal Requested',
            message: `Your withdrawal request of ₦${amount.toLocaleString()} is pending manual review.`,
            type: 'transaction',
            metadata: { withdrawalId: request._id, refId }
        });

        return res.json({ 
            message: 'Withdrawal request submitted! It will be processed after manual review.', 
            request 
        });

    } catch (err) {
        console.error('Withdrawal error:', err);
        res.status(500).json({ error: err.message })
    }
}

// Admin approves/rejects withdrawal
const processWithdrawal = async (req, res) => {
    try {
        const status = req.body.status || req.body.action;
        const adminNote = req.body.adminNote || req.body.reason;
        
        const request = await Withdrawal.findById(req.params.id)
        if (!request || request.status !== 'pending') {
            return res.status(400).json({ error: 'Invalid request or already processed' })
        }

        // Use the stored totalDebit (amount + fee at time of request)
        const totalDebit = request.totalDebit || (request.amount + (request.fee || 0));

        if (status === 'approve' || status === 'approved') {
            // Unfreeze and debit permanently via WalletService
            await walletService.unfreeze(request.userId, totalDebit, request.reference || request._id, 'withdrawal_approval')
            await walletService.debit(request.userId, totalDebit, request.reference || request._id, 'withdrawal_payout')
        } else if (status === 'reject' || status === 'rejected') {
            // Return funds (unfreeze)
            await walletService.unfreeze(request.userId, totalDebit, request.reference || request._id, 'withdrawal_rejection')
        }

        request.status = (status === 'approve' || status === 'approved') ? 'completed' : 'rejected'
        request.adminNote = adminNote
        request.processedAt = Date.now()
        await request.save()

        // ⬇️ Log Admin Action
        const { logAction } = require('./auditController');
        const { notifySuperAdmins } = require('../services/notificationService');

        await logAction(
            req.user.id,
            req.user.name,
            'WITHDRAWAL_PROCESS',
            `Withdrawal ID: ${request._id} (User: ${request.userId})`,
            { amount: request.amount, totalDebit, status, adminNote },
            'success',
            req
        );

        if ((status === 'approve' || status === 'approved') && request.amount >= 50000) {
            await notifySuperAdmins(
                `💰 Large Withdrawal Approved: ₦${request.amount.toLocaleString()}`,
                `<p>Admin <b>${req.user.name}</b> approved a large withdrawal of <b>₦${request.amount.toLocaleString()}</b> for User ${request.userId}.</p>`
            );
        }

        const user = await User.findById(request.userId)
        const statusMsg = (status === 'approve' || status === 'approved')
            ? `Your withdrawal of ₦${request.amount.toLocaleString()} has been approved.`
            : `Your withdrawal of ₦${request.amount.toLocaleString()} was rejected. Reason: ${adminNote}`

        const activityType = (status === 'approve' || status === 'approved') ? 'withdrawal_approved' : 'withdrawal_rejected';

        await notificationService.notify(user, {
            title: `Withdrawal ${status.charAt(0).toUpperCase() + status.slice(1)}`,
            message: statusMsg,
            smsMessage: `${statusMsg} Ref: ${request.reference || request._id}`,
            emailSubject: `Withdrawal ${status.charAt(0).toUpperCase() + status.slice(1)} - Zantara`,
            emailHtml: `
                <div style="font-family: sans-serif; padding: 20px;">
                    <h2>Withdrawal ${status.charAt(0).toUpperCase() + status.slice(1)}</h2>
                    <p>Hello ${user.name},</p>
                    <p>${statusMsg}</p>
                    <p><b>Amount:</b> ₦${request.amount.toLocaleString()}</p>
                    <p><b>Reference:</b> ${request.reference || request._id}</p>
                    <br>
                    <p>The Zantara Team</p>
                </div>
            `,
            type: 'transaction',
            activityType,
            metadata: { withdrawalId: request._id }
        });

        res.json({ message: `Withdrawal ${status}`, request })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
}

// Admin views all withdrawal requests
const getAllWithdrawals = async (req, res) => {
    try {
        const { status } = req.query;
        let query = {};
        if (status && status !== 'all') {
            query.status = status;
        }
        const requests = await Withdrawal.find(query).populate('userId', 'name email').sort({ createdAt: -1 });
        res.json({ success: true, data: requests });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// Admin views a specific withdrawal request
const getWithdrawalById = async (req, res) => {
    try {
        const request = await Withdrawal.findById(req.params.id).populate('userId', 'name email phone status role')
        if (!request) return res.status(404).json({ success: false, message: 'Withdrawal not found' })
        res.json({ success: true, data: request })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
}

// User views their own withdrawal history
const getMyWithdrawals = async (req, res) => {
    const requests = await Withdrawal.find({ userId: req.user.id }).sort({ createdAt: -1 })
    res.json({ success: true, data: requests })
}


module.exports = {
    requestWithdrawal,
    processWithdrawal,
    getAllWithdrawals,
    getWithdrawalById,
    getMyWithdrawals
}