/**
 * SMS Gateway Utility
 * Mock implementation that logs OTP to console and returns success.
 * Can be integrated with Termii, Twilio, etc.
 */

const sendSMS = async (phone, message) => {
    try {
        console.log(`[SMS MOCK] Sending to ${phone}: ${message}`);
        
        // In a real integration:
        // const response = await axios.post('https://api.termii.com/api/sms/send', { ... });
        
        return { success: true, message: 'SMS sent successfully (Mock)' };
    } catch (error) {
        console.error('SMS sending error:', error.message);
        return { success: false, message: 'Failed to send SMS' };
    }
};

module.exports = { sendSMS };
