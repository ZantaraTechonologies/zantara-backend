const mongoose = require('mongoose');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const ShareExitRequest = require('../models/ShareExitRequest');
const InvestmentWithdrawal = require('../models/InvestmentWithdrawal');
const crypto = require('crypto');
const { runDividendPayout } = require('../utils/dividendCron');
const investmentService = require('../services/investment.service');
const Setting = require('../models/Setting');

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const getSettings = async () => {
    const keys = [
        'investmentEnabled', 'sharePrice', 'maxSharesPerUser', 'totalSharesAvailable',
        'investorAllocationPercent', 'dividendWithdrawalFee', 'dividendReinvestFee',
        'dividendRedeemFee', 'dividendPayoutDay', 'shareLockPeriodMonths',
        'shareExitFee', 'maxMonthlyExitPercent'
    ];
    const defaults = {
        investmentEnabled: true, sharePrice: 10000, maxSharesPerUser: 20,
        totalSharesAvailable: 200, investorAllocationPercent: 20,
        dividendWithdrawalFee: 1.5, dividendReinvestFee: 0, dividendRedeemFee: 0,
        dividendPayoutDay: 1, shareLockPeriodMonths: 6, shareExitFee: 5,
        maxMonthlyExitPercent: 10
    };
    const records = await Setting.find({ key: { $in: keys } });
    const map = {};
    records.forEach(r => map[r.key] = r.value);
    keys.forEach(k => { if (map[k] === undefined) map[k] = defaults[k]; });
    return map;
};

const generateRef = (prefix) => `${prefix}-${crypto.randomUUID().split('-')[0].toUpperCase()}-${Date.now()}`;

// ─────────────────────────────────────────────────────────────
// USER ACTIONS
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/investment/summary
 * Returns the user's full investment portfolio overview
 */
exports.getInvestmentSummary = async (req, res) => {
    try {
        const userId = req.user.id;
        const [user, settings] = await Promise.all([
            User.findById(userId).select('sharesOwned dividendBalance referralBalance totalDividendsEarned isShareholder firstSharePurchasedAt frozenShares'),
            getSettings()
        ]);

        if (!user) return res.status(404).json({ message: 'User not found' });

        const totalSharesIssued = await User.aggregate([
            { $group: { _id: null, total: { $sum: '$sharesOwned' } } }
        ]);

        const sharesRemaining = settings.totalSharesAvailable - (totalSharesIssued[0]?.total || 0);

        // Lock period calculation
        let lockExpiresAt = null;
        let canExit = false;
        if (user.firstSharePurchasedAt) {
            const lockMonths = settings.shareLockPeriodMonths;
            lockExpiresAt = new Date(user.firstSharePurchasedAt);
            lockExpiresAt.setMonth(lockExpiresAt.getMonth() + lockMonths);
            canExit = new Date() >= lockExpiresAt;
        }

        res.json({
            success: true,
            data: {
                isShareholder: user.isShareholder,
                sharesOwned: user.sharesOwned,
                frozenShares: user.frozenShares,
                availableShares: user.sharesOwned - user.frozenShares,
                dividendBalance: user.dividendBalance,
                referralBalance: user.referralBalance || 0,
                totalDividendsEarned: user.totalDividendsEarned,
                firstSharePurchasedAt: user.firstSharePurchasedAt,
                lockExpiresAt,
                canExit,
                settings: {
                    sharePrice: settings.sharePrice,
                    maxSharesPerUser: settings.maxSharesPerUser,
                    sharesRemaining,
                    investorAllocationPercent: settings.investorAllocationPercent,
                    dividendWithdrawalFee: settings.dividendWithdrawalFee,
                    dividendReinvestFee: settings.dividendReinvestFee,
                    dividendRedeemFee: settings.dividendRedeemFee,
                    shareLockPeriodMonths: settings.shareLockPeriodMonths,
                    shareExitFee: settings.shareExitFee,
                    investmentEnabled: settings.investmentEnabled
                }
            }
        });
    } catch (err) {
        console.error('getInvestmentSummary error:', err);
        res.status(500).json({ message: 'Failed to load investment summary' });
    }
};

