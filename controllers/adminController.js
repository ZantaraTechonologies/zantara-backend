const Transaction = require('../models/Transaction')
const mongoose = require('mongoose')

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
        const users = await require('../models/User').find().select('-password').sort({ createdAt: -1 });
        res.json({ success: true, data: users });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

const updateUserRole = async (req, res) => {
    try {
        const { id } = req.params;
        const { role, status } = req.body; // status for block/unblock

        const update = {};
        if (role) update.role = role;
        if (status !== undefined) update.status = status;

        const user = await require('../models/User').findByIdAndUpdate(id, update, { new: true });
        res.json({ success: true, data: user });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

const getSettings = async (req, res) => {
    try {
        const settings = await require('../models/Setting').find();
        // Convert array to object for frontend convenience
        const settingsMap = {};
        settings.forEach(s => settingsMap[s.key] = s.value);
        res.json({ success: true, data: settingsMap });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

const updateSetting = async (req, res) => {
    try {
        const { key, value } = req.body;
        await require('../models/Setting').findOneAndUpdate(
            { key },
            { key, value },
            { upsert: true, new: true }
        );
        res.json({ success: true, message: 'Setting updated' });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

module.exports = {
    getFilteredTransactions,
    getAllUsers,
    updateUserRole,
    getSettings,
    updateSetting
}