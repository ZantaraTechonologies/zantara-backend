/**
 * BasePaymentAdapter
 * Standard abstract base class for all payment gateway adapters in Zantara.
 */
class BasePaymentAdapter {
    constructor(gatewayConfig = {}) {
        this.config = gatewayConfig;
        this.code = gatewayConfig.code || 'unknown';
        this.name = gatewayConfig.name || 'Unknown';
        this.environment = gatewayConfig.environment || 'test';
        this.baseUrl = (gatewayConfig.baseUrl || '').replace(/\/$/, '');
        this.publicKey = gatewayConfig.publicKey || '';
        this.secretKey = gatewayConfig.secretKey || '';
        this.webhookSecret = gatewayConfig.webhookSecret || '';
        this.supportedChannels = gatewayConfig.supportedChannels || [];
        this.metadata = gatewayConfig.metadata || {};
    }

    /**
     * Initializes a payment session with the gateway.
     * @param {Object} params
     * @param {Object} params.user User document or { _id, email, phone, name }
     * @param {number} params.amount Amount in Naira (float/integer)
     * @param {string} params.channel Payment channel e.g. 'card', 'bank_transfer', 'ussd'
     * @param {string} params.reference Unique Zantara transaction reference
     * @param {string} params.callbackUrl Browser return/redirect URL
     * @param {Object} params.metadata Custom metadata object
     * @returns {Promise<{ success: boolean, authorizationUrl: string, reference: string, accessCode?: string, raw?: any }>}
     */
    async initializePayment(params) {
        throw new Error(`initializePayment() must be implemented by ${this.constructor.name}`);
    }

    /**
     * Performs a server-to-server query to verify payment status with the gateway.
     * @param {string} reference Zantara transaction reference or gateway reference
     * @returns {Promise<{
     *   success: boolean,
     *   status: 'success' | 'failed' | 'pending',
     *   reference: string,
     *   providerTransactionId?: string,
     *   amount: number,
     *   currency: string,
     *   message?: string,
     *   raw?: any
     * }>}
     */
    async verifyPayment(reference) {
        throw new Error(`verifyPayment() must be implemented by ${this.constructor.name}`);
    }

    /**
     * Verifies the authenticity of an incoming webhook using HMAC or signature header.
     * @param {Object} headers HTTP request headers
     * @param {Buffer|string} rawBody Raw request body buffer/string
     * @returns {boolean} true if signature is valid, false otherwise
     */
    verifyWebhookSignature(headers, rawBody) {
        throw new Error(`verifyWebhookSignature() must be implemented by ${this.constructor.name}`);
    }

    /**
     * Normalizes a validated webhook payload into standard Zantara format.
     * @param {Object} payload Parsed webhook JSON object
     * @returns {{
     *   eventId: string,
     *   eventType: string,
     *   status: 'success' | 'failed' | 'pending',
     *   reference: string,
     *   providerTransactionId?: string,
     *   amount: number,
     *   currency: string,
     *   userId?: string,
     *   metadata?: any,
     *   raw: any
     * }}
     */
    normalizeWebhook(payload) {
        throw new Error(`normalizeWebhook() must be implemented by ${this.constructor.name}`);
    }

    /**
     * Tests connectivity to the gateway API without charging.
     * @returns {Promise<{ success: boolean, message: string, balance?: number }>}
     */
    async testConnection() {
        throw new Error(`testConnection() must be implemented by ${this.constructor.name}`);
    }
}

module.exports = BasePaymentAdapter;
