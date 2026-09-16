/**
 * Customer Response Serializer
 *
 * Produces customer-safe projections of provider PURCHASE results and the
 * PRICING PREVIEW. Whitelist-only — the raw provider payload may contain
 * procurement/accounting data (financials, vendor costs, commissions,
 * convenience fees) and must never leave customer-facing APIs.
 *
 * POLICY:
 * - Construct a FRESH object from approved fields only. Never spread the
 *   provider response into a customer DTO.
 * - Internal accounting fields continue to live on the persisted Transaction
 *   (`transaction.response`, `transaction.financials`-derived columns) and in
 *   admin/reconciliation surfaces — they are simply not part of this DTO.
 * - The serializer tolerates undefined/null/malformed provider responses and
 *   returns a controlled DTO (never the original object).
 */

/**
 * Verified blocklist used by the customer purchase/pricing DTO builders.
 * A recursive `containsForbiddenFields` helper (intended for development and
 * tests) walks any object and reports accidental leaks of these keys.
 */
const FORBIDDEN_FIELDS = [
    'financials',
    'vendorCost',
    'vendorCommission',
    'providerUnitPrice',
    'convenienceFee',
    'raw',
    'rawResponse',
    'providerResponse',
    'baseCostPrice',
    'costPrice',
    'actualCostPrice',
    'actualProfit',
    'profit',
    'margin',
    'procurementCost',
    'rawSalePrice',
    'credentials',
    'secret',
    'apiKey',
    'authorization',
    'adapter',
    'requestPayload',
    'responsePayload',
];

/** Common customer-facing fields allowed on a purchase result DTO. */
const PURCHASE_SAFE_FIELDS = [
    'success',
    'status',
    'message',
    'reference',
    'transactionId',
    'requestId',
    'providerTransactionId',
    'token',
];

/** Recursively collect any forbidden keys present on an object graph. */
function findForbiddenFields(value, pathStack = []) {
    const found = [];
    if (!value || typeof value !== 'object') return found;

    for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_FIELDS.includes(key)) {
            found.push([...pathStack, key].join('.'));
        }
        if (child && typeof child === 'object') {
            found.push(...findForbiddenFields(child, [...pathStack, key]));
        }
    }
    return found;
}

/**
 * Test/development assertion helper: returns true when any forbidden field is
 * present at any nesting depth. The production boundary remains whitelist-based.
 */
function containsForbiddenFields(value) {
    return findForbiddenFields(value).length > 0;
}

/** Clean token-like strings produced by providers ("Token: X", "Pin: Y"). */
function _cleanToken(value) {
    if (typeof value === 'string') {
        return value.replace(/^(token|pin)\s*:\s*/i, '').trim();
    }
    return value;
}

/**
 * Extract a delivered customer token from a provider response.
 * Handles flat tokens, `purchased_code`, `Pin`, token arrays, `mainToken`
 * and the VTPass merchant response shape `content.transactions[0].token`.
 */
function extractCustomerToken(response) {
    if (!response || typeof response !== 'object') return undefined;

    const candidates = [
        response.token,
        response.purchased_code,
        response.Pin,
        response.mainToken,
        Array.isArray(response.tokens) ? response.tokens[0] : undefined,
        response.content && response.content.token,
        response.content && response.content.mainToken,
        response.data && response.data.token,
        response.data && response.data.mainToken,
        response.content &&
            Array.isArray(response.content.transactions) &&
            response.content.transactions[0] &&
            response.content.transactions[0].token,
        response.content &&
            Array.isArray(response.content.transactions) &&
            response.content.transactions[0] &&
            response.content.transactions[0].main_token,
        response.raw &&
            response.raw.content &&
            Array.isArray(response.raw.content.transactions) &&
            response.raw.content.transactions[0] &&
            response.raw.content.transactions[0].token,
    ];

    for (const candidate of candidates) {
        const cleaned = _cleanToken(candidate);
        if (typeof cleaned === 'string' && cleaned.trim()) return cleaned.trim();
        if (cleaned !== undefined && cleaned !== null) return cleaned;
    }
    return undefined;
}

