const pinService = require('../services/pin.service');
const { sendResponse } = require('../utils/response');
const notificationService = require('../services/notification.service');
const ActivityLog = require('../models/ActivityLog');

const setPin = async (req, res) => {
    try {
        const { pin } = req.body;
        const userId = req.user.id;

        if (!pin) {
            return sendResponse(res, { status: 400, success: false, message: 'PIN is required' });
        }

        const result = await pinService.setPin(userId, pin);

        ActivityLog.create({
            userId,
            action: 'SET_TRANSACTION_PIN',
            ipAddress: req.ip,
            device: req.headers['user-agent']
        }).catch(error => console.error('[Security Audit] SET_TRANSACTION_PIN log failed:', error.message));
 
        // Notify User
        await notificationService.sendInApp(userId, {
            title: 'Transaction PIN Set',
            message: 'Your transaction PIN has been successfully created. If you didn\'t do this, please contact support immediately.',
            type: 'security'
        });
 
        return sendResponse(res, { message: result.message });
    } catch (err) {
        return sendResponse(res, { status: err.statusCode || 400, success: false, message: err.message });
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

        ActivityLog.create({
            userId,
            action: 'CHANGE_TRANSACTION_PIN',
            ipAddress: req.ip,
            device: req.headers['user-agent']
        }).catch(error => console.error('[Security Audit] CHANGE_TRANSACTION_PIN log failed:', error.message));
 
        // Notify User
        await notificationService.sendInApp(userId, {
            title: 'Transaction PIN Updated',
            message: 'Your transaction PIN has been successfully changed. If this wasn\'t you, please lock your account immediately.',
            type: 'security'
        });
 
        return sendResponse(res, { message: result.message });
    } catch (err) {
        return sendResponse(res, { status: err.statusCode || 400, success: false, message: err.message });
    }
};

const verifyPin = async (req, res) => {
    try {
        const { pin } = req.body;
        const userId = req.user.id;

        if (!pin) {
            return sendResponse(res, { status: 400, success: false, message: 'PIN is required' });
        }

        await pinService.verifyPin(userId, pin);
        return sendResponse(res, { success: true, message: 'PIN verified successfully' });
    } catch (err) {
        return sendResponse(res, { status: 400, success: false, message: err.message });
    }
};

module.exports = { setPin, changePin, verifyPin };
