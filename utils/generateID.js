const { DateTime } = require('luxon');
const crypto = require('node:crypto');

const ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const randomCharacters = length => {
    const bytes = crypto.randomBytes(length);
    let value = '';
    for (const byte of bytes) value += ID_ALPHABET[byte & 31];
    return value;
};

/**
 * Generates the customer-facing Zantara transaction identifier.
 */
const generateTransactionId = () => {
    return `ZNT-${randomCharacters(12)}`;
};

/**
 * Generates Zantara's internal operational reference.
 */
const generateReference = () => {
    return `ZNT-R-${randomCharacters(16)}`;
};

const lagosTime = () => DateTime.now().setZone('Africa/Lagos');

const generateVTPassRequestId = () => {
    const timeStr = lagosTime().toFormat('yyyyLLddHHmm');
    return `${timeStr}${randomCharacters(8)}`;
};

const generateProviderRequestId = adapterType => {
    return String(adapterType || '').toLowerCase() === 'vtpass'
        ? generateVTPassRequestId()
        : `ZNT-P-${randomCharacters(16)}`;
};

const generatePaymentReference = gatewayCode => {
    const normalizedCode = String(gatewayCode || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (!normalizedCode) throw new Error('Payment gateway code is required');
    return `${normalizedCode}-${randomCharacters(16)}`;
};

module.exports = {
    generateTransactionId,
    generateReference,
    generateVTPassRequestId,
    generateProviderRequestId,
    generatePaymentReference,
    ID_ALPHABET,
    get requestId() {
        return generateVTPassRequestId();
    }
};
