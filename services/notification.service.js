const Notification = require('../models/Notification');
const { sendEmail } = require('../utils/mailer');

class NotificationService {
    /**
     * Send an in-app notification
     */
    async sendInApp(userId, { title, message, type, metadata }) {
        try {
            const notification = await Notification.create({
                userId, title, message, type, metadata
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
