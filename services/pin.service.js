const bcrypt = require('bcryptjs');
const User = require('../models/User');

const PIN_SECURITY = Object.freeze({
    MAX_FAILED_ATTEMPTS: 5,
    LOCK_DURATION_MS: 15 * 60 * 1000,
    MAX_STATE_RETRIES: 7
});

const createPinError = (message, code, statusCode) => {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
};

const lockedError = () => createPinError(
    'Transaction PIN is temporarily locked. Please try again later.',
    'TRANSACTION_PIN_LOCKED',
    429
);

const matchedCount = result => Number(result?.matchedCount ?? result?.n ?? 0);

class PinService {
    /**
     * Set a new transaction PIN for a user
     */
    async setPin(userId, pin) {
        if (!/^\d{4}$/.test(pin)) {
            throw new Error('PIN must be exactly 4 digits');
        }

        const user = await User.findOne({ _id: userId, status: true }).select('+transactionPin +pinHistory');
        if (!user) throw new Error('User not found or account is inactive');
        if (user.transactionPin) {
            const error = new Error('Transaction PIN already exists. Use the change PIN flow.');
            error.code = 'PIN_ALREADY_SET';
            error.statusCode = 409;
            throw error;
        }

        const hashedPin = await bcrypt.hash(pin, 10);
        const created = await User.findOneAndUpdate(
            {
                _id: userId,
                status: true,
                $or: [{ transactionPin: { $exists: false } }, { transactionPin: null }]
            },
            {
                $set: {
                    transactionPin: hashedPin,
                    pinHistory: [],
                    isPinSet: true,
                    transactionPinFailedAttempts: 0
                },
                $unset: { transactionPinLockedUntil: 1 }
            },
            { new: true }
        );
        if (!created) {
            const error = new Error('Account or transaction PIN changed concurrently. Please retry.');
            error.code = 'PIN_STATE_CONFLICT';
            error.statusCode = 409;
            throw error;
        }
        return { success: true, message: 'Transaction PIN set successfully' };
    }

