const User = require('../models/User');
const { sendEmail } = require('../utils/mailer');

/**
 * Sends a notification email to all users with the 'superAdmin' role.
 * @param {string} subject 
 * @param {string} html 
 */
const notifySuperAdmins = async (subject, html) => {
    try {
        const superAdmins = await User.find({ role: 'superAdmin' }).select('email');
        const emails = superAdmins.map(admin => admin.email).filter(email => email);

        if (emails.length === 0) {
            console.log('No superAdmins found to notify.');
            return;
        }

        const promises = emails.map(email => sendEmail(email, subject, html));
        await Promise.all(promises);
        
        console.log(`Notification sent to ${emails.length} superAdmins: ${subject}`);
    } catch (error) {
        console.error('Failed to notify superAdmins:', error);
    }
};

module.exports = { notifySuperAdmins };
