const Notification = require('../models/Notification');
const User = require('../models/User');
const { sendEmail } = require('../utils/mailer');
const https = require('https');

class NotificationService {
    /**
     * Send an Expo Push Notification to a device
     */
    async sendPush(pushToken, { title, body, data = {}, priority = 'default' }) {
        if (!pushToken || !pushToken.startsWith('ExponentPushToken')) {
            console.warn(`[Push] Invalid or missing token: ${pushToken}`);
            return;
        }

        const payload = JSON.stringify({
            to: pushToken,
            sound: 'default',
            title,
            body,
            data,
            priority,
        });

        console.log(`[Push] Attempting send to ${pushToken} (Title: ${title})`);

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
                let chunks = '';
                res.on('data', (c) => chunks += c);
                res.on('end', () => {
                    console.log(`[Push] Response: ${chunks}`);
                    resolve(chunks);
                });
            });
            req.on('error', (e) => {
                console.error('[Push] Network Error:', e.message);
                resolve(null);
            });
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

            // Fire-and-forget push notification (now with logging)
            User.findById(userId).select('pushToken').lean().then(user => {
                if (user?.pushToken) {
                    this.sendPush(user.pushToken, {
                        title,
                        body: message,
                        data: { type, ...(metadata || {}) },
                        priority: type === 'security' ? 'high' : 'default'
                    });
                } else {
                    console.warn(`[Push] No token found for user ${userId}`);
                }
            }).catch((err) => {
                console.error(`[Push] Token lookup failed for ${userId}:`, err.message);
            });

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
