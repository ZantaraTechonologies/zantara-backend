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
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        const search = req.query.search || '';

        const matchQuery = {};
        if (search) {
            matchQuery.$or = [
                { name: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } }
            ];
        }

        const users = await User.aggregate([
            { $match: matchQuery },
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: limit },
            {
                $lookup: {
                    from: 'wallets',
                    localField: '_id',
                    foreignField: 'userId',
                    as: 'wallet'
                }
            },
            {
                $addFields: {
                    balance: { $ifNull: [{ $arrayElemAt: ['$wallet.balance', 0] }, 0] }
                }
            },
            { $project: { password: 0, wallet: 0 } }
        ]);

        const totalUsers = await User.countDocuments(matchQuery);

        res.json({ 
            success: true, 
            data: {
                users,
                pagination: {
                    totalUsers,
                    totalPages: Math.ceil(totalUsers / limit),
                    currentPage: page
                }
            } 
        });
    } catch (e) {
        console.error('GetAllUsers error:', e);
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

        const oldUser = await User.findById(id);
        if (!oldUser) return res.status(404).json({ message: 'User not found' });

        const user = await User.findByIdAndUpdate(id, update, { new: true });

        // Logging & Notification
        const { logAction } = require('./auditController');
        const { notifySuperAdmins } = require('../services/notificationService');

        if (status === false && oldUser.status !== false) {
            // User was blocked
            await logAction(req.user.id, req.user.name, 'USER_BLOCK', `User: ${user.name} (${user.phone})`, { userId: id }, 'success', req);
            await notifySuperAdmins(
                `🚨 User Blocked: ${user.name}`,
                `<p>Admin <b>${req.user.name}</b> blocked user <b>${user.name}</b> (${user.phone}) at ${new Date().toLocaleString()}.</p>`
            );
        } else if (status === true && oldUser.status === false) {
             await logAction(req.user.id, req.user.name, 'USER_UNBLOCK', `User: ${user.name} (${user.phone})`, { userId: id }, 'success', req);
        }

        if (role && role !== oldUser.role) {
            await logAction(req.user.id, req.user.name, 'ROLE_CHANGE', `User: ${user.name} (${user.phone})`, { oldRole: oldUser.role, newRole: role }, 'success', req);
        }

        res.json({ success: true, data: user });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

const getSettings = async (req, res) => {
    try {
        const settings = await require('../models/Setting').find();
        
        // Define all known setting keys with their default values
        const defaults = {
            maintenanceMode: false,
            minWithdrawal: 1000,
            referralRate: 5,
            primaryGateway: 'vtpass',
            gatewayTimeout: 30000,
            // Investment Defaults
            investmentEnabled: true,
            sharePrice: 10000,
            maxSharesPerUser: 20,
            totalSharesAvailable: 200,
            investorAllocationPercent: 20,
            minSharesPerPurchase: 1,
            dividendWithdrawalFee: 1.5,
            dividendReinvestFee: 0,
            dividendRedeemFee: 0,
            shareLockPeriodMonths: 6,
            shareExitFee: 5,
            maxMonthlyExitPercent: 10
        };

        const settingsMap = { ...defaults };
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
        const { logAction } = require('./auditController');
        await logAction(req.user.id, req.user.name, 'SETTING_UPDATE', `Key: ${key}`, { value }, 'success', req);

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
        const { logAction } = require('./auditController');
        await logAction(req.user.id, req.user.name, 'COMMISSION_SETTING_UPDATE', 'Global Rate', { defaultCommissionRate: rate }, 'success', req);

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

        const { logAction } = require('./auditController');
        await logAction(req.user.id, req.user.name, 'USER_COMMISSION_OVERRIDE', `User: ${user.name}`, { commissionRate: user.commissionRate }, 'success', req);

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
        const { logAction } = require('./auditController');
        await logAction(req.user.id, req.user.name, 'AGENT_DISCOUNT_SETTING_UPDATE', 'Global Rate', { defaultAgentDiscountRate: rate }, 'success', req);

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

        const { logAction } = require('./auditController');
        await logAction(req.user.id, req.user.name, 'USER_AGENT_DISCOUNT_OVERRIDE', `User: ${user.name}`, { agentDiscountRate: user.agentDiscountRate }, 'success', req);

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
        // Support both Frontend styles for robustness
        const maxReferralProfitShare = req.body.maxReferralProfitShare ?? req.body.referralCommissionProfitCap;
        const maxAgentReferralShare = req.body.maxAgentReferralShare ?? req.body.agentDiscountProfitCap;

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

        const { logAction } = require('./auditController');
        await logAction(req.user.id, req.user.name, 'COMMISSION_CAPS_UPDATE', 'System Caps', { maxReferralProfitShare, maxAgentReferralShare }, 'success', req);

        res.json({ success: true, message: 'Commission profit-share caps updated successfully' });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

const getUserById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid User ID' });
        }

        const user = await User.findById(id).select('-password');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const Wallet = require('../models/Wallet');
        const Transaction = require('../models/Transaction');
        
        const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

        const [wallet, transactions, monthlyStats] = await Promise.all([
            Wallet.findOne({ userId: id }),
            Transaction.find({ userId: id }).sort({ createdAt: -1 }).limit(10),
            Transaction.aggregate([
                { 
                    $match: { 
                        userId: new mongoose.Types.ObjectId(id), 
                        status: 'success',
                        type: { $in: ['airtime', 'data', 'tv', 'cable', 'electricity', 'pin', 'withdrawal', 'expense'] },
                        createdAt: { $gte: startOfMonth }
                    } 
                },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ])
        ]);

        const userData = user.toObject();
        userData.balance = wallet ? wallet.balance : 0;
        userData.transactions = transactions;
        userData.stats = {
            monthlyVolume: monthlyStats[0]?.total || 0
        };

        res.json({ success: true, data: userData });
    } catch (e) {
        console.error('GetUserById error:', e);
        res.status(500).json({ message: e.message });
    }
};

