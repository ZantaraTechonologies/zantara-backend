const User = require('../models/User');
const ShareExitQuota = require('../models/ShareExitQuota');

const getQuotaPeriod = (now = new Date()) => {
    const periodStart = new Date(now);
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    const periodKey = `${periodStart.getFullYear()}-${String(periodStart.getMonth() + 1).padStart(2, '0')}`;
    return { periodKey, periodStart, periodEnd };
};

const quotaError = () => Object.assign(
    new Error('Monthly exit quota reached. Try again next month.'),
    { statusCode: 429, code: 'SHARE_EXIT_QUOTA_EXHAUSTED' }
);

const integrityError = () => Object.assign(
    new Error('Share exit quota reservation requires manual reconciliation'),
    { code: 'SHARE_EXIT_QUOTA_INTEGRITY' }
);

const reserve = async ({ session, percentage, now = new Date() }) => {
    const { periodKey, periodStart, periodEnd } = getQuotaPeriod(now);
    const shareholderCount = await User.countDocuments({ isShareholder: true }).session(session);
    const percentageBasisPoints = Math.round(percentage * 100);
    const allowanceNumerator = shareholderCount * percentageBasisPoints;
    const allowance = Math.floor(allowanceNumerator / 10000);
    if (!Number.isSafeInteger(percentageBasisPoints) || !Number.isSafeInteger(allowanceNumerator) ||
        !Number.isSafeInteger(allowance) || allowance < 0) throw integrityError();

    await ShareExitQuota.updateOne(
        { _id: periodKey },
        {
            $setOnInsert: {
                periodStart,
                periodEnd,
                allowance,
                used: 0,
                shareholderCount,
                percentage,
                revision: 0
            }
        },
        { upsert: true, session }
    );

    const quota = await ShareExitQuota.findOneAndUpdate(
        { _id: periodKey, $expr: { $lt: ['$used', '$allowance'] } },
        { $inc: { used: 1, revision: 1 } },
        { new: true, session }
    );
    if (!quota) throw quotaError();
    return { periodKey };
};

const assertReserved = async ({ periodKey, session }) => {
    const quota = await ShareExitQuota.findById(periodKey).session(session);
    if (!quota || !Number.isSafeInteger(quota.used) || quota.used < 1 || quota.used > quota.allowance) {
        throw integrityError();
    }
};

const release = async ({ periodKey, session }) => {
    const quota = await ShareExitQuota.findOneAndUpdate(
        { _id: periodKey, used: { $gte: 1 } },
        { $inc: { used: -1, revision: 1 } },
        { new: true, session }
    );
    if (!quota) throw integrityError();
};

module.exports = { getQuotaPeriod, reserve, assertReserved, release };