/**
 * POST /api/investment/buy  { qty }
 * Buy shares — deducted from user's main wallet
 */
exports.buyShares = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const userId = req.user.id;
        const qty = parseInt(req.body.qty);
        if (!qty || qty < 1) return res.status(400).json({ message: 'Quantity must be at least 1' });

        const [user, wallet, settings] = await Promise.all([
            User.findById(userId).session(session),
            Wallet.findOne({ userId }).session(session),
            investmentService.getInvestmentSettings()
        ]);

        if (!user || !wallet) return res.status(404).json({ message: 'User or wallet not found' });
        if (!settings.investmentEnabled) return res.status(403).json({ message: 'Investment feature is currently disabled' });

        // Min shares check
        if (qty < (settings.minSharesPerPurchase || 1))
            return res.status(400).json({ message: `Minimum purchase is ${settings.minSharesPerPurchase || 1} shares` });

        const totalCost = qty * settings.sharePrice;
        if (wallet.balance < totalCost)
            return res.status(400).json({ message: `Insufficient wallet balance. Need ₦${totalCost.toLocaleString()}` });

        // Deduct from wallet first
        wallet.balance -= totalCost;
        await wallet.save({ session });

        // Now fulfill the shares using the service (handles user update & transaction log)
        // We pass the current session to make it atomic
        const refId = `SHARE-${crypto.randomUUID().split('-')[0].toUpperCase()}-${Date.now()}`;
        const result = await investmentService.fulfillSharePurchase(userId, qty, refId, true, session);

        await session.commitTransaction();

        res.json({
            success: true,
            message: `Successfully purchased ${qty} share${qty > 1 ? 's' : ''}`,
            data: { sharesOwned: result.sharesOwned, totalCost, newWalletBalance: wallet.balance }
        });
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        console.error('buyShares error:', err);
        res.status(500).json({ message: err.message || 'Share purchase failed' });
    } finally {
        if (session) session.endSession();
    }
};

/**
 * POST /api/investment/exit  { qty }
 * Request to sell shares back — creates a pending ShareExitRequest
 */
exports.requestShareExit = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const userId = req.user.id;
        const qty = parseInt(req.body.qty);
        if (!qty || qty < 1) return res.status(400).json({ message: 'Quantity must be at least 1' });

        const [user, settings] = await Promise.all([
            User.findById(userId).session(session),
            getSettings()
        ]);

        if (!user?.isShareholder) return res.status(403).json({ message: 'You are not a shareholder' });

        // Check lock period
        if (!user.firstSharePurchasedAt) return res.status(400).json({ message: 'No purchase date on record' });
        const lockExpiresAt = new Date(user.firstSharePurchasedAt);
        lockExpiresAt.setMonth(lockExpiresAt.getMonth() + settings.shareLockPeriodMonths);
        if (new Date() < lockExpiresAt)
            return res.status(403).json({ message: `Shares are locked until ${lockExpiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}` });

        // Check available shares
        const availableShares = user.sharesOwned - user.frozenShares;
        if (qty > availableShares)
            return res.status(400).json({ message: `You only have ${availableShares} shares available for exit` });

        // Check monthly exit quota
        const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
        const totalShareholders = await User.countDocuments({ isShareholder: true });
        const exitsThisMonth = await ShareExitRequest.countDocuments({ status: 'approved', createdAt: { $gte: monthStart } });
        const maxExits = Math.floor(totalShareholders * (settings.maxMonthlyExitPercent / 100));
        if (exitsThisMonth >= maxExits)
            return res.status(429).json({ message: `Monthly exit quota reached (${settings.maxMonthlyExitPercent}% of shareholders). Try again next month.` });

        const grossAmount = qty * settings.sharePrice;
        const exitFeeCharged = grossAmount * (settings.shareExitFee / 100);
        const netAmount = grossAmount - exitFeeCharged;

        // Freeze shares
        user.frozenShares += qty;
        await user.save({ session });

        // Create exit request
        const exitRequest = await ShareExitRequest.create([{
            userId,
            sharesRequested: qty,
            sharePrice: settings.sharePrice,
            grossAmount,
            exitFeePercent: settings.shareExitFee,
            exitFeeCharged,
            netAmount,
            refId: generateRef('EXIT'),
            firstPurchasedAt: user.firstSharePurchasedAt,
            lockPeriodMonths: settings.shareLockPeriodMonths,
            lockExpiresAt
        }], { session });

        await session.commitTransaction();
        res.json({
            success: true,
            message: 'Share exit request submitted. Pending admin approval.',
            data: { grossAmount, exitFeeCharged, netAmount, refId: exitRequest[0].refId }
        });
    } catch (err) {
        await session.abortTransaction();
        console.error('requestShareExit error:', err);
        res.status(500).json({ message: 'Exit request failed' });
    } finally {
        session.endSession();
    }
};

