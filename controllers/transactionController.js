const Transaction = require('../models/Transaction')
const User = require('../models/User')

const getUserTransactions = async (req, res) => {
    const transactions = await Transaction.find({ userId: req.user.id }).sort({ timestamp: -1 })
    res.json(transactions)
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
        const users = await User.find().sort({ createdAt: -1 }).select('-password')
        res.status(200).json({ success: true, users })
    } catch (error) {
        console.error('Admin fetch users error:', error)
        res.status(500).json({ success: false, message: 'Error fetching users' })
    }
}

const getAllTransactions = async (req, res) => {
    try {
        const transactions = await Transaction.find()
            .sort({ createdAt: -1 })
            .populate('userId', 'name email')
        res.status(200).json({ success: true, transactions })
    } catch (error) {
        console.error('Admin fetch transactions error:', error)
        res.status(500).json({ success: false, message: 'Error fetching transactions' })
    }
}

module.exports = {
    getUserTransactions,
    getFilteredTransactions,
    getAllUsers,
    getAllTransactions
}