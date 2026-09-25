/**
 * Customer Transaction Serializer
 *
 * Produces a safe customer-facing representation of Transaction documents.
 * Used by user-facing transaction endpoints (transaction-logs, investment/history).
 *
 * POLICY:
 * - Only explicitly allowlisted fields are included.
 * - Internal commercial/accounting data is NEVER exposed.
 * - Details object is allowlisted per transaction type.
 * - Raw provider responses are never included.
 */

const { decryptFulfillment } = require('./fulfillment');

const BLOCKED_FIELDS = [
    'costPrice',
    'estimatedCostPrice',
    'actualCostPrice',
    'profit',
    'estimatedProfit',
    'actualProfit',
    'vendorCommission',
    'providerUnitPrice',
    'convenienceFee',
    'accountingSource',
    'provider',
    'providerRef',
    'response',
    'pricingSnapshot',
    'isLoss',
    'commission',
    'agentPrice',
    'userRole',
    'commissionVersion',
    'netProfitAfterCommission',
    '__v',
];

const ALLOWED_TOP_FIELDS = [
    '_id',
    'userId',
    'transactionId',
    'refId',
    'type',
    'service',
    'amount',
    'status',
    'createdAt',
    'updatedAt',
    'details',
    'metadata',
];

/**
 * Safe details fields per transaction type.
 * Only these keys will be included in the customer-facing details.
 * Types not listed here get NO details fields.
 */
const SAFE_DETAILS_BY_TYPE = {
    airtime: ['phone', 'network'],
    data: ['phone', 'serviceID', 'variation_code'],
    electricity: ['meter_number', 'meter_type', 'phone', 'productName'],
    cable: ['serviceID', 'billersCode', 'variation_code'],
    exam_pin: ['serviceID', 'variation_code', 'quantity', 'billersCode', 'productName'],
    pin: ['serviceID', 'variation_code', 'quantity', 'billersCode', 'productName'],
    wallet_funding: [],
    funding: [],
    transfer_out: ['recipientName', 'recipientPhone', 'remarks'],
    transfer_in: ['senderName', 'senderPhone', 'remarks'],
    withdrawal: ['bankName', 'accountNumber'],
    referral_bonus: ['wasCapped', 'buyerRole', 'originalCommission'],
    referral_redeem: [],
    referral_skipped: ['wasCapped', 'buyerRole', 'parentTxnId'],
    share_purchase: ['sharesQty', 'pricePerShare', 'fee'],
    share_exit: ['sharesReturned', 'grossAmount', 'exitFeeCharged'],
    dividend_credit: [],
    dividend_reinvest: ['sharesQty', 'pricePerShare', 'fee'],
    dividend_redeem: ['fee', 'netAmount', 'source'],
    dividend_withdrawal: ['grossAmount', 'feeCharged', 'bankName'],
    settlement: [],
    expense: [],
};

/**
 * Extract safe fields from the details object based on transaction type.
 * Returns undefined if no safe fields exist for the type.
 */
function sanitizeDetails(details, type) {
    if (!details || typeof details !== 'object') return undefined;

    const allowedKeys = SAFE_DETAILS_BY_TYPE[type];
    if (!allowedKeys || allowedKeys.length === 0) return undefined;

    const safe = {};
    let hasSafe = false;

    for (const key of allowedKeys) {
        if (Object.prototype.hasOwnProperty.call(details, key) && details[key] !== undefined && details[key] !== null) {
            safe[key] = details[key];
            hasSafe = true;
        }
    }

    return hasSafe ? safe : undefined;
}

/**
 * Extract safe fields from metadata object.
 * Only safe consumer-facing keys are preserved.
 */
function sanitizeMetadata(metadata, type) {
    if (!metadata || typeof metadata !== 'object') return undefined;

    if (type === 'agent_profit') {
        const safe = {};
        if (metadata.costPrice != null) safe.costPrice = metadata.costPrice;
        if (metadata.sellingPrice != null) safe.sellingPrice = metadata.sellingPrice;
        return Object.keys(safe).length > 0 ? safe : undefined;
    }

    if (type === 'referral_skipped') {
        const safe = {};
        if (metadata.wasCapped != null) safe.wasCapped = metadata.wasCapped;
        if (metadata.buyerRole != null) safe.buyerRole = metadata.buyerRole;
        return Object.keys(safe).length > 0 ? safe : undefined;
    }

    return undefined;
}

/**
 * Extract a delivered electricity token from the provider response into a safe
 * customer-visible field. The token is the actual purchased product and customers
 * require it for support; the raw `response` object itself is never exposed.
 */
function extractElectricityToken(response) {
    if (!response || typeof response !== 'object') return undefined;

    const candidates = [
        response.token,
        response.purchased_code,
        response.mainToken,
        response.data && response.data.token,
        response.data && response.data.mainToken,
        response.content && response.content.transactions && response.content.transactions[0] && response.content.transactions[0].token,
        response.content && response.content.transactions && response.content.transactions[0] && response.content.transactions[0].main_token,
        response.content && response.content.transactions && !Array.isArray(response.content.transactions) && response.content.transactions.token,
        response.content && response.content.transactions && !Array.isArray(response.content.transactions) && response.content.transactions.main_token,
    ];

    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return undefined;
}

/**
 * Serialize a single transaction document into the customer-facing DTO.
 * Returns a plain object with only safe fields.
 */
function serializeCustomerTransaction(doc) {
    if (!doc || typeof doc !== 'object') return null;

    const plain = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
    const type = plain.type || 'unknown';

    const result = {
        _id: plain._id,
        transactionId: plain.transactionId,
        refId: plain.refId,
        type: plain.type,
        service: plain.service,
        amount: plain.amount,
        status: plain.status,
        createdAt: plain.createdAt,
        updatedAt: plain.updatedAt,
        currency: 'NGN',
    };

    const safeDetails = sanitizeDetails(plain.details, type);
    const fulfillment = decryptFulfillment(plain.fulfillment);

    if (type === 'electricity' && plain.status === 'success') {
        const token = fulfillment.complete && fulfillment.items.length > 0
            ? fulfillment.items[0].code
            : extractElectricityToken(plain.response);
        if (token) {
            if (safeDetails) {
                safeDetails.token = token;
            } else if (plain.details && typeof plain.details === 'object') {
                result.details = { token };
            }
        }
    }

    if ((type === 'pin' || type === 'exam_pin') && plain.status === 'success' && fulfillment.complete && fulfillment.items.length > 0) {
        const target = safeDetails || {};
        target.fulfillment = fulfillment.items;
        result.details = target;
    }

    if (type === 'electricity' && plain.status === 'success' && fulfillment.complete && fulfillment.items.length > 0) {
        const target = safeDetails || {};
        target.fulfillment = fulfillment.items;
        target.token = fulfillment.items[0].code;
        result.details = target;
    }

    if (safeDetails) {
        result.details = safeDetails;
    }

    const safeMetadata = sanitizeMetadata(plain.metadata, type);
    if (safeMetadata) {
        result.metadata = safeMetadata;
    }

    if (plain.userId) result.userId = plain.userId;

    return result;
}

/**
 * Serialize an array of transaction documents.
 */
function serializeCustomerTransactions(docs) {
    if (!Array.isArray(docs)) return [];
    return docs.map(serializeCustomerTransaction).filter(Boolean);
}

module.exports = {
    serializeCustomerTransaction,
    serializeCustomerTransactions,
    sanitizeDetails,
    sanitizeMetadata,
    SAFE_DETAILS_BY_TYPE,
    BLOCKED_FIELDS,
};
