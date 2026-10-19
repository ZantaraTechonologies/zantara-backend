'use strict';

const { isEncrypted, decryptSecretStrict, secretsEqual } = require('./crypto');

function plainMetadata(value) {
    if (value == null) return {};
    if (value instanceof Map) return Object.fromEntries(value.entries());
    if (typeof value?.toObject === 'function') return value.toObject();
    if (typeof value !== 'object' || Array.isArray(value)) {
        const error = new Error('metadata must be an object');
        error.code = 'PAYMENT_GATEWAY_METADATA_INVALID';
        throw error;
    }
    return { ...value };
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
    );
}

function sameCanonicalValue(left, right) {
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function changedMetadataKeys(current = {}, next = {}) {
    return [...new Set([...Object.keys(current), ...Object.keys(next)])]
        .filter(key => !sameCanonicalValue(current[key], next[key]));
}

function paystackCredentialEnvironment(value, kind) {
    if (typeof value !== 'string' || !['public', 'secret'].includes(kind)) return null;
    const resolved = isEncrypted(value) ? decryptSecretStrict(value) : value;
    if (typeof resolved !== 'string') return null;
    const prefix = kind === 'public' ? 'pk_' : 'sk_';
    if (new RegExp(`^${prefix}live_[A-Za-z0-9_]+$`).test(resolved)) return 'live';
    if (new RegExp(`^${prefix}test_[A-Za-z0-9_]+$`).test(resolved)) return 'test';
    return null;
}

function isValidPaystackCredential(value, kind) {
    return paystackCredentialEnvironment(value, kind) !== null;
}

function optionalString(body, field, current, { lower = false } = {}) {
    if (body[field] === undefined) return String(current || '');
    if (typeof body[field] !== 'string') {
        const error = new Error(`${field} must be a string`);
        error.code = 'PAYMENT_GATEWAY_FIELD_INVALID';
        throw error;
    }
    const normalized = body[field].trim();
    return lower ? normalized.toLowerCase() : normalized;
}

function secretChange(storedValue, submittedValue, field) {
    if (submittedValue === undefined || submittedValue === null || submittedValue === '') return false;
    if (typeof submittedValue !== 'string') {
        const error = new Error(`${field} must be a string`);
        error.code = 'PAYMENT_GATEWAY_FIELD_INVALID';
        throw error;
    }
    const normalized = submittedValue.trim();
    if (!normalized) return false;
    if (isEncrypted(normalized) && !decryptSecretStrict(normalized)) {
        const error = new Error(`${field} contains unreadable encrypted data`);
        error.code = 'PAYMENT_GATEWAY_CREDENTIAL_INVALID';
        throw error;
    }
    return !secretsEqual(String(storedValue || ''), normalized);
}

function buildGatewayChangePlan(gateway, body = {}) {
    const currentAdapter = String(gateway.adapterType || '').trim().toLowerCase();
    const currentEnvironment = String(gateway.environment || 'test').trim().toLowerCase();
    const currentMetadata = plainMetadata(gateway.metadata);
    const requestedMetadata = body.metadata === undefined ? null : plainMetadata(body.metadata);
    const mergedMetadata = requestedMetadata === null
        ? currentMetadata
        : { ...currentMetadata, ...requestedMetadata };
    const next = {
        adapterType: optionalString(body, 'adapterType', currentAdapter, { lower: true }),
        baseUrl: optionalString(body, 'baseUrl', gateway.baseUrl),
        publicKey: optionalString(body, 'publicKey', gateway.publicKey),
        environment: optionalString(body, 'environment', currentEnvironment, { lower: true }),
        metadata: mergedMetadata,
    };
    const changes = {
        adapterType: next.adapterType !== currentAdapter,
        baseUrl: next.baseUrl !== String(gateway.baseUrl || '').trim(),
        publicKey: next.publicKey !== String(gateway.publicKey || '').trim(),
        secretKey: secretChange(gateway.secretKey, body.secretKey, 'secretKey'),
        webhookSecret: secretChange(gateway.webhookSecret, body.webhookSecret, 'webhookSecret'),
        environment: next.environment !== currentEnvironment,
        metadata: !sameCanonicalValue(currentMetadata, mergedMetadata),
    };
    const effectiveChanges = Object.keys(changes).filter(field => changes[field]);
    const metadataChanges = changedMetadataKeys(currentMetadata, mergedMetadata);
    const verificationChanges = effectiveChanges.filter(field => [
        'adapterType', 'baseUrl', 'publicKey', 'secretKey', 'webhookSecret', 'environment', 'metadata'
    ].includes(field));
    const paystackVerificationChanges = currentAdapter === 'paystack'
        ? effectiveChanges.filter(field => ['adapterType', 'baseUrl', 'secretKey', 'environment'].includes(field))
        : [];
    return {
        currentAdapter,
        currentEnvironment,
        next,
        changes,
        effectiveChanges,
        metadataChanges,
        verificationChanges,
        paystackVerificationChanges,
        requiresMutationFence: verificationChanges.length > 0,
        noOp: effectiveChanges.length === 0,
    };
}

module.exports = {
    buildGatewayChangePlan,
    plainMetadata,
    canonicalize,
    sameCanonicalValue,
    changedMetadataKeys,
    paystackCredentialEnvironment,
    isValidPaystackCredential,
};
