const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Setting = require('../models/Setting');
const Transaction = require('../models/Transaction');
const WalletLedger = require('../models/WalletLedger');
const { logTransaction } = require('./transaction');
const walletService = require('../services/wallet.service');
const settingsService = require('../services/settings.service');
const notificationService = require('../services/notification.service');

/**
 * Note: processReferralBonus (Signup/First Funding Bonus) was removed 
 * as per requirements to only use purchase commissions.
 */

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
        if (!user || (!user.referredBy && !user.referrerCode)) return 0;

        // Use referredBy (ObjectId) as primary, fallback to referrerCode (String)
        let referrer = user.referredBy;
        if (!referrer && user.referrerCode) {
            referrer = await User.findOne({ myReferralCode: user.referrerCode }).session(session);
        }

        if (!referrer) return 0;

        // --- HARDENING: Self-Referral Guard ---
        if (referrer._id.toString() === userId.toString()) {
            console.warn(`Self-referral detected for user ${userId}. Skipping commission.`);
            return 0;
        }

        // 2. Fetch Global Commission Setting (Default)
        const globalRate = await settingsService.getSetting('REFERRAL_COMMISSION_PERCENTAGE', 0.01);

        // 3. Resolve Final Commission Rate (Margin Share)
        const rate = (referrer.commissionRate !== undefined && referrer.commissionRate !== null) 
            ? referrer.commissionRate 
            : globalRate;

        // 4. Retrieve Parent Transaction to derive Profit
        const parentTxn = await Transaction.findById(parentTransactionObjectId).session(session);
        
        if (!parentTxn) {
            console.error(`[Transparency Error] Parent transaction ${parentTransactionStringId} not found. Cannot calculate margin-share.`);
            return 0;
        }

        // 4.1 Calculate Commission based on MARKUP (Estimated Profit), not the full reconciled profit
        const profitMargin = parentTxn.estimatedProfit || parentTxn.profit || 0;
        let commissionAmount = profitMargin * rate;
        
        if (commissionAmount <= 0) {
             console.log(`[Margin Guard] Commission skipped: No available profit on transaction ${parentTransactionStringId}.`);
             return 0;
        }

        // --- HARDENING: Profit Safety Cap against Misconfiguration ---
        let originalCommission = commissionAmount;
        let wasCapped = false;
        let buyerRole = parentTxn.userRole || 'user';

        // Fetch Global Profit-Share Caps
        const standardCapSetting = await Setting.findOne({ key: 'maxReferralProfitShare' }).session(session);
        const agentCapSetting = await Setting.findOne({ key: 'maxAgentReferralShare' }).session(session);
        
        // Defaults: Max 90% of profit to referrers of users, Max 50% to referrers of agents
        const standardCap = standardCapSetting ? Number(standardCapSetting.value) : 0.9;
        const agentCap = agentCapSetting ? Number(agentCapSetting.value) : 0.5;

        // Stricter cap for agents vs standard users
        const profitCap = (buyerRole === 'agent') ? agentCap : standardCap;
        const maxSafeCommission = profitMargin * profitCap;

        if (commissionAmount > maxSafeCommission) {
            console.log(`[Safety Cap] ${buyerRole.toUpperCase()} referral: Requested margin share (${rate*100}%) exceeds system maximum (${profitCap*100}%). Capping.`);
            commissionAmount = Math.max(0, maxSafeCommission);
            wasCapped = true;
        }
        
        // Attach to details later
        const capRateUsed = profitCap;
        parentTxn.capRateUsed = capRateUsed;



        const netProfit = (parentTxn.profit || 0) - commissionAmount;

        // 4.6 Update Parent Transaction with Transparency Data (Step 6)
        await Transaction.findByIdAndUpdate(parentTransactionObjectId, {
            netProfitAfterCommission: netProfit,
            commissionVersion: 'v1'
        }).session(session);

        if (commissionAmount <= 0) {
            console.log(`[Margin Guard] Commission skipped for ${buyerRole} purchase due to zero/negative remaining profit.`);
            
            // Log Skipped Event for Audit (Step 6)
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

            return 0;
        }

        // 5. Idempotency Check: Don't credit twice for the same transaction
        const commId = `COMM-${parentTransactionStringId}`;
        const existing = await Transaction.findOne({ 
            userId: referrer._id, 
            type: 'referral_bonus', 
            transactionId: commId 
        }).session(session);
        if (existing) return 0;

        /* 
        // 6. Credit Referrer Wallet - DISABLED to prevent double-crediting.
        // Users must now redeem referralBalance into main wallet manually.
        await walletService.credit(
            referrer._id, 
            commissionAmount, 
            `COMM-${parentTransactionStringId}`, 
            'REFERRAL_COMMISSION', 
            parentTransactionObjectId,
            session
        );
        */

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
        
        // Notify Referrer
        await notificationService.sendInApp(referrer._id, {
            title: 'Referral Commission Earned!',
            message: `You earned ₦${commissionAmount.toLocaleString()} from ${user.name || user.phone}'s purchase.`,
            type: 'referral',
            metadata: { transactionId: commId }
        });

        console.log(`[Referral] Lifetime commission of ${commissionAmount} credited to ${referrer.phone || referrer.email} (${wasCapped ? 'CAPPED' : 'FULL'})`);
        console.log("!!! COMPLETED processLifetimeCommission !!!");

        return commissionAmount;

    } catch (error) {
        console.error('Error processing lifetime commission:', error);
        return 0;
    }
};

module.exports = { processLifetimeCommission };
