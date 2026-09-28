const crypto = require('crypto');

const FINGERPRINT_VERSION = 1;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

const finiteNumber = (value, label) => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
    return number;
};

function buildBroadbandPurchaseIntent(context, request = {}) {
    if (!context || typeof context !== 'object') throw new Error('Broadband verification context is required');

    const amount = context.purchaseMode === 'amount'
        ? finiteNumber(request.amount, 'Broadband purchase amount')
        : null;
    const expectedPrice = finiteNumber(request.expectedPrice, 'Broadband expected price');

    return {
        version: FINGERPRINT_VERSION,
        serviceIdentityId: String(context.serviceIdentityId),
        canonicalServiceId: String(context.canonicalServiceId),
        planId: context.purchaseMode === 'plan' ? String(context.planId) : null,
        identifier: String(context.identifier),
        amount,
        expectedPrice,
        purchaseMode: String(context.purchaseMode),
        verificationJti: String(context.jti),
        verificationReference: context.verificationReference == null
            ? null
            : String(context.verificationReference),
        contactPhone: String(context.contactPhone || '')
    };
}

function createBroadbandRequestFingerprint(context, request) {
    const canonical = JSON.stringify(buildBroadbandPurchaseIntent(context, request));
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function fingerprintsMatch(left, right) {
    if (!FINGERPRINT_PATTERN.test(left || '') || !FINGERPRINT_PATTERN.test(right || '')) return false;
    return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

module.exports = {
    FINGERPRINT_PATTERN,
    buildBroadbandPurchaseIntent,
    createBroadbandRequestFingerprint,
    fingerprintsMatch
};
