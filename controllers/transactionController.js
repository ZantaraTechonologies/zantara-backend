const Transaction = require('../models/Transaction')
const User = require('../models/User')
const mongoose = require('mongoose')

const getUserTransactions = async (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const transactions = await Transaction.find({ userId: req.user.id })
        .sort({ createdAt: -1 })
        .limit(limit)
    res.json(transactions)
}

const getUserTransaction = async (req, res) => {
    try {
        const userId = req.user.id;
        const id = req.params.id;

        // 1. Check Transactions first
        let transaction = await Transaction.findOne({ userId, _id: id });
        
        if (transaction) {
            return res.json(transaction);
        }

        // 2. Check WalletLedger for Skipped Commissions (ID might be a MongoDB ID or a "SKIP-" ref)
        const WalletLedger = require('../models/WalletLedger');
        let skipLog;
        
        if (mongoose.Types.ObjectId.isValid(id)) {
            skipLog = await WalletLedger.findOne({ userId, _id: id, source: 'REFERRAL_SKIPPED' });
        } else {
            skipLog = await WalletLedger.findOne({ userId, reference: id, source: 'REFERRAL_SKIPPED' });
        }

        if (skipLog) {
            // Map to a Transaction-like structure for the frontend
            return res.json({
                _id: skipLog._id,
                userId: skipLog.userId,
                transactionId: skipLog.metadata ? skipLog.metadata.parentTxnId : skipLog.reference,
                refId: skipLog.reference,
                type: 'referral_skipped',
                service: 'Skipped Commission',
                amount: 0,
                status: 'skipped',
                createdAt: skipLog.createdAt,
                metadata: skipLog.metadata,
                details: skipLog.metadata // duplicate for frontend safety
            });
        }

        return res.status(404).json({ message: 'Transaction or log not found' });
    } catch (error) {
        console.error('Error fetching transaction:', error);
        res.status(500).json({ message: 'Server error' });
    }
}

const getFilteredTransactions = async (req, res) => {
    try {
        const { type, userId, startDate, endDate, status } = req.query

        let filter = {}

        if (type) filter.type = type
        if (status) filter.status = status
        if (userId && mongoose.Types.ObjectId.isValid(userId)) filter.userId = userId

        if (startDate || endDate) {
            filter.createdAt = {}
            if (startDate) filter.createdAt.$gte = new Date(startDate)
            if (endDate) filter.createdAt.$lte = new Date(endDate)
        }

        const transactions = await Transaction.find(filter)
            .sort({ createdAt: -1 })
            .populate('userId', 'name email phone') // optional
            .limit(100) // limit for safety

        res.status(200).json({ success: true, data: transactions })
    } catch (error) {
        console.error('Admin transaction fetch error:', error)
        res.status(500).json({ success: false, message: 'Server error' })
    }
}

const getAllUsers = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        const users = await User.find()
            .sort({ createdAt: -1 })
            .select('-password')
            .skip(skip)
            .limit(limit);

        const total = await User.countDocuments();

        res.status(200).json({ 
            success: true, 
            data: users,
            pagination: { total, page, limit, pages: Math.ceil(total / limit) }
        });
    } catch (error) {
        console.error('Admin fetch users error:', error);
        res.status(500).json({ success: false, message: 'Error fetching users' });
    }
};

const getAllTransactions = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const { search, status, service, from, to, minAmount, maxAmount, userId } = req.query;

        let filter = {};

        if (status) filter.status = status;
        if (service) {
            const s = String(service).toLowerCase();
            if (['funding', 'credit', 'topup', 'paystack'].includes(s)) {
                filter.type = 'funding';
            } else if (s === 'commission') {
                filter.service = { $regex: /commission/i };
            } else if (s === 'data') {
                filter.type = { $ne: 'funding' };
                filter.service = { $regex: /mtn|glo|9mobile|airtel|data/i };
            } else if (service === 'airtime') {
                filter.type = { $ne: 'funding' };
                filter.service = { $regex: /airtime|mtn|glo|9mobile|airtel/i };
            } else {
                filter.service = { $regex: new RegExp(service, 'i') };
            }
        }
        
        // Handle direct userId Filter
        if (userId && mongoose.Types.ObjectId.isValid(userId)) {
            filter.userId = userId;
        }

        // Date Range
        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = new Date(from);
            if (to) {
                const toDate = new Date(to);
                toDate.setHours(23, 59, 59, 999);
                filter.createdAt.$lte = toDate;
            }
        }

        // Amount Range
        if (minAmount || maxAmount) {
            filter.amount = {};
            if (minAmount) filter.amount.$gte = Number(minAmount);
            if (maxAmount) filter.amount.$lte = Number(maxAmount);
        }

        // Search on IDs/Refs
        if (search) {
            const isObjectId = mongoose.Types.ObjectId.isValid(search);
            filter.$or = [
                { transactionId: { $regex: search, $options: 'i' } },
                { refId: { $regex: search, $options: 'i' } },
                { providerRef: { $regex: search, $options: 'i' } }
            ];
            if (isObjectId) filter.$or.push({ _id: search });
        }

        const transactions = await Transaction.find(filter)
            .sort({ createdAt: -1 })
            .populate('userId', 'name email phone')
            .skip(skip)
            .limit(limit);

        const total = await Transaction.countDocuments(filter);

        res.status(200).json({ 
            success: true, 
            data: {
                transactions,
                pagination: { 
                    total, 
                    pages: Math.ceil(total / limit),
                    page, 
                    limit
                }
            }
        });
    } catch (error) {
        console.error('Admin fetch transactions error:', error);
        res.status(500).json({ success: false, message: 'Error fetching transactions' });
    }
};

module.exports = {
    getUserTransactions,
    getUserTransaction,
    getFilteredTransactions,
    getAllUsers,
    getAllTransactions
}