const nodemailer = require('nodemailer')
const settingsService = require('../services/settings.service');

const sendEmail = async (to, subject, html, activityType = null) => {
    if (activityType) {
        const notificationSettings = await settingsService.getSetting('NOTIFICATION_SETTINGS', {});
        if (notificationSettings?.email && notificationSettings.email[activityType] === false) {
            console.log(`[Email Skipped] Activity '${activityType}' is disabled by Admin.`);
            return null;
        }
    }

    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true, // true for 465, false for other ports
        auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_PASS
        },
        family: 4, // Force IPv4 to avoid ENETUNREACH on IPv6-enabled environments like Render
        connectionTimeout: 10000, // 10 seconds
        greetingTimeout: 5000,    // 5 seconds
        socketTimeout: 10000,     // 10 seconds
    })

    try {
        const info = await transporter.sendMail({
            from: `"Zantara VTU" <${process.env.MAIL_USER}>`,
            to,
            subject,
            html
        })
        console.log("Email sent successfully:", info.messageId);
        return info;
    } catch (error) {
        console.error("Email notification skipped (Connection Issue):", error.message);
        return null; // Don't throw, just fail silently
    }
}

module.exports = { sendEmail }