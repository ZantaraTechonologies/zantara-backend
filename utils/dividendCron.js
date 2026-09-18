const cron = require('node-cron');
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const notificationService = require('../services/notification.service');
const investmentService = require('../services/investment.service');
const { parseInvestmentMoney, parseShareQuantity, parsePercentage } = require('./investmentValidation');

/**
 * Fetches all investment settings from the DB with safe defaults
 */
const getInvestmentSettings = async () => {
    return investmentService.getInvestmentSettings();
};

const allocateDividendPool = (shareholders, poolKobo) => {
    if (!Number.isSafeInteger(poolKobo) || poolKobo <= 0) return [];
    const validated = shareholders.map(shareholder => ({
        shareholder,
        shares: parseShareQuantity(shareholder.sharesOwned, 'Persisted shareholder quantity')
    }));
    const totalShares = validated.reduce((sum, item) => sum + BigInt(item.shares), 0n);
    if (totalShares <= 0n) return [];

    const allocations = validated.map(item => {
        const numerator = BigInt(poolKobo) * BigInt(item.shares);
        return {
            ...item,
            amountKobo: Number(numerator / totalShares),
            remainder: numerator % totalShares
        };
    });
    let remainingKobo = poolKobo - allocations.reduce((sum, item) => sum + item.amountKobo, 0);
    allocations.sort((left, right) => {
        if (left.remainder === right.remainder) {
            return String(left.shareholder._id).localeCompare(String(right.shareholder._id));
        }
        return left.remainder > right.remainder ? -1 : 1;
    });
    for (let index = 0; index < remainingKobo; index++) allocations[index].amountKobo++;
    return allocations;
};

/**
 * The core dividend distribution logic.
 * Can be called by the cron OR triggered manually by a superAdmin.
 */
