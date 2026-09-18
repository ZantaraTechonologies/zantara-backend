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
const notificationService = require('../services/notification.service');
const { formatNairaAmount } = require('../utils/notificationFormatter');
const { serializeCustomerTransactions } = require('../utils/customerTransactionSerializer');
const walletService = require('../services/wallet.service');
const { parseInvestmentMoney, parseShareQuantity, parsePercentage } = require('../utils/investmentValidation');

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const getSettings = async () => investmentService.getInvestmentSettings();

const generateRef = (prefix) => `${prefix}-${crypto.randomUUID().split('-')[0].toUpperCase()}-${Date.now()}`;

const BALANCE_KEYS = { dividend: 'dividendBalance', referral: 'referralBalance' };
const isWriteConflict = error => error && (
    error.code === 112 ||
    typeof error.hasErrorLabel === 'function' && error.hasErrorLabel('TransientTransactionError') ||
    /write conflict/i.test(error.message || '')
);

const calculateFee = (amountKobo, feeValue, label) => {
    const percent = parsePercentage(feeValue, { label });
    const feeKobo = Math.round(amountKobo * percent / 100);
    const netKobo = amountKobo - feeKobo;
    if (!Number.isSafeInteger(feeKobo) || feeKobo < 0 || !Number.isSafeInteger(netKobo) || netKobo <= 0) {
        throw new Error(`Invalid ${label}`);
    }
    return { percent, feeKobo, netKobo };
};

const parsePersistedMoney = (value, options) => {
    if (typeof value !== 'number') throw new Error(`${options.label} is not a persisted numeric value`);
    return parseInvestmentMoney(value, options);
};

const validateWithdrawalRecord = withdrawal => {
    if (!withdrawal || !BALANCE_KEYS[withdrawal.source]) throw new Error('Invalid withdrawal source');
    const amount = parsePersistedMoney(withdrawal.amount, { label: 'Withdrawal amount' });
    const fee = parsePersistedMoney(withdrawal.feeCharged, { allowZero: true, label: 'Withdrawal fee' });
    const net = parsePersistedMoney(withdrawal.netAmount, { label: 'Withdrawal net amount' });
    parsePercentage(withdrawal.feePercent, { label: 'Withdrawal fee percent' });
    if (amount.kobo !== fee.kobo + net.kobo) throw new Error('Withdrawal monetary fields do not reconcile');
    if (withdrawal.reservationVersion !== 1 || withdrawal.reservedAmountKobo !== amount.kobo || withdrawal.reservedSource !== withdrawal.source) {
        throw new Error('Withdrawal reservation proof is missing or invalid');
    }
    return { amount, fee, net, balanceKey: BALANCE_KEYS[withdrawal.source] };
};

const validateShareExitRecord = exitRequest => {
    const shares = parseShareQuantity(exitRequest.sharesRequested, 'Persisted share quantity');
    const sharePrice = parsePersistedMoney(exitRequest.sharePrice, { label: 'Persisted share price' });
    const gross = parsePersistedMoney(exitRequest.grossAmount, { label: 'Persisted gross amount' });
    const fee = parsePersistedMoney(exitRequest.exitFeeCharged, { allowZero: true, label: 'Persisted exit fee' });
    const net = parsePersistedMoney(exitRequest.netAmount, { label: 'Persisted exit net amount' });
    parsePercentage(exitRequest.exitFeePercent, { label: 'Persisted exit fee percent' });
    if (!Number.isSafeInteger(shares * sharePrice.kobo) || gross.kobo !== shares * sharePrice.kobo) {
        throw new Error('Share exit gross amount does not reconcile');
    }
    if (gross.kobo !== fee.kobo + net.kobo) throw new Error('Share exit monetary fields do not reconcile');
    if (exitRequest.reservationVersion !== 1 || exitRequest.reservedShares !== shares) {
        throw new Error('Share exit reservation proof is missing or invalid');
    }
    return { shares, net };
};

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
    let qty;
    try {
        qty = parseShareQuantity(req.body.qty);
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const userId = req.user.id;
        const settings = await investmentService.getInvestmentSettings(session);
        if (!settings.investmentEnabled) throw Object.assign(new Error('Investment feature is currently disabled'), { statusCode: 403 });

        // Min shares check
        if (qty < (settings.minSharesPerPurchase || 1))
            throw Object.assign(new Error(`Minimum purchase is ${settings.minSharesPerPurchase || 1} shares`), { statusCode: 400 });

        const refId = `SHARE-${crypto.randomUUID().split('-')[0].toUpperCase()}-${Date.now()}`;
        const sharePriceKobo = parseInvestmentMoney(settings.sharePrice, { label: 'Share price' }).kobo;
        const totalCostKobo = qty * sharePriceKobo;
        if (!Number.isSafeInteger(totalCostKobo)) throw new Error('Share purchase total exceeds safe monetary precision');
        const totalCost = totalCostKobo / 100;
        const debit = await walletService.debit(userId, totalCost, refId, 'investment_share_purchase', null, session);
        const result = await investmentService.fulfillSharePurchase(userId, qty, refId, true, session);

        await session.commitTransaction();

        // Notify user of successful share purchase
        await notificationService.sendInApp(userId, {
            title: 'Investment Successful 📈',
            message: `You have successfully purchased ${qty} share${qty > 1 ? 's' : ''} in Zantara. Welcome to the board!`,
            type: 'investment',
            metadata: { sharesPurchased: qty, totalCost }
        }).catch(error => console.error('Investment purchase notification failed:', error.message));

        res.json({
            success: true,
            message: `Successfully purchased ${qty} share${qty > 1 ? 's' : ''}`,
            data: { sharesOwned: result.sharesOwned, totalCost, newWalletBalance: debit.balance }
        });
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        console.error('buyShares error:', err);
        const status = err.statusCode || (/insufficient|wallet not found/i.test(err.message || '') ? 400 : 500);
        res.status(status).json({ message: err.message || 'Share purchase failed' });
    } finally {
        if (session) session.endSession();
    }
};

