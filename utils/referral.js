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
 * @param {ClientSession} [session=null] - Mongoose session for atomicity
 */
const processLifetimeCommission = async (userId, amount, parentTransactionObjectId, parentTransactionStringId, session = null) => {
    try {
        console.log("!!! ENTERED processLifetimeCommission !!!");
        // 1. Get User and verify referrer
        const user = await User.findById(userId).populate('referredBy').session(session);
        if (!user || (!user.referredBy && !user.referrerCode)) return;

        // Use referredBy (ObjectId) as primary, fallback to referrerCode (String)
        let referrer = user.referredBy;
        if (!referrer && user.referrerCode) {
            referrer = await User.findOne({ myReferralCode: user.referrerCode }).session(session);
        }

        if (!referrer) return;

        // --- HARDENING: Self-Referral Guard ---
        if (referrer._id.toString() === userId.toString()) {
            console.warn(`Self-referral detected for user ${userId}. Skipping commission.`);
            return;
        }

        // 2. Fetch Global Commission Setting
        const Setting = require('../models/Setting');
        const globalSetting = await Setting.findOne({ key: 'defaultCommissionRate' }).session(session);
        const globalRate = globalSetting ? Number(globalSetting.value) : 0.01;

        // 3. Resolve Final Commission Rate
        const rate = (referrer.commissionRate !== undefined && referrer.commissionRate !== null) 
            ? referrer.commissionRate 
            : globalRate;

        // 4. Calculate Commission
        let commissionAmount = amount * rate;
        if (commissionAmount <= 0) return;

        // --- HARDENING: Profit Safety Cap (Step 4: Combination Logic) ---
        const Transaction = require('../models/Transaction');
        const parentTxn = await Transaction.findById(parentTransactionObjectId).session(session);
        
        let originalCommission = commissionAmount;
        let wasCapped = false;
        let buyerRole = 'user';

        if (parentTxn && parentTxn.profit !== undefined) {
            buyerRole = parentTxn.userRole || 'user';
            
            // 4.5 Fetch Global Profit-Share Caps (Step 5: Configurable Caps)
            const standardCapSetting = await Setting.findOne({ key: 'maxReferralProfitShare' }).session(session);
            const agentCapSetting = await Setting.findOne({ key: 'maxAgentReferralShare' }).session(session);
            
            const standardCap = standardCapSetting ? Number(standardCapSetting.value) : 0.9;
            const agentCap = agentCapSetting ? Number(agentCapSetting.value) : 0.5;

            // Stricter cap for agents vs standard users
            const profitCap = (buyerRole === 'agent') ? agentCap : standardCap;
            const maxSafeCommission = parentTxn.profit * profitCap;

            // For logging
            const capRateUsed = profitCap;

            if (commissionAmount > maxSafeCommission) {
                console.log(`[Safety Cap] ${buyerRole.toUpperCase()} purchase: Commission ${commissionAmount} exceeds ${profitCap*100}% of profit (${maxSafeCommission}). Capping.`);
                commissionAmount = Math.max(0, maxSafeCommission);
                wasCapped = true;
            }
            
            // Attach to details later
            parentTxn.capRateUsed = capRateUsed; 
        }

        if (!parentTxn) {
            console.error(`[Transparency Error] Parent transaction ${parentTransactionStringId} not found.`);
            return;
        }

        const netProfit = (parentTxn.profit || 0) - commissionAmount;

        // 4.6 Update Parent Transaction with Transparency Data (Step 6)
        await Transaction.findByIdAndUpdate(parentTransactionObjectId, {
            netProfitAfterCommission: netProfit,
            commissionVersion: 'v1'
        }).session(session);

        if (commissionAmount <= 0) {
            console.log(`[Margin Guard] Commission skipped for ${buyerRole} purchase due to zero/negative remaining profit.`);
            
            // Log Skipped Event for Audit (Step 6)
            const WalletLedger = require('../models/WalletLedger');
            const Wallet = require('../models/Wallet');
            const wallet = await Wallet.findOne({ userId: user._id }).session(session);

            await WalletLedger.create([{
                walletId: wallet ? wallet._id : null,
                userId: user._id,
                transactionId: parentTransactionObjectId,
                reference: `SKIP-${parentTransactionStringId}`,
                entryType: 'credit',
                source: 'REFERRAL_SKIPPED',
                amount: 0,
                balanceBefore: wallet ? wallet.balance : 0,
                balanceAfter: wallet ? wallet.balance : 0,
                commissionVersion: 'v1',
                metadata: {
                    reason: 'LOW_PROFIT',
                    buyerRole,
                    parentTxnId: parentTransactionStringId,
                    capRateUsed: parentTxn.capRateUsed,
                    attemptedCommission: originalCommission,
                    profitAtTime: parentTxn.profit
                }
            }], { session });

            return;
        }

        // 5. Idempotency Check: Don't credit twice for the same transaction
        const commId = `COMM-${parentTransactionStringId}`;
        const existing = await Transaction.findOne({ 
            userId: referrer._id, 
            type: 'referral_bonus', 
            transactionId: commId 
        }).session(session);
        if (existing) return;

        // 6. Credit Referrer Wallet
        await walletService.credit(
            referrer._id, 
            commissionAmount, 
            `COMM-${parentTransactionStringId}`, 
            'REFERRAL_COMMISSION', 
            parentTransactionObjectId,
            session
        );

        // 7. Update Referrer Stats
        referrer.totalReferralBonus = (referrer.totalReferralBonus || 0) + commissionAmount;
        referrer.referralBalance = (referrer.referralBalance || 0) + commissionAmount;
        await referrer.save({ session });

        // 8. Log as Transaction for Visibility in History with Audit Details
        await Transaction.create([{
            userId: referrer._id,
            transactionId: commId,
            refId: parentTransactionStringId,
            type: 'referral_bonus',
            service: 'Commission',
            amount: commissionAmount,
            status: 'success',
            commissionVersion: 'v1',
            details: {
                fromUser: user.phone || user.email,
                fromUserId: user._id,
                triggerTransaction: parentTransactionStringId,
                buyerRole: buyerRole,
                rateUsed: rate,
                capRateUsed: parentTxn.capRateUsed,
                originalCommission: originalCommission,
                cappedCommission: commissionAmount,
                wasCapped: wasCapped,
                note: `Lifetime Commission (${buyerRole})`
            }
        }], { session });

        console.log(`Lifetime commission of ${commissionAmount} credited to ${referrer.phone || referrer.email} (${wasCapped ? 'CAPPED' : 'FULL'})`);

    } catch (error) {
        console.error('Error processing lifetime commission:', error);
    }
};

module.exports = { processReferralBonus, processLifetimeCommission };
