const mongoose = require('mongoose');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const Setting = require('../models/Setting');
const ShareIssuanceLock = require('../models/ShareIssuanceLock');
const crypto = require('crypto');
const { parseInvestmentMoney, parseShareQuantity, parsePercentage } = require('../utils/investmentValidation');

const INVESTMENT_DEFAULTS = {
    investmentEnabled: true,
    sharePrice: 10000,
    maxSharesPerUser: 20,
    totalSharesAvailable: 200,
    minSharesPerPurchase: 1,
    investorAllocationPercent: 20,
    dividendWithdrawalFee: 1.5,
    dividendReinvestFee: 0,
    dividendRedeemFee: 0,
    dividendPayoutDay: 1,
    shareLockPeriodMonths: 6,
    shareExitFee: 5,
    maxMonthlyExitPercent: 10
};

const INVESTMENT_SETTING_KEYS = Object.freeze(Object.keys(INVESTMENT_DEFAULTS));

const validateInvestmentSetting = (key, value) => {
    if (!INVESTMENT_SETTING_KEYS.includes(key)) throw new Error(`Unsupported investment setting '${key}'`);
    if (key === 'investmentEnabled') {
        if (typeof value !== 'boolean') throw new Error('investmentEnabled must be boolean');
        return value;
    }
    if (key === 'sharePrice') return parseInvestmentMoney(value, { label: 'Share price' }).naira;
    if (['maxSharesPerUser', 'totalSharesAvailable', 'minSharesPerPurchase', 'dividendPayoutDay', 'shareLockPeriodMonths'].includes(key)) {
        const parsed = parseShareQuantity(value, key);
        if (key === 'dividendPayoutDay' && parsed > 31) throw new Error('dividendPayoutDay must be between 1 and 31');
        return parsed;
    }
    return parsePercentage(value, {
        label: key,
        allowHundred: ['investorAllocationPercent', 'maxMonthlyExitPercent'].includes(key)
    });
};

/**
 * Helper to fetch specific investment settings with defaults
 */
const getInvestmentSettings = async (session = null) => {
    const keys = INVESTMENT_SETTING_KEYS;
    const query = Setting.find({ key: { $in: keys } });
    if (session) query.session(session);
    
    const records = await query;
    const map = {};
    records.forEach(r => map[r.key] = r.value);
    keys.forEach(k => { if (map[k] === undefined) map[k] = INVESTMENT_DEFAULTS[k]; });
    for (const key of keys) map[key] = validateInvestmentSetting(key, map[key]);
    return map;
};

const generateRef = (prefix) => `${prefix}-${crypto.randomUUID().split('-')[0].toUpperCase()}-${Date.now()}`;

const getAuthoritativeShareBalance = async userId => {
    const lookupId = mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : userId;
    const record = await User.collection.findOne(
        { _id: lookupId },
        { projection: { sharesOwned: 1, isShareholder: 1 } }
    );
    if (!record) throw new Error('Investment account not found');
    if (record.sharesOwned === undefined && record.isShareholder !== true) return 0;
    if (typeof record.sharesOwned !== 'number' || !Number.isSafeInteger(record.sharesOwned) || record.sharesOwned < 0) {
        throw new Error('Investment account share balance requires manual reconciliation');
    }
    return record.sharesOwned;
};

const assertShareCapacity = async (user, qty, settings, session) => {
    const capacityError = message => Object.assign(new Error(message), { statusCode: 400 });
    if (!Number.isSafeInteger(user.sharesOwned) || user.sharesOwned < 0) {
        throw new Error('Existing user share balance requires manual reconciliation');
    }
    await ShareIssuanceLock.updateOne(
        { _id: 'global' },
        { $inc: { revision: 1 } },
        { upsert: true, session }
    );

    const totalSharesIssued = await User.aggregate([
        {
            $project: {
                sharesOwned: 1,
                isShareholder: 1,
                validShares: {
                    $switch: {
                        branches: [
                            {
                                case: { $eq: [{ $type: '$sharesOwned' }, 'missing'] },
                                then: { $ne: ['$isShareholder', true] }
                            },
                            {
                                case: { $in: [{ $type: '$sharesOwned' }, ['int', 'long', 'double', 'decimal']] },
                                then: {
                                    $and: [
                                        { $gte: ['$sharesOwned', 0] },
                                        { $lte: ['$sharesOwned', Number.MAX_SAFE_INTEGER] },
                                        { $eq: ['$sharesOwned', { $floor: '$sharesOwned' }] }
                                    ]
                                }
                            }
                        ],
                        default: false
                    }
                }
            }
        },
        {
            $group: {
                _id: null,
                total: { $sum: { $cond: ['$validShares', '$sharesOwned', 0] } },
                invalidCount: { $sum: { $cond: ['$validShares', 0, 1] } }
            }
        }
    ]).session(session);
    if (Number(totalSharesIssued[0]?.invalidCount || 0) !== 0) {
        throw new Error('Existing platform share balances require manual reconciliation');
    }
    const sharesIssued = totalSharesIssued[0]?.total || 0;
    if (!Number.isSafeInteger(sharesIssued) || sharesIssued < 0) {
        throw new Error('Existing platform share supply requires manual reconciliation');
    }
    const resultingSupply = sharesIssued + qty;
    if (!Number.isSafeInteger(resultingSupply)) {
        throw new Error('Resulting platform share supply exceeds safe integer precision');
    }
    if (resultingSupply > settings.totalSharesAvailable) {
        throw capacityError(`Platform share limit reached. Only ${settings.totalSharesAvailable - sharesIssued} shares remaining.`);
    }
    if (user.sharesOwned + qty > settings.maxSharesPerUser) {
        throw capacityError(`Maximum ${settings.maxSharesPerUser} shares per user limit reached.`);
    }
};

