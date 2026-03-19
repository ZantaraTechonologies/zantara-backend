const Transaction = require('../models/Transaction');
const Expense = require('../models/Expense');
const Settlement = require('../models/Settlement');
const Wallet = require('../models/Wallet');
const User = require('../models/User');

/**
 * GET /api/admin/business/overview
 * Returns backend-derived summary data
 */
exports.getOverview = async (req, res) => {
    try {
        const stats = await Transaction.aggregate([
            { $match: { status: 'success' } },
            {
                $group: {
                    _id: null,
                    totalRevenue: { $sum: "$amount" },
                    totalCost: { $sum: "$costPrice" },
                    totalProfit: { $sum: "$profit" }
                }
            }
        ]);

        const totalExpenses = await Expense.aggregate([
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);

        const summary = stats[0] || { totalRevenue: 0, totalCost: 0, totalProfit: 0 };
        const expenseTotal = totalExpenses[0]?.total || 0;

        res.json({
            success: true,
            data: {
                totalRevenue: summary.totalRevenue,
                totalCost: summary.totalCost,
                grossProfit: summary.totalProfit,
                totalExpenses: expenseTotal,
                netProfit: summary.totalProfit - expenseTotal,
                recentActivities: await Transaction.find({ status: 'success' }).sort({ createdAt: -1 }).limit(5)
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/admin/business/wallet
 */
exports.getBusinessWallet = async (req, res) => {
    try {
        // Simplified: using a dedicated 'admin' or 'system' wallet logic
        // For now, aggregate platform-wide balances
        const walletStats = await Wallet.aggregate([
            {
                $group: {
                    _id: null,
                    totalBalance: { $sum: "$balance" },
                    totalFrozen: { $sum: "$frozen" }
                }
            }
        ]);

        const stats = walletStats[0] || { totalBalance: 0, totalFrozen: 0 };

        res.json({
            success: true,
            data: {
                platformBalance: stats.totalBalance,
                reservedPayouts: stats.totalFrozen,
                escrowFlow: stats.totalFrozen * 0.4, // illustrative
                operatingBuffer: 500000 // typical threshold
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/admin/business/cost-ledger
 */
exports.getCostLedger = async (req, res) => {
    try {
        const { type, provider, startDate, endDate } = req.query;
        let filter = { status: 'success', type: { $in: ['airtime', 'data', 'tv', 'electricity', 'pin'] } };

        if (type) filter.type = type;
        if (provider) filter.provider = provider;
        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate) filter.createdAt.$gte = new Date(startDate);
            if (endDate) filter.createdAt.$lte = new Date(endDate);
        }

        const ledger = await Transaction.find(filter).sort({ createdAt: -1 }).limit(100);
        res.json({ success: true, data: ledger });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/admin/business/cash-flow
 */
exports.getCashFlow = async (req, res) => {
    try {
        // Implementation for cash flow ledger rows
        res.json({ success: true, data: {
            rows: await Transaction.find({ status: 'success' }).sort({ createdAt: -1 }).limit(20)
        }});
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/admin/business/refunds-losses
 */
exports.getRefundsLosses = async (req, res) => {
    try {
        const data = await Transaction.find({ 
            $or: [{ status: 'failed' }, { isLoss: true }] 
        }).sort({ createdAt: -1 }).limit(50);
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
