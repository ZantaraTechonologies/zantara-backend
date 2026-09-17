const crypto = require('crypto')
const mongoose = require('mongoose')
const Withdrawal = require('../models/Withdrawal')
const User = require('../models/User')
const notificationService = require('../services/notification.service')
const walletService = require('../services/wallet.service')
const settingsService = require('../services/settings.service')
const { sendEmail } = require('../utils/mailer')

const requireFiniteNonNegative = (value, name) => {
    const normalized = Number(value)
    if (!Number.isFinite(normalized) || normalized < 0) {
        throw new Error(`Invalid withdrawal fee ${name}`)
    }
    return normalized
}

/** Preserve the existing fee formulas while failing closed on malformed settings. */
const calculateWithdrawalFee = (amount, feeConfig) => {
    if (!feeConfig || typeof feeConfig !== 'object') {
        throw new Error('Invalid withdrawal fee configuration')
    }

    let fee
    if (feeConfig.type === 'tiered') {
        const increment = requireFiniteNonNegative(feeConfig.increment ?? 500, 'increment')
        const feePerIncrement = requireFiniteNonNegative(feeConfig.feePerIncrement ?? 20, 'amount')
        if (increment === 0) throw new Error('Invalid withdrawal fee increment')
        fee = Math.ceil(amount / increment) * feePerIncrement
    } else if (feeConfig.type === 'flat') {
        fee = requireFiniteNonNegative(feeConfig.value ?? 0, 'amount')
    } else if (feeConfig.type === 'percentage') {
        const percentage = requireFiniteNonNegative(feeConfig.value ?? 10, 'percentage')
        fee = Math.round(amount * (percentage / 100))
    } else {
        throw new Error('Invalid withdrawal fee configuration')
    }

    if (!Number.isFinite(fee) || fee < 0) throw new Error('Invalid withdrawal fee')
    return fee
}

const maskAccountNumber = accountNumber => {
    const value = String(accountNumber || '')
    const visible = value.slice(-4)
    return `${'*'.repeat(Math.max(0, value.length - visible.length))}${visible}`
}

const toCustomerWithdrawal = withdrawal => {
    const value = withdrawal && typeof withdrawal.toObject === 'function'
        ? withdrawal.toObject()
        : withdrawal

    return {
        id: value._id,
        reference: value.reference,
        amount: value.amount,
        fee: value.fee,
        totalDebit: value.totalDebit,
        status: value.status,
        bankName: value.bankName,
        maskedAccountNumber: maskAccountNumber(value.accountNumber),
        createdAt: value.createdAt,
        processedAt: value.processedAt
    }
}

const isExpectedWalletError = error => /insufficient|wallet not found/i.test(error && error.message)

