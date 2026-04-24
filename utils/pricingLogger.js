/**
 * pricingLogger.js
 * Structured event logger for the pricing-integrity rollout.
 *
 * Usage:
 *   const { logPriceMismatch, logPreviewFailure, logMissingExpectedPrice } = require('../utils/pricingLogger');
 *
 * All writes are fire-and-forget; a logging failure NEVER propagates to the caller.
 * Sensitive fields (pin, password, token, secret) are never included in payloads.
 */

const Log = require('../models/Logs');

// ─── Event constants ───────────────────────────────────────────────────────────
const EVENTS = {
    PRICE_MISMATCH:          'PRICE_MISMATCH',
    PREVIEW_FAILURE:         'PREVIEW_FAILURE',
    MISSING_EXPECTED_PRICE:  'MISSING_EXPECTED_PRICE',
    LEGACY_PRICING_FALLBACK: 'LEGACY_PRICING_FALLBACK',
};

// ─── Internal write helper ─────────────────────────────────────────────────────
/**
 * Persists a structured event to stdout (always) and MongoDB (best-effort).
 * @param {'warn'|'error'|'info'} level
 * @param {string} event  One of EVENTS.*
 * @param {object} fields Arbitrary safe metadata (no secrets)
 */
function _writeLog(level, event, fields) {
    const payload = {
        event,
        timestamp: new Date().toISOString(),
        ...fields,
    };

    // 1. Always write to stdout (picked up by Render/Heroku/PM2 log aggregators)
    const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    logFn(`[PRICING-INTEGRITY][${event}]`, JSON.stringify(payload));

    // 2. Persist to MongoDB Log collection (non-blocking)
    Log.create({
        level,
        message: `[PRICING-INTEGRITY] ${event}`,
        context: payload,
        timestamp: new Date(),
    }).catch(() => {
        // Silently discard — logging must never crash the purchase flow
    });
}

// ─── Public logger functions ───────────────────────────────────────────────────

/**
 * Emitted when a purchase's expectedPrice does not match the backend-computed price.
 * This is the most critical event — direct evidence of potential price manipulation
 * or client-side stale pricing.
 */
function logPriceMismatch({ userId, userRole, serviceId, serviceCode, expectedPrice, computedPrice, type, source, clientType }) {
    _writeLog('warn', EVENTS.PRICE_MISMATCH, {
        userId:        userId    ? String(userId)    : 'unknown',
        userRole:      userRole  || 'unknown',
        serviceId:     serviceId || serviceCode || 'unknown',
        serviceCode:   serviceCode || null,
        type:          type      || 'unknown',
        expectedPrice: Number(expectedPrice),
        computedPrice: Number(computedPrice),
        difference:    Number(computedPrice) - Number(expectedPrice),
        source:        source    || 'unknown',
        clientType:    clientType || 'unknown',
    });
}

/**
 * Emitted when /api/v1/pricing/calculate fails for any reason.
 * Helps detect systemic pricing service degradation.
 */
function logPreviewFailure({ userId, serviceId, serviceCode, amount, quantity, errorReason, source, clientType }) {
    _writeLog('error', EVENTS.PREVIEW_FAILURE, {
        userId:      userId    ? String(userId) : 'unauthenticated',
        serviceId:   serviceId || serviceCode   || 'unknown',
        serviceCode: serviceCode || null,
        amount:      amount    !== undefined ? Number(amount) : null,
        quantity:    quantity  !== undefined ? Number(quantity) : null,
        errorReason: errorReason || 'unknown',
        source:      source    || 'unknown',
        clientType:  clientType || 'unknown',
    });
}

/**
 * Emitted when a purchase request arrives without an expectedPrice field.
 * Indicates the request came from a legacy client or an un-migrated code path.
 * Purchase is NOT blocked — this is informational only.
 */
function logMissingExpectedPrice({ userId, userRole, serviceId, type, amount, source, clientType }) {
    _writeLog('info', EVENTS.MISSING_EXPECTED_PRICE, {
        userId:    userId   ? String(userId) : 'unknown',
        userRole:  userRole || 'unknown',
        serviceId: serviceId || 'unknown',
        type:      type     || 'unknown',
        amount:    amount   !== undefined ? Number(amount) : null,
        source:    source   || 'unknown',
        clientType: clientType || 'legacy',
        note: 'Purchase proceeded without price verification. Client may be on legacy path.',
    });
}

/**
 * Emitted when the legacy pricing engine is used as fallback
 * (i.e., the new pricing engine found no matching service/offer/rule).
 */
function logLegacyPricingFallback({ userId, serviceId, type, amount, source }) {
    _writeLog('info', EVENTS.LEGACY_PRICING_FALLBACK, {
        userId:    userId   ? String(userId) : 'unknown',
        serviceId: serviceId || 'unknown',
        type:      type     || 'unknown',
        amount:    amount   !== undefined ? Number(amount) : null,
        source:    source   || 'unknown',
        note: 'Legacy pricing engine used. Service may not be in normalized catalog.',
    });
}

module.exports = {
    EVENTS,
    logPriceMismatch,
    logPreviewFailure,
    logMissingExpectedPrice,
    logLegacyPricingFallback,
};
