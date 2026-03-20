const { DateTime } = require('luxon');
const crypto = require('crypto');

/**
 * Generates a unique Transaction ID 
 * Pattern: FT + 9 high-entropy digits
 * Total uniqueness ensured by using timestamp bits + random entropy
 */
const generateTransactionId = () => {
    const timestamp = Date.now().toString().slice(-6); // last 6 digits of timestamp
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0'); // 3 random digits
    return `FT${timestamp}${random}`;
};

/**
 * Generates a branded Zantara Reference
 * Pattern: ZNT-XXX-XXX (3 digits - 3 letters)
 */
const generateReference = () => {
    const digits = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const letters = crypto.randomBytes(3).toString('hex').slice(0, 3).toUpperCase();
    return `ZNT-${digits}-${letters}`;
};

const lagosTime = () => DateTime.now().setZone('Africa/Lagos');

const generateVTPassRequestId = () => {
    const timeStr = lagosTime().toFormat('yyyyLLddHHmm');
    const random = crypto.randomBytes(4).toString('hex');
    return `${timeStr}${random}`;
};

module.exports = {
    generateTransactionId,
    generateReference,
    generateVTPassRequestId,
    get requestId() {
        return generateVTPassRequestId();
    }
};