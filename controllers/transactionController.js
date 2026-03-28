const Transaction = require('../models/Transaction')
const User = require('../models/User')

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
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        const transactions = await Transaction.find()
            .sort({ createdAt: -1 })
            .populate('userId', 'name email')
            .skip(skip)
            .limit(limit);

        const total = await Transaction.countDocuments();

        res.status(200).json({ 
            success: true, 
            data: transactions,
            pagination: { total, page, limit, pages: Math.ceil(total / limit) }
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