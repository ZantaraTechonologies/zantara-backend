const mongoose = require('mongoose');
require('dotenv').config();
const notificationService = require('../services/notification.service');

async function test() {
    try {
        console.log('--- NOTIFICATION DIAGNOSTICS ---');
        const stats = await notificationService.getDiagnostics();
        console.log(JSON.stringify(stats, null, 2));
        
        console.log('\n--- VERIFYING KEY PRESENCE ---');
        if (stats.sms.apiKey === 'NOT SET') {
            console.warn('WARNING: TERMII_API_KEY is not set in environment.');
        } else {
            console.log('SUCCESS: SMS API Key is present.');
        }

        if (stats.email.pass === 'MISSING') {
            console.warn('WARNING: MAIL_PASS is not set in environment.');
        } else {
            console.log('SUCCESS: Email Password is present.');
        }

        process.exit(0);
    } catch (err) {
        console.error('Test failed:', err);
        process.exit(1);
    }
}

test();
