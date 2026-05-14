const Notification = require('../models/Notification');
const User = require('../models/User');
const { sendEmail } = require('../utils/mailer');
const { sendSMS } = require('../utils/sms');
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
                    try {
                        const response = JSON.parse(chunks);
                        if (response.errors) {
                            console.error(`[Push Error] Expo API returned errors:`, JSON.stringify(response.errors));
                        } else {
                            console.log(`[Push Success] Expo Response:`, JSON.stringify(response.data));
                        }
                        resolve(response);
                    } catch (e) {
                        console.log(`[Push] Raw Response: ${chunks}`);
                        resolve(chunks);
                    }
                });
            });
            req.on('error', (e) => {
                console.error('[Push] Network Error (Possible Render Timeout):', e.message);
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
    async sendEmail(to, subject, html, activityType = null) {
        try {
            await sendEmail(to, subject, html, activityType);
        } catch (err) {
            console.error('Email notification error:', err.message);
        }
    }

    /**
     * Send an SMS notification (Wrapper for existing SMS utility)
     */
    async sendSMS(phone, message, activityType = null) {
        try {
            await sendSMS(phone, message, activityType);
        } catch (err) {
            console.error('SMS notification error:', err.message);
        }
    }

    /**
     * Send both in-app, email and SMS
     */
    async notify(user, { title, message, type, metadata, emailHtml, emailSubject, smsMessage, activityType }) {
        // 1. In-App & Push
        await this.sendInApp(user._id, { title, message, type, metadata });

        // 2. Email
        if (user.email && emailHtml) {
            await this.sendEmail(user.email, emailSubject || title, emailHtml, activityType);
        }

        // 3. SMS
        if (user.phone && smsMessage) {
            await this.sendSMS(user.phone, smsMessage, activityType);
        }
    }

    /**
     * Diagnostic tool to verify backend configuration without exposing full secrets
     */
    async getDiagnostics() {
        const mask = (str) => {
            if (!str || str === 'mock') return 'NOT SET';
            if (str.length < 8) return 'SET (Short)';
            return `${str.substring(0, 4)}****${str.substring(str.length - 4)}`;
        };

        return {
            push: {
                provider: 'Expo',
                host: 'exp.host'
            },
            email: {
                user: process.env.MAIL_USER || 'NOT SET',
                pass: process.env.MAIL_PASS ? 'PRESENT (Masked)' : 'MISSING',
                host: 'smtp.gmail.com'
            },
            sms: {
                provider: 'Termii',
                apiKey: mask(process.env.TERMII_API_KEY),
                senderId: process.env.TERMII_SENDER_ID || 'Zantara'
            },
            env: process.env.NODE_ENV || 'development'
        };
    }
}

module.exports = new NotificationService();