/**
 * POST /api/investment/reinvest  { qty }
 * Use dividendBalance to buy more shares
 */
exports.reinvestDividends = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const userId = req.user.id;
        const qty = parseInt(req.body.qty);
        if (!qty || qty < 1) return res.status(400).json({ message: 'Quantity must be at least 1' });

        const [user, settings] = await Promise.all([
            User.findById(userId).session(session),
            getSettings()
        ]);

        const cost = qty * settings.sharePrice;
        const fee = cost * (settings.dividendReinvestFee / 100);
        const totalCost = cost + fee;

        if (user.dividendBalance < totalCost)
            return res.status(400).json({ message: `Insufficient dividend balance. Need ₦${totalCost.toLocaleString()}` });
        if (user.sharesOwned + qty > settings.maxSharesPerUser)
            return res.status(400).json({ message: `Maximum ${settings.maxSharesPerUser} shares per user` });

        user.dividendBalance -= totalCost;
        user.sharesOwned += qty;
        await user.save({ session });

        await Transaction.create([{
            userId,
            transactionId: generateRef('REINV'),
            type: 'dividend_reinvest',
            amount: totalCost,
            status: 'success',
            details: { sharesQty: qty, pricePerShare: settings.sharePrice, fee }
        }], { session });

        await session.commitTransaction();
        res.json({ success: true, message: `Reinvested into ${qty} share${qty > 1 ? 's' : ''}`, data: { sharesOwned: user.sharesOwned, dividendBalance: user.dividendBalance } });
    } catch (err) {
        await session.abortTransaction();
        console.error('reinvestDividends error:', err);
        res.status(500).json({ message: 'Reinvestment failed' });
    } finally {
        session.endSession();
    }
};

/**
 * POST /api/investment/redeem  { amount }
 * Move dividend balance to main wallet
 */
exports.redeemToMainWallet = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const userId = req.user.id;
        const amount = parseFloat(req.body.amount);
        const source = req.body.source || 'dividend'; // 'dividend' or 'referral'
        if (!amount || amount <= 0) return res.status(400).json({ message: 'Invalid amount' });

        const [user, wallet, settings] = await Promise.all([
            User.findById(userId).session(session),
            Wallet.findOne({ userId }).session(session),
            getSettings()
        ]);

        const balanceKey = source === 'referral' ? 'referralBalance' : 'dividendBalance';
        const fee = amount * (settings.dividendRedeemFee / 100);
        const netAmount = amount - fee;

        if ((user[balanceKey] || 0) < amount)
            return res.status(400).json({ message: `Insufficient ${source} balance` });

        user[balanceKey] -= amount;
        wallet.balance += netAmount;
        await Promise.all([user.save({ session }), wallet.save({ session })]);

        await Transaction.create([{
            userId,
            transactionId: generateRef(source === 'referral' ? 'REF_RED' : 'REDEEM'),
            type: source === 'referral' ? 'referral_redeem' : 'dividend_redeem',
            amount,
            status: 'success',
            details: { fee, netAmount, source }
        }], { session });

        await session.commitTransaction();
        res.json({ 
            success: true, 
            message: `₦${netAmount.toLocaleString()} moved to main wallet`, 
            data: { [balanceKey]: user[balanceKey], walletBalance: wallet.balance } 
        });
    } catch (err) {
        await session.abortTransaction();
        console.error('redeemToMainWallet error:', err);
        res.status(500).json({ message: 'Redemption failed' });
    } finally {
        session.endSession();
    }
};

/**
 * POST /api/investment/withdraw  { amount, bankName, accountNumber, accountName }
 * Request dividend bank withdrawal
 */