// User requests withdrawal
const requestWithdrawal = async (req, res) => {
    const { amount, accountId, pin } = req.body
    const normalizedAmount = Number(amount)

    if (!Number.isFinite(normalizedAmount) || normalizedAmount < 500) {
        return res.status(400).json({ message: 'Minimum withdrawal is ₦500.00' })
    }
    if (!accountId) return res.status(400).json({ message: 'Target bank account is required' })
    if (typeof pin !== 'string') return res.status(400).json({ message: 'Invalid transaction PIN' })

    let session
    let committed = false
    try {
        const userId = req.user.id
        const user = await User.findById(userId).select('+transactionPin +linkedAccounts')
        if (!user || !user.isPinSet) {
            return res.status(400).json({ message: 'Transaction PIN not set' })
        }

        const bcrypt = require('bcryptjs')
        const isMatch = await bcrypt.compare(pin, user.transactionPin)
        if (!isMatch) return res.status(400).json({ message: 'Invalid transaction PIN' })

        let account
        try {
            account = user.linkedAccounts.id(accountId)
        } catch (_) {
            account = null
        }
        if (!account) return res.status(404).json({ message: 'Linked bank account not found' })

        const feeConfig = await settingsService.getSetting('WITHDRAWAL_FEE_CONFIG', {
            type: 'percentage',
            value: 10
        })
        const fee = calculateWithdrawalFee(normalizedAmount, feeConfig)
        const totalDebit = normalizedAmount + fee
        if (!Number.isFinite(totalDebit) || totalDebit <= 0) {
            throw new Error('Invalid withdrawal total')
        }

        const reference = `WTH-${crypto.randomUUID()}`
        session = await mongoose.startSession()
        session.startTransaction()

        await walletService.freeze(userId, totalDebit, reference, 'withdrawal_request', session)
        const [request] = await Withdrawal.create([{
            userId,
            amount: normalizedAmount,
            fee,
            totalDebit,
            bankName: account.bankName,
            accountNumber: account.accountNumber,
            accountName: account.accountName,
            reference,
            status: 'pending'
        }], { session })

        await session.commitTransaction()
        committed = true

        // External side effects are deliberately dispatched only after commit.
        sendEmail(
            process.env.ADMIN_EMAIL,
            'New Withdrawal Request',
            `<p><b>New Withdrawal Request</b></p>
             <p>User: ${user.name} (${user.phone})</p>
             <p>Requested Amount: ₦${normalizedAmount.toLocaleString()}</p>
             <p>Service Fee: ₦${fee.toLocaleString()}</p>
             <p><b>Total Balance to Debit: ₦${totalDebit.toLocaleString()}</b></p>
             <hr>
             <p><b>Bank Details:</b></p>
             <p>Bank: ${account.bankName}</p>
             <p>Acc Number: ${account.accountNumber}</p>
             <p>Acc Name: ${account.accountName}</p>
             <p>Reference: ${reference}</p>
             <p>Please pay the user manually and approve the request in your admin dashboard.</p>`
        ).catch(error => console.error('[Withdrawal Admin Notification Error]', error.message))

        notificationService.sendInApp(userId, {
            title: 'Withdrawal Requested',
            message: `Your withdrawal request of ₦${normalizedAmount.toLocaleString()} is pending manual review.`,
            type: 'transaction',
            metadata: { withdrawalId: request._id, refId: reference }
        }, `withdrawal_requested:${request._id}`).catch(error => {
            console.error('[Withdrawal Request Notification Error]', error.message)
        })

        return res.json({
            message: 'Withdrawal request submitted! It will be processed after manual review.',
            request: toCustomerWithdrawal(request)
        })
    } catch (error) {
        if (session && !committed) {
            try { await session.abortTransaction() } catch (_) {}
        }
        console.error('Withdrawal error:', error)
        if (isExpectedWalletError(error)) return res.status(400).json({ message: error.message })
        return res.status(500).json({ message: 'Unable to process withdrawal request' })
    } finally {
        if (session) await session.endSession()
    }
}

const normalizeAdminAction = (body = {}) => {
    const action = body.status || body.action
    if (action === 'approve' || action === 'approved') return 'completed'
    if (action === 'reject' || action === 'rejected') return 'rejected'
    return null
}

