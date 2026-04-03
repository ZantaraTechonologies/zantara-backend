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
            // 6. User Doc for referralBalance and myReferralCode
            User.findById(userId).select('referralBalance myReferralCode')
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
                myReferralCode: userDoc ? userDoc.myReferralCode : null,
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

        const WalletLedger = require('../models/WalletLedger');

        // 1. Fetch relevant Transactions (Bonuses, Agent Profits, & Redemptions)
        const historyTxs = await Transaction.find({
            userId,
            status: 'success',
            $or: [
                { type: 'referral_bonus' },
                { type: 'referral_redeem' },
                { userRole: 'agent' }
            ]
        })
            .sort({ createdAt: -1 })
            .limit(200); // Fetch a reasonable chunk for merging

        // 2. Fetch relevant WalletLedger (Skipped Commissions)
        const skippedLogs = await WalletLedger.find({
            userId,
            source: 'REFERRAL_SKIPPED'
        })
            .sort({ createdAt: -1 })
            .limit(200);

        // 3. Format and Merge
        const formattedHistory = [
            ...historyTxs.map(t => ({
                id: t._id,
                type: t.type === 'referral_bonus' ? 'referral_bonus' : t.type === 'referral_redeem' ? 'referral_redeem' : 'agent_profit',
                amount: t.type === 'referral_bonus' ? (t.amount || 0) : t.type === 'referral_redeem' ? (t.amount || 0) : (t.profit || 0),
                refId: t.refId || t.transactionId,
                transactionId: t.transactionId,
                wasCapped: t.details ? t.details.wasCapped : false,
                buyerRole: t.userRole || (t.details ? t.details.buyerRole : 'user'),
                createdAt: t.createdAt,
                status: 'success'
            })),
            ...skippedLogs.map(l => ({
                id: l._id,
                type: 'referral_skipped',
                amount: 0,
                refId: l.reference,
                transactionId: l.metadata ? l.metadata.parentTxnId : l.reference,
                wasCapped: false,
                buyerRole: l.metadata ? l.metadata.buyerRole : 'user',
                createdAt: l.createdAt,
                status: 'skipped',
                metadata: l.metadata
            }))
        ];

        // 4. Final Sort and Paginate
        formattedHistory.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const total = formattedHistory.length;
        const paginatedHistory = formattedHistory.slice(skip, skip + Number(limit));

        res.json({
            success: true,
            data: paginatedHistory,
            pagination: {
                total,
                page: Number(page),
                pages: Math.ceil(total / Number(limit))
            }
        });
    } catch (err) {
        console.error('Earnings history error:', err);
        res.status(500).json({ message: 'Failed to fetch earnings history' });
    }
};

const getAdminEarningsAnalytics = async (req, res) => {
    try {
        const WalletLedger = require('../models/WalletLedger');
        const Setting = require('../models/Setting');

        const [
            payoutStats,
            agentStats,
            cappedCount,
            skippedCount,
            topReferrers,
            topAgents,
            caps
        ] = await Promise.all([
            // 1. Total Referral Payouts
            Transaction.aggregate([
                { $match: { type: 'referral_bonus', status: 'success' } },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ]),
            // 2. Total Agent Profits Generated
            Transaction.aggregate([
                { $match: { userRole: 'agent', status: 'success' } },
                { $group: { _id: null, total: { $sum: "$profit" } } }
            ]),
            // 3. Capped Commissions Count
            Transaction.countDocuments({ type: 'referral_bonus', "details.wasCapped": true }),
            // 4. Skipped Commissions Count
            WalletLedger.countDocuments({ source: 'REFERRAL_SKIPPED' }),
            // 5. Top 10 Referrers
            Transaction.aggregate([
                { $match: { type: 'referral_bonus', status: 'success' } },
                { $group: { _id: "$userId", totalEarned: { $sum: "$amount" }, count: { $sum: 1 } } },
                { $sort: { totalEarned: -1 } },
                { $limit: 10 },
                {
                    $lookup: {
                        from: 'users',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'user'
                    }
                },
                { $unwind: "$user" },
                {
                    $project: {
                        name: "$user.name",
                        email: "$user.email",
                        totalEarned: 1,
                        count: 1
                    }
                }
            ]),
            // 6. Top 10 Agents
            Transaction.aggregate([
                { $match: { userRole: 'agent', status: 'success' } },
                { $group: { _id: "$userId", totalProfit: { $sum: "$profit" }, count: { $sum: 1 } } },
                { $sort: { totalProfit: -1 } },
                { $limit: 10 },
                {
                    $lookup: {
                        from: 'users',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'user'
                    }
                },
                { $unwind: "$user" },
                {
                    $project: {
                        name: "$user.name",
                        email: "$user.email",
                        totalProfit: 1,
                        count: 1
                    }
                }
            ]),
            // 7. Get Caps Settings
            Promise.all([
                Setting.findOne({ key: 'maxReferralProfitShare' }),
                Setting.findOne({ key: 'maxAgentReferralShare' })
            ])
        ]);

        // 8. Recent Global Earnings History
        const historyTxs = await Transaction.find({
            status: 'success',
            $or: [
                { type: 'referral_bonus' },
                { type: 'referral_redeem' },
                { userRole: 'agent' }
            ]
        })
            .sort({ createdAt: -1 })
            .limit(50)
            .populate('userId', 'name email');

        const skippedLogs = await WalletLedger.find({
            source: 'REFERRAL_SKIPPED'
        })
            .sort({ createdAt: -1 })
            .limit(50)
            .populate('userId', 'name email');

        const formattedHistory = [
            ...historyTxs.map(t => ({
                id: t._id,
                userName: t.userId ? t.userId.name : 'Unknown User',
                userEmail: t.userId ? t.userId.email : '',
                type: t.type === 'referral_bonus' ? 'referral_bonus' : t.type === 'referral_redeem' ? 'referral_redeem' : 'agent_profit',
                amount: t.type === 'referral_bonus' ? (t.amount || 0) : t.type === 'referral_redeem' ? (t.amount || 0) : (t.profit || 0),
                refId: t.refId || t.transactionId,
                wasCapped: t.details?.wasCapped || false,
                buyerRole: t.userRole || t.details?.buyerRole || 'user',
                createdAt: t.createdAt,
                status: 'success'
            })),
            ...skippedLogs.map(l => ({
                id: l._id,
                userName: l.userId ? l.userId.name : 'Unknown User',
                userEmail: l.userId ? l.userId.email : '',
                type: 'referral_skipped',
                amount: 0,
                refId: l.reference,
                wasCapped: false,
                buyerRole: l.metadata?.buyerRole || 'user',
                createdAt: l.createdAt,
                status: 'skipped'
            }))
        ];

        formattedHistory.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json({
            success: true,
            data: {
                overview: {
                    totalReferralPayouts: payoutStats[0]?.total || 0,
                    totalAgentProfits: agentStats[0]?.total || 0,
                    cappedCommissionsCount: cappedCount,
                    skippedCommissionsCount: skippedCount
                },
                performers: {
                    topReferrers,
                    topAgents
                },
                caps: {
                    maxReferralProfitShare: caps[0] ? Number(caps[0].value) : 0.9,
                    maxAgentReferralShare: caps[1] ? Number(caps[1].value) : 0.5
                },
                history: formattedHistory.slice(0, 50)
            }
        });

    } catch (err) {
        console.error('Admin earnings analytics error:', err);
        res.status(500).json({ message: 'Failed to fetch admin earnings analytics' });
    }
};

