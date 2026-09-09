const { decryptSecret, isEncrypted } = require('./crypto');

/**
 * Masks a secret string (e.g. sk_test_1234567890 -> sk_t...7890)
 */
function maskSecret(val) {
    if (!val || typeof val !== 'string') return '';
    const plaintext = isEncrypted(val) ? decryptSecret(val) : val;
    if (plaintext.length <= 8) return '********';
    return `${plaintext.slice(0, 4)}...${plaintext.slice(-4)}`;
}

/**
 * Sanitizes a PaymentGateway document for Admin presentation or API responses.
 * Never leaks raw or decrypted secretKey or webhookSecret.
 */
function sanitizePaymentGateway(gateway) {
    if (!gateway) return null;
    const doc = gateway.toObject ? gateway.toObject() : { ...gateway };

    const hasSecretKey = !!doc.secretKey;
    const hasWebhookSecret = !!doc.webhookSecret;

    return {
        _id: doc._id,
        name: doc.name,
        code: doc.code,
        adapterType: doc.adapterType,
        status: doc.status,
        environment: doc.environment,
        isDefault: !!doc.isDefault,
        priority: doc.priority || 1,
        publicKey: doc.publicKey || '',
        baseUrl: doc.baseUrl || '',
        supportedChannels: doc.supportedChannels || [],
        metadata: doc.metadata || {},
        lastHealthCheck: doc.lastHealthCheck || { status: 'unknown' },
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        // Credential indicators (never raw secrets)
        hasSecretKey,
        maskedSecretKey: hasSecretKey ? maskSecret(doc.secretKey) : '',
        hasWebhookSecret,
        maskedWebhookSecret: hasWebhookSecret ? maskSecret(doc.webhookSecret) : ''
    };
}

/**
 * Sanitizes a PaymentGateway for public client consumption (Web / Mobile).
 * Completely strips any credential indicators, internal health details, or sensitive metadata.
 */
function sanitizePaymentGatewayForClient(gateway) {
    if (!gateway) return null;
    const doc = gateway.toObject ? gateway.toObject() : { ...gateway };

    return {
        code: doc.code,
        name: doc.name,
        supportedChannels: doc.supportedChannels || [],
        isDefault: !!doc.isDefault,
        environment: doc.environment
    };
}

module.exports = {
    maskSecret,
    sanitizePaymentGateway,
    sanitizePaymentGatewayForClient
};
