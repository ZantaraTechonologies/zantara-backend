const pinService = require('../services/pin.service');
const { sendResponse } = require('../utils/response');
const notificationService = require('../services/notification.service');

const setPin = async (req, res) => {
    try {
        const { pin } = req.body;
        const userId = req.user.id;

        if (!pin) {
            return sendResponse(res, { status: 400, success: false, message: 'PIN is required' });
        }

        const result = await pinService.setPin(userId, pin);
 
        // Notify User
        await notificationService.sendInApp(userId, {
            title: 'Transaction PIN Set',
            message: 'Your transaction PIN has been successfully created. If you didn\'t do this, please contact support immediately.',
            type: 'security'
        });
 
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
 
        // Notify User
        await notificationService.sendInApp(userId, {
            title: 'Transaction PIN Updated',
            message: 'Your transaction PIN has been successfully changed. If this wasn\'t you, please lock your account immediately.',
            type: 'security'
        });
 
        return sendResponse(res, { message: result.message });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

module.exports = { setPin, changePin };
