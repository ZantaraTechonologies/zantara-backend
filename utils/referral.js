const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Setting = require('../models/Setting');
const { logTransaction } = require('./transaction');

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

        // 4. Credit Referrer Wallet
        await Wallet.updateOne(
            { userId: referrer._id },
            { $inc: { balance: bonusAmount } }
        );

        // 5. Update Referrer Stats
        referrer.totalReferralBonus = (referrer.totalReferralBonus || 0) + bonusAmount;
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

module.exports = { processReferralBonus };