exports.requestDividendWithdrawal = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const userId = req.user.id;
        const { amount, bankName, accountNumber, accountName, source = 'dividend' } = req.body;
        if (!amount || !bankName || !accountNumber || !accountName)
            return res.status(400).json({ message: 'All fields are required' });

        const [user, settings] = await Promise.all([
            User.findById(userId).session(session),
            getSettings()
        ]);

        const balanceKey = source === 'referral' ? 'referralBalance' : 'dividendBalance';
        const feePercent = settings.dividendWithdrawalFee;
        const feeCharged = amount * (feePercent / 100);
        const netAmount = amount - feeCharged;

        if ((user[balanceKey] || 0) < amount)
            return res.status(400).json({ message: `Insufficient ${source} balance` });

        // Freeze the amount
        user[balanceKey] -= amount;
        await user.save({ session });

        const withdrawal = await InvestmentWithdrawal.create([{
            userId,
            amount,
            feePercent,
            feeCharged,
            netAmount,
            bankName,
            accountNumber,
            accountName,
            source,
            refId: generateRef(source === 'referral' ? 'REF_W' : 'DIVW')
        }], { session });

        await session.commitTransaction();
        res.json({
            success: true,
            message: 'Withdrawal request submitted. Processing within 1-2 business days.',
            data: { amount, feeCharged, netAmount, refId: withdrawal[0].refId }
        });
    } catch (err) {
        await session.abortTransaction();
        console.error('requestDividendWithdrawal error:', err);
        res.status(500).json({ message: 'Withdrawal request failed' });
    } finally {
        session.endSession();
    }
};

/**
 * GET /api/investment/history
 * Paginated investment transaction history
 */
