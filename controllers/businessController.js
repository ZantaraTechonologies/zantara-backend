const Transaction = require('../models/Transaction');
const Expense = require('../models/Expense');
const Settlement = require('../models/Settlement');
const Wallet = require('../models/Wallet');
const User = require('../models/User');
const vtpassAdapter = require('../adapters/vtpass.adapter');
const paystack = require('../utils/paystack');

/**
 * GET /api/admin/business/overview
 * Returns backend-derived summary data
 */
/**
 * GET /api/admin/business/overview
 * Returns backend-derived summary data with date filtering
 */
/**
 * GET /api/admin/business/overview
 * Returns backend-derived summary data with refined financial logic
 */
exports.getOverview = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        
        // 1. Setup Date Range
        const now = new Date();
        const start = startDate ? new Date(startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
        const end = endDate ? new Date(endDate) : new Date();
        if (endDate) end.setHours(23, 59, 59, 999);

        const dateFilter = { createdAt: { $gte: start, $lte: end } };
        
        // Operational services ONLY (excludes shares, funding, etc.)
        const operationalTypes = ['airtime', 'data', 'tv', 'cable', 'electricity', 'pin'];

        // 2. Aggregate Operational Stats (VTU Sales)
        const stats = await Transaction.aggregate([
            { $match: { 
                status: 'success', 
                type: { $in: operationalTypes },
                ...dateFilter 
            } },
            {
                $group: {
                    _id: null,
                    totalRevenue: { $sum: "$amount" },
                    totalProviderCost: { $sum: "$costPrice" },
                    totalDiscounts: { $sum: { $subtract: ["$salePrice", "$amount"] } },
                    totalCommissions: { $sum: { $subtract: ["$profit", "$netProfitAfterCommission"] } }
                }
            }
        ]);

        // 3. Aggregate Investment Inflow (Shares)
        const investmentStats = await Transaction.aggregate([
            { $match: { 
                status: 'success', 
                type: 'share_purchase',
                ...dateFilter 
            } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);

        // 4. Aggregate Operational Expenses (Excludes API Provider costs)
        const operationalExpenses = await Expense.aggregate([
            { $match: { 
                createdAt: { $gte: start, $lte: end },
                category: { $ne: 'API_COST' } 
            } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);

        const summary = stats[0] || { totalRevenue: 0, totalProviderCost: 0, totalDiscounts: 0, totalCommissions: 0 };
        const investmentInflow = investmentStats[0]?.total || 0;
        const overheadTotal = operationalExpenses[0]?.total || 0;

        // Derived Logic
        // Cost of Sales = Provider Costs + Referral Commissions
        const costOfSales = summary.totalProviderCost + summary.totalCommissions;
        
        // Gross Profit = Revenue - Cost of Sales (This is exactly what the platform keeps after all fulfillment costs)
        const grossProfit = summary.totalRevenue - costOfSales;
        
        // Net Performance = Gross Profit - Operational Overhead
        const netProfit = grossProfit - overheadTotal;
        
        const margin = summary.totalRevenue > 0 ? (grossProfit / summary.totalRevenue) * 100 : 0;

        // 5. Unified Flow (Last 30 activities)
        const [recentTxns, recentExpenses, recentSettlements] = await Promise.all([
            Transaction.find({ status: 'success', ...dateFilter }).sort({ createdAt: -1 }).limit(20).lean(),
            Expense.find({ ...dateFilter }).sort({ createdAt: -1 }).limit(10).lean(),
            Settlement.find({ ...dateFilter }).sort({ createdAt: -1 }).limit(10).lean()
        ]);

        const unifiedFlow = [
            ...recentTxns.map(t => ({ ...t, flowType: 'transaction', date: t.createdAt })),
            ...recentExpenses.map(e => ({ ...e, flowType: 'expense', date: e.createdAt, type: 'expense' })),
            ...recentSettlements.map(s => ({ ...s, flowType: 'settlement', date: s.createdAt, type: 'settlement' }))
        ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 30);

        res.json({
            success: true,
            data: {
                totalRevenue: summary.totalRevenue,
                totalCost: costOfSales,
                grossProfit,
                totalExpenses: overheadTotal,
                netProfit,
                operatingMargin: margin,
                investmentInflow,
                agentDiscounts: summary.totalDiscounts,
                referralCommissions: summary.totalCommissions,
                unifiedFlow,
                period: { start, end }
            }
        });
    } catch (error) {
        console.error('Overview error:', error);
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

        // 3. API Vendor Balance
        const apiBalance = await vtpassAdapter.getBalance();

        // 4. Paystack Gateway Balance
        const paystackBalance = await paystack.getPaystackBalance();

        res.json({
            success: true,
            data: {
                platformBalance: stats.totalBalance,
                reservedPayouts: stats.totalFrozen,
                apiVendorBalance: apiBalance.balance,
                apiVendorStatus: apiBalance.success ? 'online' : 'error',
                gatewayBalance: paystackBalance.balance,
                gatewayStatus: paystackBalance.success ? 'online' : 'error',
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
        let filter = { status: 'success', type: { $in: ['airtime', 'data', 'tv', 'electricity', 'pin', 'dividend_credit'] } };

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

/**
 * GET /api/admin/business/profit
 * Detailed profit margin & performance analytics
 */
exports.getProfitAnalytics = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        let dateFilter = {};
        
        if (startDate || endDate) {
            dateFilter.createdAt = {};
            if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                dateFilter.createdAt.$lte = end;
            }
        }

        const matchStage = { 
            $match: { 
                status: 'success', 
                type: { $in: ['airtime', 'data', 'tv', 'cable', 'electricity', 'pin'] },
                ...dateFilter
            }
        };

        const stats = await Transaction.aggregate([
            matchStage,
            {
                $group: {
                    _id: null,
                    totalRevenue: { $sum: "$amount" },
                    totalCost: { $sum: "$costPrice" },
                    grossProfit: { $sum: "$profit" },
                    netProfit: { $sum: "$netProfitAfterCommission" }
                }
            }
        ]);

        const breakdown = await Transaction.aggregate([
            matchStage,
            {
                $group: {
                    _id: "$type",
                    revenue: { $sum: "$amount" },
                    profit: { $sum: "$profit" },
                    count: { $sum: 1 }
                }
            },
            { $sort: { profit: -1 } }
        ]);

        const summary = stats[0] || { totalRevenue: 0, totalCost: 0, grossProfit: 0, netProfit: 0 };

        res.json({
            success: true,
            data: {
                totalRevenue: summary.totalRevenue,
                totalCost: summary.totalCost,
                grossProfit: summary.grossProfit,
                netProfit: summary.netProfit,
                marginPercentage: summary.totalRevenue > 0 ? (summary.grossProfit / summary.totalRevenue) * 100 : 0,
                breakdown
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