/**
 * POST /api/investment/exit  { qty }
 * Request to sell shares back — creates a pending ShareExitRequest
 */
exports.requestShareExit = async (req, res) => {
    let qty;
    try {
        qty = parseShareQuantity(req.body.qty);
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const userId = req.user.id;

        const user = await User.findById(userId).session(session);
        const settings = await getSettings();

        if (!user?.isShareholder) throw Object.assign(new Error('You are not a shareholder'), { statusCode: 403 });

        // Check lock period
        if (!user.firstSharePurchasedAt) throw Object.assign(new Error('No purchase date on record'), { statusCode: 400 });
        const lockExpiresAt = new Date(user.firstSharePurchasedAt);
        lockExpiresAt.setMonth(lockExpiresAt.getMonth() + settings.shareLockPeriodMonths);
        if (new Date() < lockExpiresAt)
            throw Object.assign(new Error(`Shares are locked until ${lockExpiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`), { statusCode: 403 });

        // Check available shares
        const availableShares = user.sharesOwned - user.frozenShares;
        if (qty > availableShares)
            throw Object.assign(new Error(`You only have ${availableShares} shares available for exit`), { statusCode: 400 });

        // Check monthly exit quota
        const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
        const totalShareholders = await User.countDocuments({ isShareholder: true });
        const exitsThisMonth = await ShareExitRequest.countDocuments({ status: 'approved', createdAt: { $gte: monthStart } });
        const maxExits = Math.floor(totalShareholders * (settings.maxMonthlyExitPercent / 100));
        if (exitsThisMonth >= maxExits)
            throw Object.assign(new Error(`Monthly exit quota reached (${settings.maxMonthlyExitPercent}% of shareholders). Try again next month.`), { statusCode: 429 });

        const sharePrice = parseInvestmentMoney(settings.sharePrice, { label: 'Share price' });
        const grossKobo = qty * sharePrice.kobo;
        if (!Number.isSafeInteger(grossKobo)) throw new Error('Share exit total exceeds safe monetary precision');
        const fee = calculateFee(grossKobo, settings.shareExitFee, 'share exit fee');
        const grossAmount = grossKobo / 100;
        const exitFeeCharged = fee.feeKobo / 100;
        const netAmount = fee.netKobo / 100;

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
            reservationVersion: 1,
            reservedShares: qty,
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
        res.status(err.statusCode || (isWriteConflict(err) ? 409 : 500)).json({ message: err.message || 'Exit request failed' });
    } finally {
        session.endSession();
    }
};

/**
 * POST /api/investment/reinvest  { qty }
 * Use dividendBalance to buy more shares
 */
