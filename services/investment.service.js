const mongoose = require('mongoose');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const Setting = require('../models/Setting');
const crypto = require('crypto');

/**
 * Helper to fetch specific investment settings with defaults
 */
const getInvestmentSettings = async () => {
    const keys = [
        'investmentEnabled', 'sharePrice', 'maxSharesPerUser', 'totalSharesAvailable',
        'minSharesPerPurchase'
    ];
    const defaults = {
        investmentEnabled: true,
        sharePrice: 10000,
        maxSharesPerUser: 20,
        totalSharesAvailable: 200,
        minSharesPerPurchase: 1
    };
    const records = await Setting.find({ key: { $in: keys } });
    const map = {};
    records.forEach(r => map[r.key] = r.value);
    keys.forEach(k => { if (map[k] === undefined) map[k] = defaults[k]; });
    return map;
};

const generateRef = (prefix) => `${prefix}-${crypto.randomUUID().split('-')[0].toUpperCase()}-${Date.now()}`;

/**
 * Fulfills a share purchase transaction.
 * Can be called from a wallet-based purchase or a Paystack webhook.
 * 
 * @param {string} userId - ID of the investor
 * @param {number} qty - Number of shares to add
 * @param {string} refId - Reference ID for idempotency and tracking
 * @param {boolean} isWalletPayment - Whether the payment was already deducted from wallet
 */
const fulfillSharePurchase = async (userId, qty, refId, isWalletPayment = false) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const [user, settings] = await Promise.all([
            User.findById(userId).session(session),
            getInvestmentSettings()
        ]);

        if (!user) throw new Error('User not found');
        if (!settings.investmentEnabled) throw new Error('Investment feature is currently disabled');

        // Idempotency check: Ensure this reference hasn't already been processed for shares
        const existingTx = await Transaction.findOne({ refId, type: 'share_purchase' });
        if (existingTx) {
            await session.abortTransaction();
            session.endSession();
            return { success: true, message: 'Already processed' };
        }

        // Validate limits
        const totalSharesIssued = await User.aggregate([
            { $group: { _id: null, total: { $sum: '$sharesOwned' } } }
        ]).session(session);
        
        const sharesIssued = totalSharesIssued[0]?.total || 0;
        if (sharesIssued + qty > settings.totalSharesAvailable) {
            throw new Error(`Platform share limit reached. Only ${settings.totalSharesAvailable - sharesIssued} shares remaining.`);
        }

        if (user.sharesOwned + qty > settings.maxSharesPerUser) {
            throw new Error(`Maximum ${settings.maxSharesPerUser} shares per user limit reached.`);
        }

        // Update user portfolio
        const isFirstPurchase = !user.isShareholder;
        user.sharesOwned += qty;
        user.isShareholder = true;
        if (isFirstPurchase) user.firstSharePurchasedAt = new Date();
        await user.save({ session });

        // Record the transaction
        await Transaction.create([{
            userId,
            transactionId: refId || generateRef('SHARE'),
            refId: refId || generateRef('SHARE'),
            type: 'share_purchase',
            amount: qty * settings.sharePrice,
            status: 'success',
            service: isWalletPayment ? 'Wallet' : 'Paystack Transfer',
            details: { 
                sharesQty: qty, 
                pricePerShare: settings.sharePrice,
                paymentMode: isWalletPayment ? 'wallet' : 'paystack_transfer'
            }
        }], { session });

        await session.commitTransaction();
        return { 
            success: true, 
            sharesOwned: user.sharesOwned,
            qtyPurchased: qty
        };
    } catch (err) {
        await session.abortTransaction();
        console.error('fulfillSharePurchase service error:', err);
        throw err;
    } finally {
        session.endSession();
    }
};

module.exports = {
    getInvestmentSettings,
    fulfillSharePurchase
};
