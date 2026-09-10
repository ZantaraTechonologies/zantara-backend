'use strict';

const paymentGatewayService = require('../services/paymentGateway.service');

/**
 * POST /api/webhooks/payment/:gatewayCode
 *
 * Unified webhook endpoint for ALL registered payment gateway providers.
 * The gatewayCode URL parameter selects the dedicated adapter; all signature
 * verification, payload normalization and wallet-credit safety is delegated
 * to paymentGatewayService.routeWebhook() — no webhook logic is duplicated here.
 */
const unifiedWebhook = async (req, res) => {
    try {
        const gatewayCode = String(req.params.gatewayCode || '').toLowerCase().trim();

        if (!gatewayCode) {
            return res.status(400).send('gatewayCode is required');
        }

        if (!paymentGatewayService.isSupportedAdapterType(gatewayCode)) {
            return res.status(404).send(`Unsupported payment gateway adapter: ${gatewayCode}`);
        }

        const result = await paymentGatewayService.routeWebhook(gatewayCode, req);
        return res.status(result.status || 200).send(result.message || 'OK');
    } catch (e) {
        console.error(`[Webhook Error] gatewayCode=${req.params.gatewayCode}:`, e.message);
        return res.sendStatus(500);
    }
};

module.exports = { unifiedWebhook };