const getDashboardStats = async (req, res) => {
    try {
        const Kyc = require('../models/Kyc');
        const WithdrawalRequest = require('../models/WithdrawalRequest');
        const Ticket = require('../models/Ticket');

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        sevenDaysAgo.setHours(0, 0, 0, 0);

        const [
            totalUsers,
            activeUsersSet,
            pendingKyc,
            pendingWithdrawals,
            withdrawalVolumeStats,
            failedTxsToday,
            openTickets,
            recentTxs,
            transactionTrendStats
        ] = await Promise.all([
            User.countDocuments(),
            Transaction.distinct('userId', { status: 'success' }),
            Kyc.find({ status: 'pending' }).populate('userId', 'name phone'),
            WithdrawalRequest.find({ status: 'pending' }).populate('userId', 'name phone'),
            WithdrawalRequest.aggregate([
                { $match: { status: 'pending' } },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ]),
            Transaction.countDocuments({ status: 'failed', createdAt: { $gte: todayStart } }),
            Ticket.countDocuments({ status: { $in: ['open', 'in-progress'] } }),
            Transaction.find().sort({ createdAt: -1 }).limit(10).populate('userId', 'name email phone'),
            Transaction.aggregate([
                { $match: { createdAt: { $gte: sevenDaysAgo }, status: 'success' } },
                {
                    $group: {
                        _id: { $dateToString: { format: "%m-%d", date: "$createdAt" } },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { "_id": 1 } }
            ])
        ]);

        const transactionTrend = transactionTrendStats.map(t => ({
            label: t._id,
            value: t.count
        }));

        const criticalAlerts = [
            ...pendingKyc.map(k => ({
                event: 'Identity Verification',
                entity: k.userId?.name || k.userId?.phone || 'Unknown User',
                time: k.createdAt,
                status: 'Action Required',
                statusColor: 'bg-orange-500/10 text-orange-500',
                link: '/admin/kyc'
            })),
            ...pendingWithdrawals.map(w => ({
                event: 'Withdrawal Request',
                entity: `${w.userId?.name || 'User'} (₦${w.amount.toLocaleString()})`,
                time: w.createdAt,
                status: 'High Risk',
                statusColor: 'bg-red-500/10 text-red-500',
                link: '/admin/withdrawals'
            }))
        ];

        const recentActivity = recentTxs.map(t => ({
            event: `${t.type.toUpperCase()} - ${t.status}`,
            detail: `${t.userId?.name || t.userId?.phone || 'User'} processed ${t.type} of ₦${t.amount.toLocaleString()}`,
            time: t.createdAt,
            type: t.status === 'success' ? 'kyc' : t.status === 'failed' ? 'error' : 'system'
        }));

        res.json({
            success: true,
            data: {
                totalUsers,
                activeUsers: activeUsersSet.length,
                pendingKyc: pendingKyc.length,
                pendingWithdrawals: pendingWithdrawals.length,
                withdrawalVolume: withdrawalVolumeStats[0]?.total || 0,
                failedTxsToday,
                openTickets,
                criticalAlerts,
                recentActivity,
                transactionTrend,
                userGrowth: '+5%',
                activityRate: `${Math.round((activeUsersSet.length / (totalUsers || 1)) * 100)}%`
            }
        });
    } catch (err) {
        console.error('Dashboard stats error:', err);
        res.status(500).json({ message: 'Failed to fetch dashboard statistics' });
    }
};

module.exports = {
    getDailyTransactions,
    revenuePerDay,
    topUsedServices,
    dailyUserRegistrations,
    getUserEarningsSummary,
    getUserEarningsHistory,
    getAdminEarningsAnalytics,
    getDashboardStats
}
