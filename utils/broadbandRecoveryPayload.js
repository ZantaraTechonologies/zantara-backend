const { decryptSecretStrict } = require('./crypto');

const ALLOWED_KEYS = new Set([
    'serviceID',
    'variation_code',
    'identifier',
    'amount',
    'phone',
    'verification_reference'
]);

const nonBlankString = value => typeof value === 'string' && value.trim().length > 0;

function isBroadbandRecoveryPayloadValid(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (Object.keys(payload).some(key => !ALLOWED_KEYS.has(key))) return false;
    if (!nonBlankString(payload.serviceID)
        || !nonBlankString(payload.variation_code)
        || !nonBlankString(payload.identifier)
        || !Number.isFinite(payload.amount)
        || payload.amount <= 0
        || !nonBlankString(payload.phone)) {
        return false;
    }
    return payload.verification_reference === undefined
        || nonBlankString(payload.verification_reference);
}

function decodeBroadbandRecoveryPayload(value, strictDecrypt = decryptSecretStrict) {
    const decrypted = strictDecrypt(value);
    if (!decrypted) return { ok: false, reason: 'encryption' };

    let payload;
    try {
        payload = JSON.parse(decrypted);
    } catch (_) {
        return { ok: false, reason: 'schema' };
    }
    return isBroadbandRecoveryPayloadValid(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'schema' };
}

module.exports = {
    decodeBroadbandRecoveryPayload,
    isBroadbandRecoveryPayloadValid
};
