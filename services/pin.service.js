const bcrypt = require('bcryptjs');
const User = require('../models/User');

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
            { $set: { transactionPin: hashedPin, pinHistory: [], isPinSet: true } },
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
    async verifyPin(userId, pin) {
        const user = await User.findOne({ _id: userId, status: true }).select('+transactionPin');
        if (!user || !user.transactionPin) {
            throw new Error('Transaction PIN not set');
        }
        
        const isMatch = await bcrypt.compare(pin, user.transactionPin);
        if (!isMatch) {
            throw new Error('Invalid transaction PIN');
        }
        return true;
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
            { $set: { transactionPin: hashedPin, pinHistory, isPinSet: true } },
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
