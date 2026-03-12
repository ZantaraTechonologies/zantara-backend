const Notification = require('../models/Notification');
const { sendResponse } = require('../utils/response');

const getMyNotifications = async (req, res) => {
    try {
        const notifications = await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50);
        return sendResponse(res, { data: notifications });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const markAsRead = async (req, res) => {
    try {
        const { id } = req.params;
        await Notification.findOneAndUpdate({ _id: id, userId: req.user.id }, { isRead: true });
        return sendResponse(res, { message: 'Notification marked as read' });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const markAllAsRead = async (req, res) => {
    try {
        await Notification.updateMany({ userId: req.user.id, isRead: false }, { isRead: true });
        return sendResponse(res, { message: 'All notifications marked as read' });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

module.exports = { getMyNotifications, markAsRead, markAllAsRead };
