const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { encryptSecret, decryptSecret, isEncrypted } = require('./crypto');

const PURPOSE = 'broadband_verification';
const ISSUER = 'zantara-api';
const AUDIENCE = 'broadband-purchase';
const MAX_CONTEXT_LENGTH = 8192;

const invalidContext = () => {
    const error = new Error('Invalid or expired Broadband verification context');
    error.statusCode = 400;
    error.code = 'INVALID_BROADBAND_CONTEXT';
    return error;
};

const validObjectId = value => typeof value === 'string' && mongoose.Types.ObjectId.isValid(value);

function issueBroadbandVerificationContext({ user, ttlSeconds, jti = crypto.randomUUID(), claims }) {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
    const token = jwt.sign({
        purpose: PURPOSE,
        authVersion: Number.isSafeInteger(user.authVersion) ? user.authVersion : 0,
        ...claims
    }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        issuer: ISSUER,
        audience: AUDIENCE,
        subject: String(user._id || user.id),
        jwtid: jti,
        expiresIn: ttlSeconds
    });
    return encryptSecret(token);
}

function verifyBroadbandVerificationContext(context, { user, maxTtlSeconds, ignoreExpiration = false }) {
    try {
        if (typeof context !== 'string' || context.length > MAX_CONTEXT_LENGTH || !isEncrypted(context)) {
            throw invalidContext();
        }
        const token = decryptSecret(context, { silent: true });
        if (!token || isEncrypted(token)) throw invalidContext();

        const decoded = jwt.verify(token, process.env.JWT_SECRET, {
            algorithms: ['HS256'],
            issuer: ISSUER,
            audience: AUDIENCE,
            ignoreExpiration
        });
        const userId = String(user._id || user.id);
        const authVersion = Number.isSafeInteger(user.authVersion) ? user.authVersion : 0;
        const duration = decoded.exp - decoded.iat;
        const requiredIds = ['canonicalServiceId', 'serviceIdentityId', 'offerId', 'providerId'];

        if (decoded.purpose !== PURPOSE || decoded.sub !== userId || decoded.authVersion !== authVersion
            || !Number.isSafeInteger(decoded.iat) || !Number.isSafeInteger(decoded.exp) || decoded.exp <= decoded.iat
            || !Number.isSafeInteger(duration) || duration <= 0 || duration > maxTtlSeconds
            || typeof decoded.jti !== 'string' || !decoded.jti
            || requiredIds.some(key => !validObjectId(decoded[key]))
            || typeof decoded.identifier !== 'string' || !decoded.identifier
            || !['plan', 'amount'].includes(decoded.purchaseMode)
            || (decoded.purchaseMode === 'plan'
                && (!validObjectId(decoded.planId) || decoded.planId !== decoded.canonicalServiceId))
            || (decoded.purchaseMode === 'amount' && decoded.planId !== undefined)
            || !['none', 'optional', 'required'].includes(decoded.verificationMode)
            || typeof decoded.verificationEvidenceRequired !== 'boolean'
            || typeof decoded.providerCode !== 'string' || !decoded.providerCode
            || typeof decoded.providerServiceCode !== 'string' || !decoded.providerServiceCode
            || !Number.isFinite(decoded.providerAmount) || decoded.providerAmount <= 0
            || !Number.isSafeInteger(decoded.identityUpdatedAt) || decoded.identityUpdatedAt < 0
            || !Number.isSafeInteger(decoded.offerUpdatedAt) || decoded.offerUpdatedAt < 0
            || !Number.isSafeInteger(decoded.providerRoutingVersion) || decoded.providerRoutingVersion < 1
            || !Number.isFinite(decoded.quotedPrice) || decoded.quotedPrice <= 0
            || typeof decoded.contactPhone !== 'string' || !decoded.contactPhone.trim()
            || (decoded.purchaseMode === 'amount' && (!Number.isFinite(decoded.amount) || decoded.amount <= 0))
            || (decoded.purchaseMode === 'plan' && decoded.amount !== undefined)
            || (decoded.verificationEvidenceRequired
                && (typeof decoded.verificationReference !== 'string' || !decoded.verificationReference.trim()))) {
            throw invalidContext();
        }
        return decoded;
    } catch (error) {
        if (error?.code === 'INVALID_BROADBAND_CONTEXT') throw error;
        throw invalidContext();
    }
}

module.exports = {
    issueBroadbandVerificationContext,
    verifyBroadbandVerificationContext
};
