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
        const hashedPin = await bcrypt.hash(pin, 10);
        await User.findByIdAndUpdate(userId, {
            transactionPin: hashedPin,
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