const runDividendPayout = async () => {
    console.log('[DividendCron] Starting monthly dividend distribution...');

    const settings = await getInvestmentSettings();

    if (!settings.investmentEnabled) {
        console.log('[DividendCron] Skipped: Investment feature is disabled.');
        return { success: false, reason: 'Investment disabled' };
    }

    // 1. Get last month's date range (Production Rule: March in April, April in May)
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1); // first day last month
    const monthEnd = new Date(now.getFullYear(), now.getMonth(), 1);       // first day this month
    const month = monthStart.toLocaleString('default', { month: 'long', year: 'numeric' });

    // 2. DUPLICATE SHIELD: Check if we already paid for this specific month
    const existingPayout = await Transaction.findOne({
        type: 'dividend_credit',
        'details.month': month
    });

    if (existingPayout) {
        console.log(`[DividendCron] Skipped: Payout for ${month} has already been finalized.`);
        return { success: false, reason: `Payout for ${month} is already finalized` };
    }

    // 3. Sum last month's net profit
    const profitResult = await Transaction.aggregate([
        {
            $match: {
                status: 'success',
                type: { $in: ['airtime', 'data', 'tv', 'cable', 'electricity', 'pin'] },
                createdAt: { $gte: monthStart, $lt: monthEnd }
            }
        },
        { $group: { _id: null, totalNetProfit: { $sum: '$netProfitAfterCommission' } } }
    ]);

    const totalNetProfit = profitResult[0]?.totalNetProfit || 0;

    if (totalNetProfit <= 0) {
        console.log(`[DividendCron] Skipped: Net profit for ${monthStart.toLocaleString('default', { month: 'long' })} was ₦0 or negative.`);
        return { success: false, reason: `Zero profit detected for ${month}` };
    }

    // 3. Calculate the pool in integer kobo, rounding down so allocation can
    // never exceed the configured percentage of realized profit.
    const profit = parseInvestmentMoney(totalNetProfit, { label: 'Net profit' });
    const allocationPercent = parsePercentage(settings.investorAllocationPercent, {
        label: 'Investor allocation percent',
        allowHundred: true
    });
    const allocationBasisPoints = Math.round(allocationPercent * 100);
    const dividendPoolKobo = Number(BigInt(profit.kobo) * BigInt(allocationBasisPoints) / 10000n);
    if (dividendPoolKobo <= 0) {
        return { success: false, reason: `Dividend pool for ${month} is below one kobo` };
    }
    const dividendPool = dividendPoolKobo / 100;
    console.log(`[DividendCron] Net Profit: ₦${totalNetProfit.toLocaleString()} | Pool (${settings.investorAllocationPercent}%): ₦${dividendPool.toLocaleString()}`);

    // 4. Get all shareholders and total shares
    const shareholders = await User.find({ isShareholder: true, sharesOwned: { $gt: 0 } })
        .select('_id sharesOwned dividendBalance totalDividendsEarned');

    if (shareholders.length === 0) {
        console.log('[DividendCron] No shareholders found. Skipping payout.');
        return { success: false, reason: 'No shareholders' };
    }

    const allocations = allocateDividendPool(shareholders, dividendPoolKobo);
    const totalSharesIssued = allocations.reduce((sum, item) => sum + item.shares, 0);
    if (!Number.isSafeInteger(totalSharesIssued) || totalSharesIssued <= 0) {
        throw new Error('Total issued share supply requires manual reconciliation');
    }
    console.log(`[DividendCron] Distributing to ${shareholders.length} shareholders (${totalSharesIssued} total shares)`);

    // 5. Distribute proportionally to each shareholder
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const month = monthStart.toLocaleString('default', { month: 'long', year: 'numeric' });
        const txDocs = [];
        const updateOps = [];

        for (const allocation of allocations) {
            const shareholder = allocation.shareholder;
            const userDividend = allocation.amountKobo / 100;
            if (userDividend <= 0) continue;

            updateOps.push({
                updateOne: {
                    filter: { _id: shareholder._id },
                    update: {
                        $inc: {
                            dividendBalance: userDividend,
                            totalDividendsEarned: userDividend
                        }
                    }
                }
            });

            txDocs.push({
                userId: shareholder._id,
                transactionId: `DIV-${month.replace(' ', '-').toUpperCase()}-${shareholder._id.toString().slice(-6).toUpperCase()}`,
                type: 'dividend_credit',
                amount: userDividend,
                status: 'success',
                details: {
                    month,
                    sharesOwned: shareholder.sharesOwned,
                    totalSharesIssued,
                    dividendPool,
                    netProfit: totalNetProfit,
                    allocationPercent: settings.investorAllocationPercent
                }
            });
        }

        // Bulk write all updates atomically
        if (updateOps.length > 0) await User.bulkWrite(updateOps, { session });
        if (txDocs.length > 0) await Transaction.insertMany(txDocs, { session });

        await session.commitTransaction();

        const totalPaid = txDocs.reduce((sum, t) => sum + t.amount, 0);
        console.log(`[DividendCron] ✅ SUCCESS: Paid ₦${totalPaid.toLocaleString()} to ${txDocs.length} shareholders for ${month}`);

        // Notify all shareholders (Fire-and-forget push)
        for (const tx of txDocs) {
            notificationService.sendInApp(tx.userId, {
                title: 'Dividend Paid! 📈',
                message: `Your monthly dividend of ₦${tx.amount.toLocaleString()} for ${month} has been credited to your investment wallet.`,
                type: 'investment',
                metadata: { transactionId: tx.transactionId }
            }).catch(err => console.error(`[DividendCron] Notification failed for ${tx.userId}:`, err.message));
        }

        return { success: true, month, totalPaid, shareholders: txDocs.length };
    } catch (err) {
        await session.abortTransaction();
        console.error('[DividendCron] ❌ FAILED:', err.message);
        return { success: false, reason: err.message };
    } finally {
        session.endSession();
    }
};

/**
 * Starts the cron job — reads the payoutDay setting dynamically on every tick
 * Runs daily at midnight and checks if today is the configured payout day
 */
const startDividendCron = () => {
    // Run at midnight every day — check inside if it's the right day
    cron.schedule('0 0 * * *', async () => {
        try {
            const settings = await getInvestmentSettings();
            const today = new Date().getDate();

            if (today === Number(settings.dividendPayoutDay)) {
                console.log(`[DividendCron] Today is payout day (${today}). Running distribution...`);
                await runDividendPayout();
            }
        } catch (err) {
            console.error('[DividendCron] Scheduler error:', err.message);
        }
    });

    console.log('[DividendCron] Monthly dividend scheduler registered ✅');
};

module.exports = { startDividendCron, runDividendPayout, allocateDividendPool };
