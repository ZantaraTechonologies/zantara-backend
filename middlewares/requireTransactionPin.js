const pinService = require('../services/pin.service');

const requireTransactionPin = async (req, res, next) => {
    const pin = req.body?.pin;
    if (pin === undefined || pin === null || pin === '') {
        return res.status(400).json({ message: 'Transaction PIN is required' });
    }
    if (typeof pin !== 'string') {
        return res.status(400).json({ message: 'Invalid transaction PIN' });
    }

    try {
        await pinService.verifyPin(req.user.id, pin);
    } catch (error) {
        if (error.message === 'Transaction PIN not set' || error.message === 'Invalid transaction PIN') {
            return res.status(400).json({ message: error.message });
        }
        return res.status(500).json({ message: 'Unable to verify transaction PIN' });
    }

    // Financial controllers must never receive or persist the raw PIN.
    delete req.body.pin;
    return next();
};

module.exports = requireTransactionPin;