exports.getDividendHistory = async (req, res) => {
    try {
        const userId = req.user.id;
        const { page = 1, limit = 20 } = req.query;
        const skip = (page - 1) * limit;

        const investmentTypes = ['share_purchase', 'share_exit', 'dividend_credit', 'dividend_reinvest', 'dividend_redeem', 'dividend_withdrawal'];

        const [transactions, total] = await Promise.all([
            Transaction.find({ userId, type: { $in: investmentTypes } })
                .sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
            Transaction.countDocuments({ userId, type: { $in: investmentTypes } })
        ]);

        res.json({
            success: true,
            data: transactions,
            pagination: { total, page: Number(page), pages: Math.ceil(total / limit) }
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to load transaction history' });
    }
};

// ─────────────────────────────────────────────────────────────
// ADMIN ACTIONS (SuperAdmin only)
// ─────────────────────────────────────────────────────────────

exports.getShareholderOverview = async (req, res) => {
    try {
        const [shareholders, totalSharesData, dividendPaid, pendingExits, pendingWithdrawals, settings] = await Promise.all([
            User.countDocuments({ isShareholder: true }),
            User.aggregate([{ $match: { isShareholder: true } }, { $group: { _id: null, total: { $sum: '$sharesOwned' }, frozen: { $sum: '$frozenShares' } } }]),
            Transaction.aggregate([{ $match: { type: 'dividend_credit', status: 'success' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            ShareExitRequest.countDocuments({ status: 'pending' }),
            InvestmentWithdrawal.countDocuments({ status: 'pending' }),
            getSettings()
        ]);

        const totalShares = totalSharesData[0]?.total || 0;
        const frozenShares = totalSharesData[0]?.frozen || 0;

        res.json({
            success: true,
            data: {
                totalShareholders: shareholders,
                totalSharesIssued: totalShares,
                frozenShares,
                sharesRemaining: settings.totalSharesAvailable - totalShares,
                totalDividendsPaid: dividendPaid[0]?.total || 0,
                pendingExitRequests: pendingExits,
                pendingWithdrawals,
                settings
            }
        });
    } catch (err) {
        console.error('getShareholderOverview error:', err);
        res.status(500).json({ message: 'Failed to load shareholder overview' });
    }
};

exports.getAllShareholders = async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const skip = (page - 1) * limit;
        const [shareholders, total] = await Promise.all([
            User.find({ isShareholder: true })
                .select('name email phone sharesOwned frozenShares dividendBalance totalDividendsEarned firstSharePurchasedAt')
                .sort({ sharesOwned: -1 }).skip(skip).limit(Number(limit)),
            User.countDocuments({ isShareholder: true })
        ]);
        res.json({ success: true, data: shareholders, pagination: { total, page: Number(page), pages: Math.ceil(total / limit) } });
    } catch (err) {
        res.status(500).json({ message: 'Failed to load shareholders' });
    }
};

exports.getPendingShareExits = async (req, res) => {
    try {
        const exits = await ShareExitRequest.find({ status: 'pending' })
            .populate('userId', 'name email phone').sort({ createdAt: -1 });
        res.json({ success: true, data: exits });
    } catch (err) {
        res.status(500).json({ message: 'Failed to load exit requests' });
    }
};

exports.processShareExit = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { id } = req.params;
        const { action, adminNote } = req.body;
        if (!['approved', 'rejected'].includes(action))
            return res.status(400).json({ message: 'Action must be approved or rejected' });

        const exitRequest = await ShareExitRequest.findById(id).session(session);
        if (!exitRequest || exitRequest.status !== 'pending')
            return res.status(404).json({ message: 'Exit request not found or already processed' });

        const user = await User.findById(exitRequest.userId).session(session);
        const wallet = await Wallet.findOne({ userId: exitRequest.userId }).session(session);

        if (action === 'approved') {
            // Release shares and return funds to main wallet
            user.sharesOwned -= exitRequest.sharesRequested;
            user.frozenShares -= exitRequest.sharesRequested;
            if (user.sharesOwned <= 0) { user.sharesOwned = 0; user.isShareholder = false; }
            wallet.balance += exitRequest.netAmount;
            exitRequest.status = 'approved';
            exitRequest.adminNote = adminNote || '';

            await Promise.all([user.save({ session }), wallet.save({ session }), exitRequest.save({ session })]);

            await Transaction.create([{
                userId: exitRequest.userId,
                transactionId: generateRef('SEXIT'),
                type: 'share_exit',
                amount: exitRequest.netAmount,
                status: 'success',
                details: { sharesReturned: exitRequest.sharesRequested, grossAmount: exitRequest.grossAmount, exitFeeCharged: exitRequest.exitFeeCharged, refId: exitRequest.refId }
            }], { session });
        } else {
            // Unfreeze shares
            user.frozenShares -= exitRequest.sharesRequested;
            exitRequest.status = 'rejected';
            exitRequest.adminNote = adminNote || '';
            await Promise.all([user.save({ session }), exitRequest.save({ session })]);
        }

        const { logAction } = require('./auditController');
        await logAction(
            req.user.id,
            req.user.name,
            action === 'approved' ? 'INVESTMENT_EXIT_APPROVE' : 'INVESTMENT_EXIT_REJECT',
            `Exit ID: ${id} (User: ${user?.name || exitRequest.userId})`,
            { shares: exitRequest.sharesRequested, amount: exitRequest.netAmount, action, adminNote },
            'success',
            req
        );

        await session.commitTransaction();
        res.json({ success: true, message: `Exit request ${action}`, data: exitRequest });
    } catch (err) {
        await session.abortTransaction();
        console.error('processShareExit error:', err);
        res.status(500).json({ message: 'Failed to process share exit' });
    } finally {
        session.endSession();
    }
};

exports.getPendingDividendWithdrawals = async (req, res) => {
    try {
        const withdrawals = await InvestmentWithdrawal.find({ status: 'pending' })
            .populate('userId', 'name email phone').sort({ createdAt: -1 });
        res.json({ success: true, data: withdrawals });
    } catch (err) {
        res.status(500).json({ message: 'Failed to load withdrawal requests' });
    }
};

exports.processDividendWithdrawal = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { id } = req.params;
        const { action, adminNote } = req.body;
        if (!['approved', 'rejected'].includes(action))
            return res.status(400).json({ message: 'Action must be approved or rejected' });

        const withdrawal = await InvestmentWithdrawal.findById(id).session(session);
        if (!withdrawal || withdrawal.status !== 'pending')
            return res.status(404).json({ message: 'Withdrawal not found or already processed' });

        if (action === 'rejected') {
            // Refund amount back to dividend balance
            const user = await User.findById(withdrawal.userId).session(session);
            user.dividendBalance += withdrawal.amount;
            await user.save({ session });
        }

        withdrawal.status = action;
        withdrawal.adminNote = adminNote || '';
        await withdrawal.save({ session });

        if (action === 'approved') {
            await Transaction.create([{
                userId: withdrawal.userId,
                transactionId: generateRef('DIVW'),
                type: 'dividend_withdrawal',
                amount: withdrawal.netAmount,
                status: 'success',
                details: { grossAmount: withdrawal.amount, feeCharged: withdrawal.feeCharged, refId: withdrawal.refId, bankName: withdrawal.bankName }
            }], { session });
        }

        const { logAction } = require('./auditController');
        const { notifySuperAdmins } = require('../services/notificationService');

        await logAction(
            req.user.id,
            req.user.name,
            action === 'approved' ? 'DIVIDEND_WITHDRAW_APPROVE' : 'DIVIDEND_WITHDRAW_REJECT',
            `Withdrawal ID: ${id} (User ID: ${withdrawal.userId})`,
            { amount: withdrawal.amount, action, adminNote },
            'success',
            req
        );

        if (action === 'approved' && withdrawal.amount >= 50000) {
            await notifySuperAdmins(
                `💰 Large Investment Withdrawal Approved: ₦${withdrawal.amount.toLocaleString()}`,
                `<p>Admin <b>${req.user.name}</b> approved a large investment withdrawal of <b>₦${withdrawal.amount.toLocaleString()}</b> for User ${withdrawal.userId}.</p>`
            );
        }

        await session.commitTransaction();
        res.json({ success: true, message: `Withdrawal ${action}` });
    } catch (err) {
        await session.abortTransaction();
        console.error('processDividendWithdrawal error:', err);
        res.status(500).json({ message: 'Failed to process withdrawal' });
    } finally {
        session.endSession();
    }
};