// Admin approves/rejects withdrawal
const processWithdrawal = async (req, res) => {
    const body = req.body || {}
    const terminalStatus = normalizeAdminAction(body)
    if (!terminalStatus) return res.status(400).json({ error: 'Invalid withdrawal action' })

    const adminNote = body.adminNote || body.reason || ''
    let session
    let request
    let totalDebit
    let committed = false

    try {
        session = await mongoose.startSession()
        session.startTransaction()

        request = await Withdrawal.findOneAndUpdate(
            { _id: req.params.id, status: 'pending' },
            { $set: { status: 'processing' } },
            { new: true, session }
        )
        if (!request) {
            await session.abortTransaction()
            return res.status(409).json({ error: 'Invalid request or already processed' })
        }

        totalDebit = Number(request.totalDebit ?? (Number(request.amount) + Number(request.fee || 0)))
        if (!Number.isFinite(totalDebit) || totalDebit <= 0) throw new Error('Invalid withdrawal total')

        if (terminalStatus === 'completed') {
            await walletService.unfreeze(request.userId, totalDebit, request.reference || request._id, 'withdrawal_approval', session)
            await walletService.debit(request.userId, totalDebit, request.reference || request._id, 'withdrawal_payout', null, session)
        } else {
            await walletService.unfreeze(request.userId, totalDebit, request.reference || request._id, 'withdrawal_rejection', session)
        }

        request.status = terminalStatus
        request.adminNote = adminNote
        request.processedBy = req.user.id
        request.processedAt = new Date()
        await request.save({ session })
        await session.commitTransaction()
        committed = true
    } catch (error) {
        if (session && !committed) {
            try { await session.abortTransaction() } catch (_) {}
        }
        const conflict = error && (error.code === 112 || error.hasErrorLabel && error.hasErrorLabel('TransientTransactionError'))
        if (conflict) return res.status(409).json({ error: 'Invalid request or already processed' })
        if (isExpectedWalletError(error)) return res.status(400).json({ error: error.message })
        console.error('Withdrawal processing error:', error)
        return res.status(500).json({ error: 'Unable to process withdrawal' })
    } finally {
        if (session) await session.endSession()
    }

    const { logAction } = require('./auditController')
    logAction(
        req.user.id,
        req.user.name,
        'WITHDRAWAL_PROCESS',
        `Withdrawal ID: ${request._id} (User: ${request.userId})`,
        { amount: request.amount, totalDebit, status: terminalStatus, adminNote },
        'success',
        req
    ).catch(error => console.error('Audit logging failed:', error.message))

    if (terminalStatus === 'completed' && request.amount >= 50000) {
        const { notifySuperAdmins } = require('../services/notificationService')
        notifySuperAdmins(
            `Large Withdrawal Approved: ₦${request.amount.toLocaleString()}`,
            `<p>Admin <b>${req.user.name}</b> approved a large withdrawal of <b>₦${request.amount.toLocaleString()}</b> for User ${request.userId}.</p>`
        ).catch(error => console.error('Super admin notification failed:', error.message))
    }

    try {
        const user = await User.findById(request.userId)
        if (user) {
            const approved = terminalStatus === 'completed'
            const statusMsg = approved
                ? `Your withdrawal of ₦${request.amount.toLocaleString()} has been approved.`
                : `Your withdrawal of ₦${request.amount.toLocaleString()} was rejected. Reason: ${adminNote}`
            const displayStatus = approved ? 'Approved' : 'Rejected'

            await notificationService.notify(user, {
                title: `Withdrawal ${displayStatus}`,
                message: statusMsg,
                smsMessage: `${statusMsg} Ref: ${request.reference || request._id}`,
                emailSubject: `Withdrawal ${displayStatus} - Zantara`,
                emailHtml: `
                    <div style="font-family: sans-serif; padding: 20px;">
                        <h2>Withdrawal ${displayStatus}</h2>
                        <p>Hello ${user.name},</p>
                        <p>${statusMsg}</p>
                        <p><b>Amount:</b> ₦${request.amount.toLocaleString()}</p>
                        <p><b>Reference:</b> ${request.reference || request._id}</p>
                        <br>
                        <p>The Zantara Team</p>
                    </div>
                `,
                type: 'transaction',
                activityType: approved ? 'withdrawal_approved' : 'withdrawal_rejected',
                metadata: { withdrawalId: request._id },
                eventKey: `withdrawal_processed:${request._id}:${terminalStatus}`
            })
        }
    } catch (error) {
        console.error('[Withdrawal Notification Error]', error.message)
    }

    return res.json({ message: `Withdrawal ${terminalStatus}`, request })
}

// Admin views all withdrawal requests
const getAllWithdrawals = async (req, res) => {
    try {
        const { status } = req.query
        const query = status && status !== 'all' ? { status } : {}
        const requests = await Withdrawal.find(query).populate('userId', 'name email').sort({ createdAt: -1 })
        res.json({ success: true, data: requests })
    } catch (error) {
        res.status(500).json({ error: 'Unable to load withdrawals' })
    }
}

// Admin views a specific withdrawal request
const getWithdrawalById = async (req, res) => {
    try {
        const request = await Withdrawal.findById(req.params.id).populate('userId', 'name email phone status role')
        if (!request) return res.status(404).json({ success: false, message: 'Withdrawal not found' })
        res.json({ success: true, data: request })
    } catch (error) {
        res.status(500).json({ error: 'Unable to load withdrawal' })
    }
}

// User views their own withdrawal history
const getMyWithdrawals = async (req, res) => {
    try {
        const requests = await Withdrawal.find({ userId: req.user.id }).sort({ createdAt: -1 })
        res.json({ success: true, data: requests.map(toCustomerWithdrawal) })
    } catch (error) {
        res.status(500).json({ error: 'Unable to load withdrawals' })
    }
}

module.exports = {
    requestWithdrawal,
    processWithdrawal,
    getAllWithdrawals,
    getWithdrawalById,
    getMyWithdrawals
}