/**
 * Fulfills a share purchase transaction.
 * Can be called from a wallet-based purchase or a Paystack webhook.
 * 
 * @param {string} userId - ID of the investor
 * @param {number} qty - Number of shares to add
 * @param {string} refId - Reference ID for idempotency and tracking
 * @param {boolean} isWalletPayment - Whether the payment was already deducted from wallet
 */
const fulfillSharePurchase = async (userId, qty, refId, isWalletPayment = false, externalSession = null, sharePriceOverride = null) => {
    const qtyNum = parseShareQuantity(qty, 'Share quantity');

    const session = externalSession || await mongoose.startSession();
    if (!externalSession) session.startTransaction();
    
    try {
        const user = await User.findById(userId).session(session);
        const settings = await getInvestmentSettings(session);

        if (!user) throw new Error('User not found');
        if (!settings.investmentEnabled) throw new Error('Investment feature is currently disabled');

        const effectiveSharePrice = Number(sharePriceOverride) > 0
            ? Number(sharePriceOverride)
            : Number(settings.sharePrice);
        const parsedSharePrice = parseInvestmentMoney(effectiveSharePrice, { label: 'Share price' });
        const sharePrice = parsedSharePrice.naira;
        const expectedAmountKobo = qtyNum * parsedSharePrice.kobo;
        if (!Number.isSafeInteger(expectedAmountKobo)) throw new Error('Share purchase total exceeds safe monetary precision');

        // An existing audit is proof only when it binds to this exact owner and value.
        const existingTx = await Transaction.findOne({ refId, type: 'share_purchase' }).session(session);
        if (existingTx) {
            const existingQty = parseShareQuantity(existingTx.details?.sharesQty, 'Recorded share quantity');
            const existingAmount = parseInvestmentMoney(existingTx.amount, { label: 'Recorded share amount' });
            if (String(existingTx.userId) !== String(userId) || existingTx.status !== 'success' ||
                existingQty !== qtyNum || existingAmount.kobo !== expectedAmountKobo) {
                const error = new Error('Existing share-purchase audit does not reconcile with settlement evidence');
                error.code = 'SETTLEMENT_EVIDENCE_INVALID';
                throw error;
            }
            if (!externalSession) {
                await session.abortTransaction();
                session.endSession();
            }
            return { success: true, message: 'Already processed' };
        }

        await assertShareCapacity(user, qtyNum, settings, session);

        // Update user portfolio
        const isFirstPurchase = !user.isShareholder;
        user.sharesOwned += qtyNum;
        user.isShareholder = true;
        if (isFirstPurchase) user.firstSharePurchasedAt = new Date();
        await user.save({ session });

        // Record the transaction
        await Transaction.create([{
            userId,
            transactionId: refId || generateRef('SHARE'),
            refId: refId || generateRef('SHARE'),
            type: 'share_purchase',
            amount: qtyNum * sharePrice,
            status: 'success',
            service: isWalletPayment ? 'Wallet' : 'Paystack Transfer',
            details: { 
                sharesQty: qtyNum,
                pricePerShare: sharePrice,
                paymentMode: isWalletPayment ? 'wallet' : 'paystack_transfer'
            }
        }], { session });

        if (!externalSession) await session.commitTransaction();
        return { 
            success: true, 
            sharesOwned: user.sharesOwned,
            qtyPurchased: qtyNum
        };
    } catch (err) {
        if (!externalSession) await session.abortTransaction();
        console.error('fulfillSharePurchase service error:', err);
        throw err;
    } finally {
        if (!externalSession) session.endSession();
    }
};

module.exports = {
    getInvestmentSettings,
    fulfillSharePurchase,
    assertShareCapacity,
    getAuthoritativeShareBalance,
    validateInvestmentSetting,
    INVESTMENT_SETTING_KEYS
};
