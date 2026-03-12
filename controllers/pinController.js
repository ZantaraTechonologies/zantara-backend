const pinService = require('../services/pin.service');
const { sendResponse } = require('../utils/response');

const setPin = async (req, res) => {
    try {
        const { pin } = req.body;
        const userId = req.user.id;

        if (!pin) {
            return sendResponse(res, { status: 400, success: false, message: 'PIN is required' });
        }

        const result = await pinService.setPin(userId, pin);
        return sendResponse(res, { message: result.message });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const changePin = async (req, res) => {
    try {
        const { oldPin, newPin } = req.body;
        const userId = req.user.id;

        if (!oldPin || !newPin) {
            return sendResponse(res, { status: 400, success: false, message: 'Old and new PINs are required' });
        }

        const result = await pinService.changePin(userId, oldPin, newPin);
        return sendResponse(res, { message: result.message });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

module.exports = { setPin, changePin };
