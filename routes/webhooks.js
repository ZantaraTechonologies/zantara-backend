'use strict';

const express = require('express');
const router = express.Router();
const { unifiedWebhook } = require('../controllers/paymentWebhookController');

// ─── Unified Payment Gateway Webhook ──────────────────────────────────────────
//
// POST /api/webhooks/payment/:gatewayCode
//   gatewayCode values: paystack | monnify | flutterwave | <any registered adapter>
//
// IMPORTANT: This route MUST be mounted BEFORE app.use(express.json()) in
// server.js. express.raw() conserves the exact raw HTTP body so signature
// verification (HMAC-SHA512 for Paystack/Monnify) is computed over the exact
// bytes the provider signed. JSON parsing is deferred to
// paymentGatewayService.routeWebhook(), which converts the Buffer payload only
// AFTER the signature has been validated.
//
// type: '*/*' captures every content-type so providers that send
// text/plain or application/octet-stream are handled identically.
router.post('/payment/:gatewayCode', express.raw({ type: '*/*' }), unifiedWebhook);

module.exports = router;