exports.getInvestmentSettings = async (req, res) => {
    try {
        const settings = await getSettings();
        res.json({ success: true, data: settings });
    } catch (err) {
        res.status(500).json({ message: 'Failed to load settings' });
    }
};

exports.updateInvestmentSettings = async (req, res) => {
    try {
        const updates = req.body; // { key: value, ... }
        const allowedKeys = [
            'investmentEnabled', 'sharePrice', 'maxSharesPerUser', 'totalSharesAvailable',
            'investorAllocationPercent', 'dividendWithdrawalFee', 'dividendReinvestFee',
            'dividendRedeemFee', 'dividendPayoutDay', 'shareLockPeriodMonths', 'shareExitFee', 'maxMonthlyExitPercent'
        ];

        const ops = Object.entries(updates)
            .filter(([k]) => allowedKeys.includes(k))
            .map(([key, value]) => ({
                updateOne: { filter: { key }, update: { $set: { key, value } }, upsert: true }
            }));

        if (ops.length === 0) return res.status(400).json({ message: 'No valid settings provided' });
        await Setting.bulkWrite(ops);
        res.json({ success: true, message: 'Investment settings updated' });
    } catch (err) {
        console.error('updateInvestmentSettings error:', err);
        res.status(500).json({ message: 'Failed to update settings' });
    }
};

exports.triggerManualDividendPayout = async (req, res) => {
    try {
        const result = await runDividendPayout();
        if (result.success) {
            const { logAction } = require('./auditController');
            await logAction(req.user.id, req.user.name, 'INVESTMENT_MANUAL_PAYOUT', `Month: ${result.month}`, { totalPaid: result.totalPaid, shareholders: result.shareholders }, 'success', req);
            
            res.json({ success: true, message: `Payout successful for ${result.month}. Distributed ₦${result.totalPaid.toLocaleString()} to ${result.shareholders} shareholders.` });
        } else {
            // Return 200 for "Skipped" states so the frontend shows an info toast rather than an error
            res.json({ success: false, message: `Payout Skipped: ${result.reason}. (Check March profit levels)` });
        }
    } catch (err) {
        res.status(500).json({ message: 'Server error during manual payout trigger.' });
    }
};
