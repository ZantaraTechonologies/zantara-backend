const User = require('../models/User');
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
        const users = await User.find().select('-password').sort({ createdAt: -1 });
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
        if (role) {
            const ALLOWED_ROLES = User.ALLOWED_ROLES;
            if (!ALLOWED_ROLES.includes(role)) {
                return res.status(400).json({ message: 'Invalid role' });
            }
            update.role = role;
        }
        if (status !== undefined) update.status = status;

        const user = await User.findByIdAndUpdate(id, update, { new: true });
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

// --- Commission Settings (Step 2) ---

const getCommissionSettings = async (req, res) => {
    try {
        const Setting = require('../models/Setting');
        const setting = await Setting.findOne({ key: 'defaultCommissionRate' });
        res.json({ success: true, defaultCommissionRate: setting ? setting.value : 0.01 });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

const updateCommissionSettings = async (req, res) => {
    try {
        const { defaultCommissionRate } = req.body;
        const rate = Number(defaultCommissionRate);

        if (isNaN(rate) || rate < 0 || rate > 0.1) {
            return res.status(400).json({ message: 'Invalid rate. Must be between 0 and 0.1 (0% - 10%)' });
        }

        const Setting = require('../models/Setting');
        await Setting.findOneAndUpdate(
            { key: 'defaultCommissionRate' },
            { key: 'defaultCommissionRate', value: rate },
            { upsert: true, new: true }
        );
        res.json({ success: true, message: 'Global commission rate updated successfully', defaultCommissionRate: rate });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

const updateUserCommissionRate = async (req, res) => {
    try {
        const { id } = req.params;
        const { commissionRate } = req.body;

        // Validation
        if (commissionRate !== null && commissionRate !== undefined) {
            const rate = Number(commissionRate);
            if (isNaN(rate) || rate < 0 || rate > 0.1) {
                return res.status(400).json({ message: 'Invalid rate. Must be between 0 and 0.1 (0% - 10%)' });
            }
        }

        const User = require('../models/User');
        const user = await User.findByIdAndUpdate(id, { commissionRate }, { new: true });
        
        if (!user) return res.status(404).json({ message: 'User not found' });

        res.json({ success: true, message: 'User commission override updated successfully', commissionRate: user.commissionRate });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

// --- Agent Settings (Step 3) ---

const getAgentSettings = async (req, res) => {
    try {
        const Setting = require('../models/Setting');
        const setting = await Setting.findOne({ key: 'defaultAgentDiscountRate' });
        res.json({ success: true, defaultAgentDiscountRate: setting ? setting.value : 0 });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

const updateAgentSettings = async (req, res) => {
    try {
        const { defaultAgentDiscountRate } = req.body;
        const rate = Number(defaultAgentDiscountRate);

        if (isNaN(rate) || rate < 0 || rate > 0.5) {
            return res.status(400).json({ message: 'Invalid rate. Must be between 0 and 0.5 (0% - 50%)' });
        }

        const Setting = require('../models/Setting');
        await Setting.findOneAndUpdate(
            { key: 'defaultAgentDiscountRate' },
            { key: 'defaultAgentDiscountRate', value: rate },
            { upsert: true, new: true }
        );
        res.json({ success: true, message: 'Global agent discount rate updated successfully', defaultAgentDiscountRate: rate });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

const updateUserAgentDiscount = async (req, res) => {
    try {
        const { id } = req.params;
        const { agentDiscountRate } = req.body;

        // Validation
        if (agentDiscountRate !== null && agentDiscountRate !== undefined) {
            const rate = Number(agentDiscountRate);
            if (isNaN(rate) || rate < 0 || rate > 0.5) {
                return res.status(400).json({ message: 'Invalid rate. Must be between 0 and 0.5 (0% - 50%)' });
            }
        }

        const User = require('../models/User');
        const user = await User.findByIdAndUpdate(id, { agentDiscountRate }, { new: true });
        
        if (!user) return res.status(404).json({ message: 'User not found' });

        res.json({ success: true, message: 'User agent discount override updated successfully', agentDiscountRate: user.agentDiscountRate });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

// --- Commission Profit-Share Caps (Step 5) ---
const getCommissionCaps = async (req, res) => {
    try {
        const Setting = require('../models/Setting');
        const [standardCap, agentCap] = await Promise.all([
            Setting.findOne({ key: 'maxReferralProfitShare' }),
            Setting.findOne({ key: 'maxAgentReferralShare' })
        ]);

        res.json({
            success: true,
            maxReferralProfitShare: standardCap ? Number(standardCap.value) : 0.9,
            maxAgentReferralShare: agentCap ? Number(agentCap.value) : 0.5
        });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

const updateCommissionCaps = async (req, res) => {
    try {
        const { maxReferralProfitShare, maxAgentReferralShare } = req.body;
        const sCap = Number(maxReferralProfitShare);
        const aCap = Number(maxAgentReferralShare);

        // Validation for Standard User Cap
        if (maxReferralProfitShare !== undefined) {
            if (isNaN(sCap) || sCap < 0 || sCap > 1) {
                return res.status(400).json({ message: 'Invalid maxReferralProfitShare. Must be between 0 and 1.' });
            }
        }

        // Validation for Agent Cap
        if (maxAgentReferralShare !== undefined) {
            if (isNaN(aCap) || aCap < 0 || aCap > 1) {
                return res.status(400).json({ message: 'Invalid maxAgentReferralShare. Must be between 0 and 1.' });
            }
        }

        const Setting = require('../models/Setting');
        const updatePromises = [];
        if (maxReferralProfitShare !== undefined) {
            updatePromises.push(Setting.findOneAndUpdate(
                { key: 'maxReferralProfitShare' },
                { key: 'maxReferralProfitShare', value: sCap },
                { upsert: true, new: true }
            ));
        }
        if (maxAgentReferralShare !== undefined) {
            updatePromises.push(Setting.findOneAndUpdate(
                { key: 'maxAgentReferralShare' },
                { key: 'maxAgentReferralShare', value: aCap },
                { upsert: true, new: true }
            ));
        }

        await Promise.all(updatePromises);
        res.json({ success: true, message: 'Commission profit-share caps updated successfully' });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

module.exports = {
    getFilteredTransactions,
    getAllUsers,
    updateUserRole,
    getSettings,
    updateSetting,
    getCommissionSettings,
    updateCommissionSettings,
    updateUserCommissionRate,
    getAgentSettings,
    updateAgentSettings,
    updateUserAgentDiscount,
    getCommissionCaps,
    updateCommissionCaps
}