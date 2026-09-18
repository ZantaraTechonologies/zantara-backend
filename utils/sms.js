/**
 * SMS Gateway Utility
 * 
 * Integrated with Termii (https://termii.com)
 * Required ENV variables:
 * - TERMII_API_KEY
 * - TERMII_SENDER_ID (Default: Zantara)
 */

const axios = require('axios');
const settingsService = require('../services/settings.service');
const { maskPhone } = require('./notificationFormatter');

const sendSMS = async (phone, message, activityType = null) => {
    try {
        if (activityType) {
            const notificationSettings = await settingsService.getSetting('NOTIFICATION_SETTINGS', {});
            if (notificationSettings?.sms && notificationSettings.sms[activityType] === false) {
                console.log(`[SMS Skipped] Activity '${activityType}' is disabled by Admin.`);
                return { success: true, message: 'SMS disabled by admin settings' };
            }
        }

        const TERMII_API_KEY = process.env.TERMII_API_KEY;
        const SENDER_ID = process.env.TERMII_SENDER_ID || "Zantara";

        // PRIVACY: never log the full recipient number or the message body.
        // Only a masked phone + content metadata are written to console.
        console.log(`[SMS Trace] To: ${maskPhone(phone)}, Sender: ${SENDER_ID}, Activity: ${activityType || 'general'}, Length: ${String(message).length}`);

        if (!TERMII_API_KEY || TERMII_API_KEY === 'mock') {
            console.log(`[SMS Mock] Termii API Key not set. Message not sent via SMS.`);
            return { success: true, message: 'SMS logged to console (Mock Mode)' };
        }

        // Format phone number to international format if needed (Termii prefers 234...)
        let formattedPhone = phone;
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '234' + formattedPhone.substring(1);
        }

        const payload = {
            to: formattedPhone,
            from: SENDER_ID,
            sms: message,
            type: "plain",
            channel: "generic",
            api_key: TERMII_API_KEY
        };

        const response = await axios.post('https://api.ng.termii.com/api/sms/send', payload);
        
        // Log only response metadata (never the echoed message content)
        console.log(`[SMS Success] Termii status: ${response.status}, message_id: ${response.data?.message_id || response.data?.code || 'n/a'}`);
        return { success: true, data: response.data };

    } catch (error) {
        const errorData = error.response?.data || error.message;
        const errorCode = error.response?.status || error.response?.data?.code || error.code || 'unknown';
        
        if (errorData.code === 404 && errorData.message?.includes('ApplicationSenderId')) {
            console.error('[SMS Error] YOUR SENDER ID IS NOT APPROVED YET.');
            console.error('[SMS Error] ACTION: Register "Zantara" in your Termii dashboard or use "Termii" in your .env for testing.');
        } else {
            // Provider error bodies can echo request content. Never log them
            // because SMS bodies may contain OTPs or other authentication data.
            console.error(`[SMS Error] Termii request failed (code: ${errorCode}, activity: ${activityType || 'general'}).`);
        }
        
        return { success: false, error: errorData };
    }
};

module.exports = { sendSMS };

