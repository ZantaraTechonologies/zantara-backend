const nodemailer = require('nodemailer')
const settingsService = require('../services/settings.service');
const dns = require('dns');

const sendEmail = async (to, subject, html, activityType = null) => {
    if (activityType) {
        const notificationSettings = await settingsService.getSetting('NOTIFICATION_SETTINGS', {});
        if (notificationSettings?.email && notificationSettings.email[activityType] === false) {
            console.log(`[Email Skipped] Activity '${activityType}' is disabled by Admin.`);
            return null;
        }
    }

    try {
        // Manually resolve to IPv4 to bypass Render's IPv6 issues
        const { address } = await dns.promises.lookup('smtp.gmail.com', { family: 4 });
        console.log(`[Email] Resolved smtp.gmail.com to IPv4: ${address}`);

        const transporter = nodemailer.createTransport({
            host: address,
            port: 587,
            secure: false,
            auth: {
                user: process.env.MAIL_USER,
                pass: process.env.MAIL_PASS
            },
            tls: {
                servername: 'smtp.gmail.com', // Required when using IP address as host
                rejectUnauthorized: false
            },
            connectionTimeout: 10000,
        })

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