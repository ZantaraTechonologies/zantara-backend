const Notification = require('../models/Notification');
const Broadcast = require('../models/Broadcast');
const { sendResponse } = require('../utils/response');

const getMyNotifications = async (req, res) => {
    try {
        const userRole = req.user.role || 'user';
        
        // Fetch user's direct notifications
        const notifications = await Notification.find({ userId: req.user.id })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
            
        // Fetch active global broadcasts targeting this user's role (or 'all')
        const broadcasts = await Broadcast.find({
            active: true,
            $or: [{ target: 'all' }, { target: userRole }],
            $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }]
        })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();
        
        // Format broadcasts to match notification schema layout for frontend
        const formattedBroadcasts = broadcasts.map(b => ({
            _id: 'broadcast_' + b._id,
            title: b.title,
            message: b.message,
            type: b.type === 'critical' ? 'system' : 'info', 
            broadcastType: b.type, // Explicitly pass the true broadcast type for the dashboard filters
            isRead: false, // We could track read state per user in a separate collection, or leave as false
            createdAt: b.createdAt,
            isBroadcast: true
        }));

        // Merge and sort
        const merged = [...formattedBroadcasts, ...notifications].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        return sendResponse(res, { data: merged.slice(0, 50) });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const markAsRead = async (req, res) => {
    try {
        const { id } = req.params;
        if (id.startsWith('broadcast_')) {
             return sendResponse(res, { message: 'Broadcast marked as read (client-side)' });
        }
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

// --- Admin Controls --- 
const sendBroadcast = async (req, res) => {
    try {
        const { title, message, type, target, expiresAt } = req.body;
        
        if (!title || !message) {
            return sendResponse(res, { status: 400, success: false, message: 'Title and message are required' });
        }
        
        const broadcast = new Broadcast({
            title,
            message,
            type: type || 'info',
            target: target || 'all',
            createdBy: req.user.id,
            expiresAt
        });
        
        await broadcast.save();
        return sendResponse(res, { data: broadcast, message: 'Broadcast initiated successfully' });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const getAdminBroadcasts = async (req, res) => {
    try {
        const broadcasts = await Broadcast.find()
            .populate('createdBy', 'name email firstName lastName')
            .sort({ createdAt: -1 })
            .limit(100);
            
        // Map for frontend 
        const formatted = broadcasts.map(b => ({
            id: b._id,
            title: b.title,
            message: b.message,
            type: b.type,
            target: b.target,
            active: b.active,
            sentBy: b.createdBy ? `${b.createdBy.firstName || ''} ${b.createdBy.lastName || b.createdBy.name || ''}`.trim() || 'System Admin' : 'System Admin',
            createdAt: b.createdAt
        }));
            
        return sendResponse(res, { data: formatted });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const deleteBroadcast = async (req, res) => {
    try {
         await Broadcast.findByIdAndDelete(req.params.id);
         return sendResponse(res, { message: 'Broadcast deleted' });
    } catch (err) {
         return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const toggleBroadcastStatus = async (req, res) => {
    try {
        const broadcast = await Broadcast.findById(req.params.id);
        if (!broadcast) return sendResponse(res, { status: 404, success: false, message: 'Broadcast not found' });
        
        broadcast.active = !broadcast.active;
        await broadcast.save();
        
        return sendResponse(res, { data: broadcast, message: `Broadcast has been ${broadcast.active ? 'activated' : 'deactivated'}` });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

module.exports = { 
    getMyNotifications, 
    markAsRead, 
    markAllAsRead,
    sendBroadcast,
    getAdminBroadcasts,
    deleteBroadcast,
    toggleBroadcastStatus
};