    /**
     * Verify a user's transaction PIN
     */
    async verifyPin(userId, pin, { enforceLockout = false } = {}) {
        // Investment routes opt into persistent account lockout. Existing
        // non-investment callers retain their established verification contract.
        if (!enforceLockout) {
            const user = await User.findOne({ _id: userId, status: true }).select('+transactionPin');
            if (!user || !user.transactionPin) throw new Error('Transaction PIN not set');
            if (!await bcrypt.compare(pin, user.transactionPin)) {
                throw new Error('Invalid transaction PIN');
            }
            return true;
        }

        for (let retry = 0; retry < PIN_SECURITY.MAX_STATE_RETRIES; retry++) {
            const now = new Date();
            const user = await User.findOne({ _id: userId, status: true })
                .select('+transactionPin +transactionPinFailedAttempts +transactionPinLockedUntil');
            if (!user || !user.transactionPin) {
                throw new Error('Transaction PIN not set');
            }

            let failures = Number(user.transactionPinFailedAttempts || 0);
            const lockUntil = user.transactionPinLockedUntil
                ? new Date(user.transactionPinLockedUntil)
                : null;

            if (lockUntil && lockUntil.getTime() > now.getTime()) throw lockedError();

            if (lockUntil) {
                const expiredReset = await User.updateOne(
                    {
                        _id: userId,
                        status: true,
                        transactionPin: user.transactionPin,
                        transactionPinLockedUntil: user.transactionPinLockedUntil
                    },
                    {
                        $set: { transactionPinFailedAttempts: 0 },
                        $unset: { transactionPinLockedUntil: 1 }
                    }
                );
                if (matchedCount(expiredReset) === 0) continue;
                failures = 0;
            }

            const isMatch = await bcrypt.compare(pin, user.transactionPin);
            if (!isMatch) {
                const nextFailures = {
                    $add: [{ $ifNull: ['$transactionPinFailedAttempts', 0] }, 1]
                };
                const failedState = await User.findOneAndUpdate(
                    {
                        _id: userId,
                        status: true,
                        transactionPin: user.transactionPin,
                        $or: [
                            { transactionPinLockedUntil: { $exists: false } },
                            { transactionPinLockedUntil: null }
                        ],
                        $expr: {
                            $lt: [
                                { $ifNull: ['$transactionPinFailedAttempts', 0] },
                                PIN_SECURITY.MAX_FAILED_ATTEMPTS
                            ]
                        }
                    },
                    [{
                        $set: {
                            transactionPinFailedAttempts: nextFailures,
                            transactionPinLockedUntil: {
                                $cond: [
                                    { $gte: [nextFailures, PIN_SECURITY.MAX_FAILED_ATTEMPTS] },
                                    new Date(now.getTime() + PIN_SECURITY.LOCK_DURATION_MS),
                                    '$transactionPinLockedUntil'
                                ]
                            }
                        }
                    }],
                    {
                        new: true,
                        select: '+transactionPinFailedAttempts +transactionPinLockedUntil'
                    }
                );
                if (!failedState) continue;
                if (failedState.transactionPinLockedUntil &&
                    new Date(failedState.transactionPinLockedUntil).getTime() > now.getTime()) {
                    throw lockedError();
                }
                throw new Error('Invalid transaction PIN');
            }

            // The reset is a CAS on the hash and observed failure count. If a
            // wrong request races this success, the operation that commits last
            // determines the serial order; an established lock is never cleared.
            const reset = await User.updateOne(
                {
                    _id: userId,
                    status: true,
                    transactionPin: user.transactionPin,
                    $or: [
                        { transactionPinLockedUntil: { $exists: false } },
                        { transactionPinLockedUntil: null }
                    ],
                    $expr: {
                        $eq: [
                            { $ifNull: ['$transactionPinFailedAttempts', 0] },
                            failures
                        ]
                    }
                },
                {
                    $set: { transactionPinFailedAttempts: 0 },
                    $unset: { transactionPinLockedUntil: 1 }
                }
            );
            if (matchedCount(reset) > 0) return true;
        }

        throw createPinError(
            'Transaction PIN verification changed concurrently. Please retry.',
            'PIN_STATE_CONFLICT',
            409
        );
    }

    /**
     * Change an existing transaction PIN
     */
    async changePin(userId, oldPin, newPin) {
        if (!/^\d{4}$/.test(newPin)) throw new Error('PIN must be exactly 4 digits');

        // This single snapshot authorizes the old PIN and anchors the final CAS.
        // Never reload and adopt a hash that the caller did not authenticate.
        const user = await User.findOne({ _id: userId, status: true }).select('+transactionPin +pinHistory');
        if (!user || !user.transactionPin) throw new Error('Transaction PIN not set or account is inactive');
        if (!await bcrypt.compare(oldPin, user.transactionPin)) {
            throw new Error('Invalid transaction PIN');
        }
        if (await bcrypt.compare(newPin, user.transactionPin)) {
            throw new Error('New PIN cannot be the same as your current PIN');
        }
        for (const oldHashedPin of user.pinHistory || []) {
            if (await bcrypt.compare(newPin, oldHashedPin)) {
                throw new Error('New PIN cannot be one of your last 5 previously used PINs');
            }
        }

        const hashedPin = await bcrypt.hash(newPin, 10);
        const pinHistory = [user.transactionPin, ...(user.pinHistory || [])].slice(0, 5);
        const changed = await User.findOneAndUpdate(
            { _id: userId, status: true, transactionPin: user.transactionPin },
            {
                $set: {
                    transactionPin: hashedPin,
                    pinHistory,
                    isPinSet: true,
                    transactionPinFailedAttempts: 0
                },
                $unset: { transactionPinLockedUntil: 1 }
            },
            { new: true }
        );
        if (!changed) {
            const error = new Error('Account or transaction PIN changed concurrently. Please retry.');
            error.code = 'PIN_STATE_CONFLICT';
            error.statusCode = 409;
            throw error;
        }
        return { success: true, message: 'Transaction PIN changed successfully' };
    }
}

module.exports = new PinService();
module.exports.PIN_SECURITY = PIN_SECURITY;
