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

const normalizeTermiiPhone = phone => {
    const value = String(phone || '').trim();
    const localMatch = value.match(/^0([789]\d{9})$/);
    if (localMatch) return `234${localMatch[1]}`;

    const internationalMatch = value.match(/^\+?234([789]\d{9})$/);
    if (internationalMatch) return `234${internationalMatch[1]}`;

    throw new Error('Unsupported Nigerian phone number format');
};

const sendSMS = async (phone, message, activityType = null) => {
    try {
        if (activityType) {
            const notificationSettings = await settingsService.getSetting('NOTIFICATION_SETTINGS', {});
            if (notificationSettings?.sms && notificationSettings.sms[activityType] === false) {
                console.log(`[SMS Skipped] Activity '${activityType}' is disabled by Admin.`);
                return { success: true, delivered: false, message: 'SMS disabled by admin settings' };
            }
        }

        const TERMII_API_KEY = process.env.TERMII_API_KEY;
        const SENDER_ID = process.env.TERMII_SENDER_ID || "Zantara";

        // PRIVACY: never log the full recipient number or the message body.
        // Only a masked phone + content metadata are written to console.
        console.log(`[SMS Trace] To: ${maskPhone(phone)}, Sender: ${SENDER_ID}, Activity: ${activityType || 'general'}, Length: ${String(message).length}`);

        const formattedPhone = normalizeTermiiPhone(phone);

        if (!TERMII_API_KEY || TERMII_API_KEY === 'mock') {
            console.log(`[SMS Mock] Termii API Key not set. Message not sent via SMS.`);
            return { success: true, delivered: false, message: 'SMS logged to console (Mock Mode)' };
        }

        const payload = {
            to: formattedPhone,
            from: SENDER_ID,
            sms: message,
            type: "plain",
            channel: "generic",
            api_key: TERMII_API_KEY
        };

        const response = await axios.post('https://api.ng.termii.com/api/sms/send', payload, { timeout: 30000 });
        
        // Log only response metadata (never the echoed message content)
        console.log(`[SMS Success] Termii status: ${response.status}, message_id: ${response.data?.message_id || response.data?.code || 'n/a'}`);
        return { success: true, delivered: true, data: response.data };

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

module.exports = { normalizeTermiiPhone, sendSMS };

