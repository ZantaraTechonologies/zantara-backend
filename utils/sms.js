/**
 * SMS Gateway Utility
 * 
 * Integrated with Termii (https://termii.com)
 * Required ENV variables:
 * - TERMII_API_KEY
 * - TERMII_SENDER_ID (Default: Zantara)
 */

const axios = require('axios');

const sendSMS = async (phone, message) => {
    try {
        const TERMII_API_KEY = process.env.TERMII_API_KEY;
        const SENDER_ID = process.env.TERMII_SENDER_ID || "Zantara";

        // ALWAYS log to console during development 
        console.log(`[SMS Trace] ${phone}: ${message}`);

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
        
        console.log(`[SMS Success] Termii Response:`, response.data);
        return { success: true, data: response.data };

    } catch (error) {
        const errorData = error.response?.data || error.message;
        console.error('[SMS Error] Termii:', errorData);
        return { success: false, error: errorData };
    }
};

module.exports = { sendSMS };

