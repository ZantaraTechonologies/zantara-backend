const Notification = require('../models/Notification');
const Broadcast = require('../models/Broadcast');
const { sendResponse } = require('../utils/response');
const { sendEmail } = require('../utils/mailer');
const { sendSMS } = require('../utils/sms');
const User = require('../models/User');

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

        // 🔔 Background task: Send push notifications to all matching users (ALL broadcast types)
        (async () => {
            try {
                const notificationService = require('../services/notification.service');

                // Build role filter based on target
                let roleFilter = {};
                if (target === 'user') roleFilter = { role: 'user' };
                else if (target === 'agent') roleFilter = { role: 'agent' };
                // 'all' => no role filter

                // Fetch all users who have a valid Expo push token
                const usersWithToken = await User.find({
                    ...roleFilter,
                    pushToken: { $exists: true, $ne: null, $regex: /^ExponentPushToken/ }
                }, 'pushToken name').lean();

                const tokenCount = usersWithToken.length;
                console.log(`[Broadcast Push] Sending push to ${tokenCount} users (target: ${target || 'all'}, type: ${type || 'info'})...`);

                const pushPromises = usersWithToken.map(user =>
                    notificationService.sendPush(user.pushToken, {
                        title,
                        body: message,
                        data: { type: 'broadcast', broadcastType: type || 'info' },
                        priority: (type === 'critical' || type === 'warning') ? 'high' : 'default',
                    }).catch(err => console.error(`[Broadcast Push] Failed for user ${user._id}:`, err.message))
                );

                await Promise.allSettled(pushPromises);
                console.log(`[Broadcast Push] Completed push dispatch to ${tokenCount} users.`);
            } catch (err) {
                console.error('[Broadcast Push] Global push dispatch error:', err);
            }
        })();

        // 🟢 Background task: Send emails + SMS if broadcast is critical
        if (type === 'critical') {
            (async () => {
                try {
                    const users = await User.find({ 
                        $or: [
                            { email: { $exists: true, $ne: null } },
                            { phone: { $exists: true, $ne: null } }
                        ]
                    }, 'email phone name').lean();
                    const count = users.length;
                    
                    console.log(`[Critical Broadcast] Starting email/SMS dispatch to ${count} users...`);
                    
                    for (const user of users) {
                        try {
                            if (user.email) {
                                const html = `
                                    <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                                        <h2 style="color: #e11d48;">${title}</h2>
                                        <p>${message}</p>
                                        <hr style="margin: 20px 0; border: 0; border-top: 1px solid #eee;">
                                        <p style="font-size: 12px; color: #666;">This is an automated critical update from Zantara VTU.</p>
                                    </div>
                                `;
                                await sendEmail(user.email, `CRITICAL: ${title}`, html, 'critical_system');
                            }
                            if (user.phone) {
                                await sendSMS(user.phone, `CRITICAL UPDATE: ${title}. ${message}`, 'critical_system');
                            }
                        } catch (e) {
                            console.error(`Failed to send broadcast to ${user.email || user.phone}:`, e.message);
                        }
                    }
                    console.log(`[Critical Broadcast] Finished email/SMS dispatch.`);
                } catch (err) {
                    console.error('[Critical Broadcast] Global dispatch error:', err);
                }
            })();
        }

        return sendResponse(res, { data: broadcast, message: 'Broadcast initiated successfully' + (type === 'critical' ? ' and email/SMS dispatch started' : ' and push notifications sent') });
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

const getNotificationDiagnostics = async (req, res) => {
    try {
        const notificationService = require('../services/notification.service');
        const stats = await notificationService.getDiagnostics();
        
        // Also check DB connectivity and user token stats
        const usersWithToken = await User.countDocuments({ pushToken: { $ne: null, $regex: /^ExponentPushToken/ } });
        const totalUsers = await User.countDocuments();
        
        return sendResponse(res, { 
            data: { 
                ...stats,
                database: {
                    totalUsers,
                    usersWithPushTokens: usersWithToken
                }
            } 
        });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const sendTestNotification = async (req, res) => {
    try {
        const { channel } = req.body; // 'all', 'push', 'sms', 'email'
        const user = await User.findById(req.user.id);
        const notificationService = require('../services/notification.service');

        const testData = {
            title: 'Zantara Test Alert',
            message: `This is a test notification from Zantara sent at ${new Date().toLocaleTimeString()}.`,
            type: 'system',
            smsMessage: `Zantara Test: Your notification system is working! ${new Date().toLocaleTimeString()}`,
            emailSubject: 'Zantara Notification Test',
            emailHtml: `<h2>System Test</h2><p>This is a test email to verify your SMTP configuration is working correctly.</p><p>Sent at: ${new Date().toLocaleString()}</p>`,
            activityType: 'critical_system' // Use a high-priority toggle
        };

        if (channel === 'push' || channel === 'all' || !channel) {
            await notificationService.sendInApp(user._id, testData);
        }

        if ((channel === 'email' || channel === 'all') && user.email) {
            await notificationService.sendEmail(user.email, testData.emailSubject, testData.emailHtml, testData.activityType);
        }

        if ((channel === 'sms' || channel === 'all') && user.phone) {
            await notificationService.sendSMS(user.phone, testData.smsMessage, testData.activityType);
        }

        return sendResponse(res, { message: `Test initiated for channel: ${channel || 'all'}. Check your logs and device.` });
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
    toggleBroadcastStatus,
    getNotificationDiagnostics,
    sendTestNotification
};