// --- Admin Manual Wallet Adjustments ---

const adminCreditWallet = async (req, res) => {
    try {
        const { userId } = req.params;
        const { amount, reason } = req.body;

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ message: 'Invalid User ID' });
        }
        const amountNum = Number(amount);
        if (!amountNum || amountNum <= 0) {
            return res.status(400).json({ message: 'Amount must be a positive number' });
        }
        if (!reason || !reason.trim()) {
            return res.status(400).json({ message: 'Reason is required for audit purposes' });
        }

        const targetUser = await User.findById(userId);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });

        const walletService = require('../services/wallet.service');
        const { logAction } = require('./auditController');

        const refId = 'ADM-CR-' + Date.now();
        const result = await walletService.credit(userId, amountNum, refId, 'admin_manual_credit');

        await logAction(
            req.user.id,
            req.user.name || 'Admin',
            'ADMIN_WALLET_CREDIT',
            `User: ${targetUser.name} (${targetUser.phone})`,
            { amount: amountNum, reason, refId, newBalance: result.balance }
        );

        res.json({
            success: true,
            message: `₦${amountNum.toLocaleString()} credited to ${targetUser.name}'s wallet`,
            newBalance: result.balance,
            refId
        });
    } catch (e) {
        console.error('Admin credit wallet error:', e);
        res.status(500).json({ message: e.message });
    }
};

const adminDebitWallet = async (req, res) => {
    try {
        const { userId } = req.params;
        const { amount, reason } = req.body;

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ message: 'Invalid User ID' });
        }
        const amountNum = Number(amount);
        if (!amountNum || amountNum <= 0) {
            return res.status(400).json({ message: 'Amount must be a positive number' });
        }
        if (!reason || !reason.trim()) {
            return res.status(400).json({ message: 'Reason is required for audit purposes' });
        }

        const targetUser = await User.findById(userId);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });

        const walletService = require('../services/wallet.service');
        const { logAction } = require('./auditController');

        const refId = 'ADM-DB-' + Date.now();
        const result = await walletService.debit(userId, amountNum, refId, 'admin_manual_debit');

        await logAction(
            req.user.id,
            req.user.name || 'Admin',
            'ADMIN_WALLET_DEBIT',
            `User: ${targetUser.name} (${targetUser.phone})`,
            { amount: amountNum, reason, refId, newBalance: result.balance }
        );

        res.json({
            success: true,
            message: `₦${amountNum.toLocaleString()} debited from ${targetUser.name}'s wallet`,
            newBalance: result.balance,
            refId
        });
    } catch (e) {
        console.error('Admin debit wallet error:', e);
        res.status(500).json({ message: e.message });
    }
};

const exportUsersCSV = async (req, res) => {
    try {
        const users = await User.find().lean();
        const wallets = await Wallet.find().lean();
        
        // Map wallet balance to user for the export
        const walletMap = wallets.reduce((acc, w) => {
            acc[w.userId.toString()] = w.balance;
            return acc;
        }, {});

        let csv = 'ID,Name,Email,Phone,Role,Balance,Status,Joined\n';
        
        users.forEach(u => {
            const balance = walletMap[u._id.toString()] || 0;
            const row = [
                u._id,
                `"${u.name}"`,
                u.email || 'N/A',
                u.phone || 'N/A',
                u.role,
                balance,
                u.status ? 'Active' : 'Inactive',
                new Date(u.createdAt).toLocaleDateString()
            ].join(',');
            csv += row + '\n';
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=users_export.csv');
        res.status(200).send(csv);
    } catch (e) {
        console.error('Export CSV error:', e);
        res.status(500).send('Error generating export');
    }
};

module.exports = {
    getFilteredTransactions,
    getAllUsers,
    getUserById,
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
    updateCommissionCaps,
    adminCreditWallet,
    adminDebitWallet,
    exportUsersCSV
}