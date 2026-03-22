const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Setting = require('../models/Setting');
const { logTransaction } = require('./transaction');
const walletService = require('../services/wallet.service');

/**
 * Process referral bonus for a transaction
 * @param {string} userId - The ID of the user performing the transaction
 * @param {number} purchaseAmount - The amount of the purchase
 * @param {string} transactionRef - Reference of the triggering transaction
 */
const processReferralBonus = async (userId, purchaseAmount, transactionRef) => {
    try {
        // 1. Check if Referral System is Enabled
        const referralEnabled = await Setting.findOne({ key: 'referral_enabled' });
        if (!referralEnabled || referralEnabled.value !== true) return;

        // 2. Get User and Referrer
        const user = await User.findById(userId);
        if (!user || !user.referrerCode) return; // No referrer

        const referrer = await User.findOne({ myReferralCode: user.referrerCode });
        if (!referrer) return;

        // 3. Get Bonus Percentage
        const bonusSetting = await Setting.findOne({ key: 'referral_percentage' });
        const percentage = bonusSetting ? Number(bonusSetting.value) : 1; // Default 1%

        const bonusAmount = (percentage / 100) * purchaseAmount;

        if (bonusAmount <= 0) return;

// 4. Credit Referrer Referral Balance (separately from main wallet)
// We still use WalletService for ledger (if we want it there) or just update the user model.
// The user requested a separate "referral wallet" experience.
// Let's update the user model's referralBalance.
// Note: We'll still log it as a transaction for visibility.

        // 5. Update Referrer Stats and Balance
        referrer.totalReferralBonus = (referrer.totalReferralBonus || 0) + bonusAmount;
        referrer.referralBalance = (referrer.referralBalance || 0) + bonusAmount;
        await referrer.save();

        // 6. Log Transaction for Referrer
        await logTransaction({
            userId: referrer._id,
            refId: `REF-${transactionRef}`,
            type: 'referral_bonus',
            service: 'Bonus',
            amount: bonusAmount,
            status: 'success',
            details: {
                fromUser: user.email,
                percentage: percentage,
                triggerTransaction: transactionRef
            }
        });

        console.log(`Referral bonus of ${bonusAmount} credited to ${referrer.email}`);

    } catch (error) {
        console.error('Error processing referral bonus:', error);
    }
};

/**
 * Process lifetime commission for a transaction
 * @param {string} userId - ID of the user who made the purchase
 * @param {number} amount - Amount of the purchase
 * @param {ObjectId} parentTransactionObjectId - MongoDB _id of parent transaction
 * @param {string} parentTransactionStringId - Human-readable ID of parent (for idempotency)
 */
const processLifetimeCommission = async (userId, amount, parentTransactionObjectId, parentTransactionStringId) => {
    try {
        // 1. Get User and verify referrer
        const user = await User.findById(userId).populate('referredBy');
        if (!user || (!user.referredBy && !user.referrerCode)) return;

        // Use referredBy (ObjectId) as primary, fallback to referrerCode (String)
        let referrer = user.referredBy;
        if (!referrer && user.referrerCode) {
            referrer = await User.findOne({ myReferralCode: user.referrerCode });
        }

        if (!referrer) return;

        // 2. Calculate Commission (Fixed 1%)
        const commissionAmount = amount * 0.01;
        if (commissionAmount <= 0) return;

        // 3. Idempotency Check: Don't credit twice for the same transaction
        const Transaction = require('../models/Transaction');
        const commId = `COMM-${parentTransactionStringId}`;
        const existing = await Transaction.findOne({ 
            userId: referrer._id, 
            type: 'referral_bonus', 
            transactionId: commId 
        });
        if (existing) return;

        // 4. Credit Referrer Wallet
        await walletService.credit(
            referrer._id, 
            commissionAmount, 
            `COMM-${parentTransactionStringId}`, 
            'REFERRAL_COMMISSION', 
            parentTransactionObjectId
        );

        // 5. Update Referrer Stats (for the Referral Screen display)
        referrer.totalReferralBonus = (referrer.totalReferralBonus || 0) + commissionAmount;
        referrer.referralBalance = (referrer.referralBalance || 0) + commissionAmount;
        await referrer.save();

        // 6. Log as Transaction for Visibility in History
        await Transaction.create({
            userId: referrer._id,
            transactionId: commId,
            refId: parentTransactionStringId,
            type: 'referral_bonus',
            service: 'Commission',
            amount: commissionAmount,
            status: 'success',
            details: {
                fromUser: user.phone || user.email,
                fromUserId: user._id,
                triggerTransaction: parentTransactionStringId,
                note: 'Lifetime Panel Commission'
            }
        });

        console.log(`Lifetime commission of ${commissionAmount} credited to ${referrer.phone || referrer.email}`);

    } catch (error) {
        console.error('Error processing lifetime commission:', error);
    }
};

module.exports = { processReferralBonus, processLifetimeCommission };
