const mongoose = require('mongoose');
require('dotenv').config();
const notificationService = require('../services/notification.service');
const User = require('../models/User');
const settingsService = require('../services/settings.service');

async function test() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        // 1. Check Push Token Stats
        const usersWithToken = await User.countDocuments({ pushToken: { $ne: null, $regex: /^ExponentPushToken/ } });
        const totalUsers = await User.countDocuments();
        console.log(`\n--- Push Notification Stats ---`);
        console.log(`Total Users: ${totalUsers}`);
        console.log(`Users with valid Expo Push Tokens: ${usersWithToken}`);

        if (usersWithToken > 0) {
            const sampleUser = await User.findOne({ pushToken: { $ne: null, $regex: /^ExponentPushToken/ } });
            console.log(`Sample user with token: ${sampleUser.phone} (${sampleUser.pushToken})`);
        } else {
            console.warn('No users found with a valid push token. Push notifications cannot be tested on real devices.');
        }

        // 2. Check Admin Settings
        const notificationSettings = await settingsService.getSetting('NOTIFICATION_SETTINGS', {});
        console.log(`\n--- Admin Notification Settings ---`);
        console.log(JSON.stringify(notificationSettings, null, 2));

        // 3. Test Email (Dry run or check config)
        console.log(`\n--- Email Configuration ---`);
        console.log(`MAIL_USER: ${process.env.MAIL_USER ? 'SET' : 'NOT SET'}`);
        console.log(`MAIL_PASS: ${process.env.MAIL_PASS ? 'SET' : 'NOT SET'}`);

        // 4. Test SMS (Check config)
        console.log(`\n--- SMS Configuration ---`);
        console.log(`TERMII_API_KEY: ${process.env.TERMII_API_KEY ? 'SET' : 'NOT SET'}`);
        if (!process.env.TERMII_API_KEY || process.env.TERMII_API_KEY === 'mock') {
            console.log('SMS is currently in MOCK mode (logging to console only).');
        }

        process.exit(0);
    } catch (err) {
        console.error('Test failed:', err);
        process.exit(1);
    }
}

test();
