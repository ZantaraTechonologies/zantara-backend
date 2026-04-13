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

        const user = await User.findById(userId).select('+transactionPin +pinHistory');
        if (!user) throw new Error('User not found');

        // Check if new PIN matches current PIN
        if (user.transactionPin) {
            const isMatch = await bcrypt.compare(pin, user.transactionPin);
            if (isMatch) {
                throw new Error('New PIN cannot be the same as your current PIN');
            }
        }

        // Check if new PIN matches any in history (last 5)
        if (user.pinHistory && user.pinHistory.length > 0) {
            for (const oldHashedPin of user.pinHistory) {
                const isMatch = await bcrypt.compare(pin, oldHashedPin);
                if (isMatch) {
                    throw new Error('New PIN cannot be one of your last 5 previously used PINs');
                }
            }
        }

        // Prepare new history
        let newHistory = user.pinHistory || [];
        if (user.transactionPin) {
            newHistory.unshift(user.transactionPin);
            if (newHistory.length > 5) {
                newHistory = newHistory.slice(0, 5);
            }
        }

        const hashedPin = await bcrypt.hash(pin, 10);
        await User.findByIdAndUpdate(userId, {
            transactionPin: hashedPin,
            pinHistory: newHistory,
            isPinSet: true
        });
        return { success: true, message: 'Transaction PIN set successfully' };
    }

    /**
     * Verify a user's transaction PIN
     */
    async verifyPin(userId, pin) {
        const user = await User.findById(userId).select('+transactionPin');
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
        await this.verifyPin(userId, oldPin);
        return this.setPin(userId, newPin);
    }
}

module.exports = new PinService();
