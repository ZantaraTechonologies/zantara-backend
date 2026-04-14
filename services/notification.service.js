const Notification = require('../models/Notification');
const User = require('../models/User');
const { sendEmail } = require('../utils/mailer');
const https = require('https');

class NotificationService {
    /**
     * Send an Expo Push Notification to a device
     */
    async sendPush(pushToken, { title, body, data = {} }) {
        if (!pushToken || !pushToken.startsWith('ExponentPushToken')) return;

        const payload = JSON.stringify({
            to: pushToken,
            sound: 'default',
            title,
            body,
            data,
        });

        return new Promise((resolve) => {
            const req = https.request({
                hostname: 'exp.host',
                path: '/--/api/v2/push/send',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Accept-Encoding': 'gzip, deflate',
                }
            }, (res) => {
                res.on('data', () => {});
                res.on('end', () => resolve(null));
            });
            req.on('error', (e) => console.error('[Push] Error:', e.message));
            req.write(payload);
            req.end();
        });
    }

    /**
     * Send an in-app notification + fire-and-forget push if user has token
     */
    async sendInApp(userId, { title, message, type, metadata }) {
        try {
            // PROMINENT LOG FOR DEVELOPMENT (Handy for OTPs when SMS/Push is restricted)
            if (type === 'security') {
                console.log('-------------------------------------------');
                console.log(`[SECURITY NOTIFICATION] User: ${userId}`);
                console.log(`[TITLE]: ${title}`);
                console.log(`[MESSAGE]: ${message}`);
                console.log('-------------------------------------------');
            }

            const notification = await Notification.create({
                userId, title, message, type, metadata
            });

            // Fire-and-forget push notification
            User.findById(userId).select('pushToken').lean().then(user => {
                if (user?.pushToken) {
                    this.sendPush(user.pushToken, {
                        title,
                        body: message,
                        data: { type, ...(metadata || {}) }
                    });
                }
            }).catch(() => {});

            return notification;
        } catch (err) {
            console.error('In-app notification error:', err.message);
        }
    }

    /**
     * Send an email notification (Wrapper for existing mailer)
     */
    async sendEmail(to, subject, html) {
        try {
            await sendEmail(to, subject, html);
        } catch (err) {
            console.error('Email notification error:', err.message);
        }
    }

    /**
     * Send both in-app and email
     */
    async notify(user, { title, message, type, metadata, emailHtml, emailSubject }) {
        await this.sendInApp(user._id, { title, message, type, metadata });
        if (user.email && emailHtml) {
            await this.sendEmail(user.email, emailSubject || title, emailHtml);
        }
    }
}

module.exports = new NotificationService();
