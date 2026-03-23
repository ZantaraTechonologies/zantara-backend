const mongoose = require('mongoose')
const Transaction = require('../models/Transaction')
const User = require('../models/User')

const getDailyTransactions = async (req, res) => {
    try {
        const result = await Transaction.aggregate([
            { $match: { status: 'success' } },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                    count: { $sum: 1 },
                    revenue: { $sum: "$amount" }
                }
            },
            { $sort: { _id: 1 } }
        ])

        res.json(result)
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Analytics failed' });
    }
}

const revenuePerDay = async (req, res) => {
    try {
        const result = await Transaction.aggregate([
            { $match: { status: 'success' } },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                    totalAmount: { $sum: "$amount" }
                }
            },
            { $sort: { _id: 1 } }
        ])

        res.json(result)
    } catch (err) {
        console.log(err)
        res.status(500).json({ error: 'Analytics failed' })
    }
}

const topUsedServices = async (req, res) => {
    try {
        const result = await Transaction.aggregate([
            { $match: { status: 'success' } },
            { $group: { _id: "$type", total: { $sum: 1 } } },
            { $sort: { total: -1 } }
        ])

        res.json(result)
    } catch (err) {
        console.log(err)
        res.status(500).json({ error: 'Analytics failed' })
    }
}

const dailyUserRegistrations = async (req, res) => {
    try {
        const result = await User.aggregate([
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } }
        ])

        res.json(result)
    } catch (err) {
        console.log(err)
        res.status(500).json({ error: 'Analytics failed' })
    }
}
 
// --- User Earnings (Step 6) ---

const getUserEarningsSummary = async (req, res) => {
    try {
        const userId = req.user.id;
        const WalletLedger = require('../models/WalletLedger');

        const [referralStats, agentStats, cappedCount, skippedCount, totalReferrals, userDoc] = await Promise.all([
            // 1. Referral Commissions
            Transaction.aggregate([
                { $match: { userId: new mongoose.Types.ObjectId(userId), type: 'referral_bonus', status: 'success' } },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ]),
            // 2. Agent Sales Profit
            Transaction.aggregate([
                { $match: { userId: new mongoose.Types.ObjectId(userId), userRole: 'agent', status: 'success' } },
                { $group: { _id: null, total: { $sum: "$profit" } } }
            ]),
            // 3. Capped Commissions Count
            Transaction.countDocuments({ userId, type: 'referral_bonus', "details.wasCapped": true }),
            // 4. Skipped Commissions Count
            WalletLedger.countDocuments({ userId, source: 'REFERRAL_SKIPPED' }),
            // 5. Total Referrals Count
            User.countDocuments({ referredBy: userId }),
            // 6. User Doc for referralBalance
            User.findById(userId).select('referralBalance')
        ]);

        const referralEarnings = referralStats.length > 0 ? referralStats[0].total : 0;
        const agentProfit = agentStats.length > 0 ? agentStats[0].total : 0;

        res.json({
            success: true,
            data: {
                referralEarnings,
                agentProfit,
                totalEarnings: referralEarnings + agentProfit,
                totalReferrals,
                referralBalance: userDoc ? userDoc.referralBalance : 0,
                cappedCommissionsCount: cappedCount,
                skippedCommissionsCount: skippedCount
            }
        });
    } catch (err) {
        console.error('Earnings summary error:', err);
        res.status(500).json({ message: 'Failed to fetch earnings summary' });
    }
};

const getUserEarningsHistory = async (req, res) => {
    try {
        const userId = req.user.id;
        const { page = 1, limit = 20 } = req.query;
        const skip = (page - 1) * limit;

        // Find all records that contribute to earnings: 
        // referral_bonus OR successful professional agent purchases (where userRole='agent')
        const history = await Transaction.find({
            userId,
            status: 'success',
            $or: [
                { type: 'referral_bonus' },
                { userRole: 'agent' }
            ]
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit));

        const total = await Transaction.countDocuments({
            userId,
            status: 'success',
            $or: [
                { type: 'referral_bonus' },
                { userRole: 'agent' }
            ]
        });

        const formattedHistory = history.map(t => ({
            type: t.type === 'referral_bonus' ? 'referral' : 'agent_resale',
            amount: t.type === 'referral_bonus' ? t.amount : (t.profit || 0),
            transactionId: t.transactionId,
            wasCapped: t.details ? t.details.wasCapped : false,
            buyerRole: t.userRole || 'user',
            createdAt: t.createdAt
        }));

        res.json({
            success: true,
            data: formattedHistory,
            pagination: {
                total,
                page: Number(page),
                pages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        console.error('Earnings history error:', err);
        res.status(500).json({ message: 'Failed to fetch earnings history' });
    }
};

module.exports = {
    getDailyTransactions,
    revenuePerDay,
    topUsedServices,
    dailyUserRegistrations,
    getUserEarningsSummary,
    getUserEarningsHistory
}