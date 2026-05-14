const nodemailer = require('nodemailer')
const settingsService = require('../services/settings.service');
const dns = require('dns');

// Force IPv4 preference for all network calls in this process to fix ENETUNREACH on Render
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

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
        port: 587,
        secure: false, // Use TLS (false for 587, true for 465)
        auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_PASS
        },
        family: 4, // Force IPv4
        connectionTimeout: 10000,
        greetingTimeout: 5000,
        socketTimeout: 10000,
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