exports.reinvestDividends = async (req, res) => {
    let qty;
    try {
        qty = parseShareQuantity(req.body.qty);
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const userId = req.user.id;

        const user = await User.findById(userId).session(session);
        const settings = await getSettings();

        if (!settings.investmentEnabled) throw Object.assign(new Error('Investment feature is currently disabled'), { statusCode: 403 });
        const sharePriceKobo = parseInvestmentMoney(settings.sharePrice, { label: 'Share price' }).kobo;
        const costKobo = qty * sharePriceKobo;
        if (!Number.isSafeInteger(costKobo)) throw new Error('Reinvestment total exceeds safe monetary precision');
        const feePercent = parsePercentage(settings.dividendReinvestFee, { label: 'dividend reinvest fee', allowHundred: true });
        const feeKobo = Math.round(costKobo * feePercent / 100);
        const totalCostKobo = costKobo + feeKobo;
        if (!Number.isSafeInteger(totalCostKobo)) throw new Error('Reinvestment total exceeds safe monetary precision');
        const cost = costKobo / 100;
        const fee = feeKobo / 100;
        const totalCost = totalCostKobo / 100;

        if (user.dividendBalance < totalCost)
            throw Object.assign(new Error(`Insufficient dividend balance. Need ₦${totalCost.toLocaleString()}`), { statusCode: 400 });
        await investmentService.assertShareCapacity(user, qty, settings, session);

        user.dividendBalance -= totalCost;
        user.sharesOwned += qty;
        if (!user.isShareholder) {
            user.isShareholder = true;
            user.firstSharePurchasedAt = new Date();
        }
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
        res.status(err.statusCode || (isWriteConflict(err) ? 409 : 500)).json({ message: err.message || 'Reinvestment failed' });
    } finally {
        session.endSession();
    }
};

/**
 * POST /api/investment/redeem  { amount }
 * Move dividend balance to main wallet
 */
exports.redeemToMainWallet = async (req, res) => {
    const source = req.body.source || 'dividend';
    if (!BALANCE_KEYS[source]) return res.status(400).json({ message: 'Invalid balance source' });
    let parsedAmount;
    try {
        parsedAmount = parseInvestmentMoney(req.body.amount);
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const userId = req.user.id;
        const settings = await getSettings();
        const balanceKey = BALANCE_KEYS[source];
        const calculated = calculateFee(parsedAmount.kobo, settings.dividendRedeemFee, 'dividend redemption fee');
        const amount = parsedAmount.naira;
        const fee = calculated.feeKobo / 100;
        const netAmount = calculated.netKobo / 100;
        const refId = generateRef(source === 'referral' ? 'REF_RED' : 'REDEEM');

        const user = await User.findOneAndUpdate(
            { _id: userId, [balanceKey]: { $gte: amount } },
            { $inc: { [balanceKey]: -amount } },
            { new: true, session, runValidators: true }
        );
        if (!user) {
            await session.abortTransaction();
            return res.status(400).json({ message: `Insufficient ${source} balance` });
        }
        const credited = await walletService.credit(userId, netAmount, refId, `${source}_investment_redemption`, null, session);

        await Transaction.create([{
            userId,
            transactionId: refId,
            refId,
            type: source === 'referral' ? 'referral_redeem' : 'dividend_redeem',
            amount,
            status: 'success',
            details: { fee, netAmount, source }
        }], { session });

        await session.commitTransaction();
        res.json({ 
            success: true, 
            message: `₦${netAmount.toLocaleString()} moved to main wallet`, 
            data: { [balanceKey]: user[balanceKey], walletBalance: credited.balance }
        });
    } catch (err) {
        await session.abortTransaction();
        console.error('redeemToMainWallet error:', err);
        res.status(isWriteConflict(err) ? 409 : 500).json({ message: err.message || 'Redemption failed' });
    } finally {
        session.endSession();
    }
};

/**
 * POST /api/investment/withdraw  { amount, bankName, accountNumber, accountName }
 * Request dividend bank withdrawal
 */
