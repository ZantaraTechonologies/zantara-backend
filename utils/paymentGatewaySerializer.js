'use strict';

/**
 * Payment Gateway Serializer
 *
 * Sanitizes PaymentGateway documents before any API or UI exposure.
 * SECURITY POLICY:
 *   - secretKey and webhookSecret MUST NEVER appear in any API response,
 *     log message, or error output — not even as masked prefix/suffix fragments.
 *   - publicKey may be returned only where genuinely required by a payment form.
 *   - Credential presence is communicated via boolean indicators only:
 *       secretKeyConfigured: true | false
 *       webhookSecretConfigured: true | false
 */

/**
 * Sanitizes a PaymentGateway document for Admin API responses.
 * Exposes configuration metadata, health, and boolean credential indicators.
 * NEVER exposes raw, decrypted, or masked values of secretKey / webhookSecret.
 *
 * @param {object} gateway - Mongoose document or plain object
 * @returns {object} Safe admin representation
 */
function sanitizePaymentGateway(gateway) {
    if (!gateway) return null;
    const doc = gateway.toObject ? gateway.toObject() : { ...gateway };

    return {
        _id: doc._id,
        name: doc.name,
        code: doc.code,
        adapterType: doc.adapterType,
        status: doc.status,
        environment: doc.environment,
        isDefault: !!doc.isDefault,
        priority: doc.priority || 1,
        // Public key is safe to return — it is non-secret by design (payment form embed)
        publicKey: doc.publicKey || '',
        baseUrl: doc.baseUrl || '',
        supportedChannels: doc.supportedChannels || [],
        metadata: doc.metadata || {},
        lastHealthCheck: doc.lastHealthCheck || { status: 'unknown' },
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        // Boolean credential indicators — no prefix, suffix, or fragment of the actual secret
        secretKeyConfigured: !!(doc.secretKey && doc.secretKey.length > 0),
        webhookSecretConfigured: !!(doc.webhookSecret && doc.webhookSecret.length > 0)
    };
}

/**
 * Sanitizes a PaymentGateway for public client consumption (Web / Mobile).
 * Only returns the minimum fields needed to render a payment option selector.
 * Strips ALL credential indicators, health details, and internal metadata.
 *
 * @param {object} gateway - Mongoose document or plain object
 * @returns {object} Safe client representation
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
    sanitizePaymentGateway,
    sanitizePaymentGatewayForClient
};