/** Always-truthy guard for including a defined non-null value. */
function hasValue(value) {
    return value !== undefined && value !== null && value !== '';
}

/**
 * Build a customer-safe purchase response DTO from a provider response.
 *
 * @param {Object} response - normalized (or raw) provider success response.
 * @param {Object} [ctx] - Zantara context: `reference`, `transactionId`.
 * @returns {Object} fresh projection containing ONLY approved fields.
 */
function serializePurchaseResult(response, ctx) {
    const ref = hasValue(ctx && ctx.reference) ? ctx.reference : undefined;
    const txnId = hasValue(ctx && ctx.transactionId) ? ctx.transactionId : undefined;
    const source = response && typeof response === 'object' ? response : {};

    const dto = {};
    if (source.success !== undefined) dto.success = source.success;
    if (hasValue(source.status)) dto.status = source.status;
    if (hasValue(source.message)) dto.message = source.message;
    if (ref !== undefined) dto.reference = ref;
    if (txnId !== undefined) dto.transactionId = txnId;
    if (hasValue(source.requestId)) dto.requestId = source.requestId;
    if (hasValue(source.transactionId)) dto.providerTransactionId = source.transactionId;

    const token = extractCustomerToken(source);
    if (token !== undefined) dto.token = token;

    return dto;
}

/**
 * Wrap a `purchaseService.processPurchase` result with a customer-safe data
 * projection, preserving the internal return shape consumed by callers
 * (`success`, `data`, `message`, `error`, `transactionId`, `reference`).
 * The original provider `data` is intentionally NOT forwarded.
 */
function safePurchaseResult(result) {
    if (!result || typeof result !== 'object') {
        return { success: false, message: 'Transaction could not be processed', error: { message: 'INTERNAL_ERROR' } };
    }

    const safe = {
        success: Boolean(result.success),
        data: serializePurchaseResult(result.data, {
            reference: result.reference,
            transactionId: result.transactionId,
        }),
    };

    if (typeof result.message === 'string' && result.message) safe.message = result.message;
    safe.error = { message: typeof result.message === 'string' ? result.message : 'Provider request failed' };

    if (result.transactionId !== undefined && result.transactionId !== null) {
        safe.transactionId = result.transactionId;
    }
    if (result.reference !== undefined && result.reference !== null) {
        safe.reference = result.reference;
    }

    return safe;
}

/**
 * Customer-safe pricing preview DTO. Customers need the payable amount, the
 * discount representation and product identifiers — never the procurement
 * cost/profit internals (baseCostPrice, rawSalePrice, markup).
 */
function serializePricingPreview(pricing) {
    if (!pricing || typeof pricing !== 'object') return null;

    const dto = {};
    if (pricing.salePrice !== undefined) dto.salePrice = pricing.salePrice;
    if (pricing.retailPrice !== undefined) dto.retailPrice = pricing.retailPrice;
    if (pricing.savings !== undefined) dto.savings = pricing.savings;
    if (pricing.fee !== undefined) dto.fee = pricing.fee;
    dto.currency = pricing.currency || 'NGN';
    if (pricing.serviceId !== undefined) dto.serviceId = pricing.serviceId;
    if (pricing.serviceCode !== undefined) dto.serviceCode = pricing.serviceCode;
    if (pricing.serviceName !== undefined) dto.serviceName = pricing.serviceName;
    dto.isPreview = true;
    dto.note = 'This is a preview price and may vary slightly at the time of final purchase.';

    return dto;
}

module.exports = {
    FORBIDDEN_FIELDS,
    PURCHASE_SAFE_FIELDS,
    findForbiddenFields,
    containsForbiddenFields,
    extractCustomerToken,
    serializePurchaseResult,
    safePurchaseResult,
    serializePricingPreview,
};