exports.requestDividendWithdrawal = async (req, res) => {
    const { amount: rawAmount, bankName, accountNumber, accountName, source = 'dividend' } = req.body;
    if (!bankName || !accountNumber || !accountName) return res.status(400).json({ message: 'All fields are required' });
    if (!BALANCE_KEYS[source]) return res.status(400).json({ message: 'Invalid withdrawal source' });

    let amount;
    let settings;
    try {
        amount = parseInvestmentMoney(rawAmount);
        settings = await getSettings();
    } catch (error) {
        const status = /fee|setting/i.test(error.message || '') ? 503 : 400;
        return res.status(status).json({ message: error.message });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const userId = req.user.id;
        const balanceKey = BALANCE_KEYS[source];
        const calculated = calculateFee(amount.kobo, settings.dividendWithdrawalFee, 'dividend withdrawal fee');
        const feeCharged = calculated.feeKobo / 100;
        const netAmount = calculated.netKobo / 100;
        const normalizedAmount = amount.naira;

        const user = await User.findOneAndUpdate(
            { _id: userId, [balanceKey]: { $gte: normalizedAmount } },
            { $inc: { [balanceKey]: -normalizedAmount } },
            { new: true, session, runValidators: true }
        );
        if (!user) {
            await session.abortTransaction();
            return res.status(400).json({ message: `Insufficient ${source} balance` });
        }

        const withdrawal = await InvestmentWithdrawal.create([{
            userId,
            amount: normalizedAmount,
            feePercent: calculated.percent,
            feeCharged,
            netAmount,
            bankName,
            accountNumber,
            accountName,
            source,
            reservationVersion: 1,
            reservedAmountKobo: amount.kobo,
            reservedSource: source,
            refId: generateRef(source === 'referral' ? 'REF_W' : 'DIVW')
        }], { session });

        await session.commitTransaction();
        res.json({
            success: true,
            message: 'Withdrawal request submitted. Processing within 1-2 business days.',
            data: { amount: normalizedAmount, feeCharged, netAmount, refId: withdrawal[0].refId }
        });
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        console.error('requestDividendWithdrawal error:', err);
        res.status(isWriteConflict(err) ? 409 : 500).json({ message: err.message || 'Withdrawal request failed' });
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
            data: serializeCustomerTransactions(transactions),
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
    let exitRequest;
    let user;
    let statusMsg;
    try {
        const { id } = req.params;
        const { action, adminNote } = req.body;
        if (!['approved', 'rejected'].includes(action)) {
            await session.abortTransaction();
            return res.status(400).json({ message: 'Action must be approved or rejected' });
        }

        exitRequest = await ShareExitRequest.findOneAndUpdate(
            { _id: id, status: 'pending' },
            { $set: { status: 'processing' } },
            { new: true, session }
        );
        if (!exitRequest) {
            await session.abortTransaction();
            return res.status(409).json({ message: 'Exit request not found or already processed' });
        }

        let validated;
        try {
            validated = validateShareExitRecord(exitRequest);
        } catch (error) {
            await session.abortTransaction();
            await ShareExitRequest.findOneAndUpdate(
                { _id: id, status: 'pending' },
                { $set: { status: 'manual_review', adminNote: `Automatic quarantine: ${error.message}` } },
                { new: true }
            );
            return res.status(422).json({ message: `Exit request requires manual review: ${error.message}` });
        }

        user = await User.findById(exitRequest.userId).session(session);
        if (!user || user.frozenShares < validated.shares || user.sharesOwned < validated.shares) {
            await session.abortTransaction();
            return res.status(422).json({ message: 'Exit request reservation no longer reconciles with the user portfolio' });
        }

        if (action === 'approved') {
            user.sharesOwned -= validated.shares;
            user.frozenShares -= validated.shares;
            if (user.sharesOwned <= 0) { user.sharesOwned = 0; user.isShareholder = false; }
            await user.save({ session });
            await walletService.credit(
                exitRequest.userId,
                validated.net.naira,
                exitRequest.refId || String(exitRequest._id),
                'investment_share_exit',
                null,
                session
            );
            exitRequest.status = 'approved';
            exitRequest.adminNote = adminNote || '';
            await exitRequest.save({ session });

            await Transaction.create([{
                userId: exitRequest.userId,
                transactionId: generateRef('SEXIT'),
                type: 'share_exit',
                amount: exitRequest.netAmount,
                status: 'success',
                details: { sharesReturned: exitRequest.sharesRequested, grossAmount: exitRequest.grossAmount, exitFeeCharged: exitRequest.exitFeeCharged, refId: exitRequest.refId }
            }], { session });
        } else {
            user.frozenShares -= validated.shares;
            exitRequest.status = 'rejected';
            exitRequest.adminNote = adminNote || '';
            await Promise.all([user.save({ session }), exitRequest.save({ session })]);
        }

        statusMsg = action === 'approved'
            ? `Your share exit request of ${exitRequest.sharesRequested} shares has been approved. ${formatNairaAmount(exitRequest.netAmount)} has been added to your wallet.`
            : `Your share exit request of ${exitRequest.sharesRequested} shares was rejected. ${adminNote ? 'Reason: ' + adminNote : ''}`;

        await session.commitTransaction();
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        console.error('processShareExit error:', err);
        return res.status(isWriteConflict(err) ? 409 : 500).json({ message: 'Failed to process share exit' });
    } finally {
        session.endSession();
    }

    const { action, adminNote } = req.body;
    const { logAction } = require('./auditController');
    await logAction(
        req.user.id,
        req.user.name,
        action === 'approved' ? 'INVESTMENT_EXIT_APPROVE' : 'INVESTMENT_EXIT_REJECT',
        `Exit ID: ${req.params.id} (User: ${user?.name || exitRequest.userId})`,
        { shares: exitRequest.sharesRequested, amount: exitRequest.netAmount, action, adminNote },
        'success',
        req
    );
    await notificationService.sendInApp(exitRequest.userId, {
        title: `Share Exit ${action.charAt(0).toUpperCase() + action.slice(1)}`,
        message: statusMsg,
        type: 'investment',
        metadata: { exitRequestId: exitRequest._id }
    }, `share_exit_${action}:${exitRequest._id}`).catch(error => {
        console.error('Share exit notification failed:', error.message);
    });
    return res.json({ success: true, message: `Exit request ${action}`, data: exitRequest });
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
    let withdrawal;
    let statusMsg;
    try {
        const { id } = req.params;
        const { action, adminNote } = req.body;
        if (!['approved', 'rejected'].includes(action)) {
            await session.abortTransaction();
            return res.status(400).json({ message: 'Action must be approved or rejected' });
        }

        withdrawal = await InvestmentWithdrawal.findOneAndUpdate(
            { _id: id, status: 'pending' },
            { $set: { status: 'processing' } },
            { new: true, session }
        );
        if (!withdrawal) {
            await session.abortTransaction();
            return res.status(409).json({ message: 'Withdrawal not found or already processed' });
        }

        let validated;
        try {
            validated = validateWithdrawalRecord(withdrawal);
        } catch (error) {
            await session.abortTransaction();
            await InvestmentWithdrawal.findOneAndUpdate(
                { _id: id, status: 'pending' },
                { $set: { status: 'manual_review', adminNote: `Automatic quarantine: ${error.message}` } },
                { new: true }
            );
            return res.status(422).json({ message: `Withdrawal requires manual review: ${error.message}` });
        }

        if (action === 'rejected') {
            const user = await User.findById(withdrawal.userId).session(session);
            if (!user) throw new Error('Withdrawal owner not found');
            user[validated.balanceKey] = Number(user[validated.balanceKey] || 0) + validated.amount.naira;
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

        statusMsg = action === 'approved'
            ? `Your dividend withdrawal of ${formatNairaAmount(withdrawal.amount)} has been approved.`
            : `Your dividend withdrawal of ${formatNairaAmount(withdrawal.amount)} was rejected. ${adminNote ? 'Reason: ' + adminNote : ''}`;

        await session.commitTransaction();
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        console.error('processDividendWithdrawal error:', err);
        return res.status(isWriteConflict(err) ? 409 : 500).json({ message: 'Failed to process withdrawal' });
    } finally {
        session.endSession();
    }

    const { action, adminNote } = req.body;
    const { logAction } = require('./auditController');
    const { notifySuperAdmins } = require('../services/notificationService');
    await logAction(
        req.user.id,
        req.user.name,
        action === 'approved' ? 'DIVIDEND_WITHDRAW_APPROVE' : 'DIVIDEND_WITHDRAW_REJECT',
        `Withdrawal ID: ${req.params.id} (User ID: ${withdrawal.userId})`,
        { amount: withdrawal.amount, action, adminNote },
        'success',
        req
    );
    if (action === 'approved' && withdrawal.amount >= 50000) {
        await notifySuperAdmins(
            `Large Investment Withdrawal Approved: ${formatNairaAmount(withdrawal.amount)}`,
            `<p>Admin <b>${req.user.name}</b> approved a large investment withdrawal of <b>${formatNairaAmount(withdrawal.amount)}</b> for User ${withdrawal.userId}.</p>`
        ).catch(error => console.error('Super admin notification failed:', error.message));
    }
    await notificationService.sendInApp(withdrawal.userId, {
        title: `Withdrawal ${action.charAt(0).toUpperCase() + action.slice(1)}`,
        message: statusMsg,
        type: 'investment',
        metadata: { withdrawalId: withdrawal._id }
    }, `dividend_withdrawal_${action}:${withdrawal._id}`).catch(error => {
        console.error('Investment withdrawal notification failed:', error.message);
    });
    return res.json({ success: true, message: `Withdrawal ${action}` });
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
        const ops = Object.entries(updates)
            .filter(([key]) => investmentService.INVESTMENT_SETTING_KEYS.includes(key))
            .map(([key, value]) => {
                const normalized = investmentService.validateInvestmentSetting(key, value);
                return { updateOne: { filter: { key }, update: { $set: { key, value: normalized } }, upsert: true } };
            });

        if (ops.length === 0) return res.status(400).json({ message: 'No valid settings provided' });
        await Setting.bulkWrite(ops);
        res.json({ success: true, message: 'Investment settings updated' });
    } catch (err) {
        console.error('updateInvestmentSettings error:', err);
        res.status(400).json({ message: err.message || 'Failed to update settings' });
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
