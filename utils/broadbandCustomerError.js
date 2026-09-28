const POLICY = Object.freeze({
    TRANSACTION_PIN_REQUIRED: Object.freeze({
        publicCode: 'TRANSACTION_PIN_REQUIRED',
        message: 'PIN is required',
        statusCode: 400
    }),
    TRANSACTION_PIN_NOT_SET: Object.freeze({
        publicCode: 'TRANSACTION_PIN_NOT_SET',
        message: 'Transaction PIN not set',
        statusCode: 400
    }),
    TRANSACTION_PIN_INVALID: Object.freeze({
        publicCode: 'TRANSACTION_PIN_INVALID',
        message: 'Invalid transaction PIN',
        statusCode: 400
    }),
    TRANSACTION_PIN_LOCKED: Object.freeze({
        publicCode: 'TRANSACTION_PIN_LOCKED',
        message: 'Transaction PIN is temporarily locked. Please try again later.',
        statusCode: 429
    }),
    PIN_STATE_CONFLICT: Object.freeze({
        publicCode: 'PIN_STATE_CONFLICT',
        message: 'Transaction PIN verification changed concurrently. Please retry.',
        statusCode: 409
    }),
    PURCHASE_PRICE_CHANGED: Object.freeze({
        publicCode: 'PRICE_CHANGED',
        message: 'The price changed before checkout. Please review the updated price and try again.',
        statusCode: 409
    }),
    INSUFFICIENT_WALLET_BALANCE: Object.freeze({
        publicCode: 'INSUFFICIENT_FUNDS',
        message: 'Insufficient wallet balance',
        statusCode: 400
    }),
    PURCHASE_LIMIT_EXCEEDED: Object.freeze({
        publicCode: 'PURCHASE_LIMIT_EXCEEDED',
        message: 'Transaction amount exceeds your account limit.',
        statusCode: 400
    }),
    PROVIDER_OFFER_UNAVAILABLE: Object.freeze({
        publicCode: 'BROADBAND_PROVIDER_UNAVAILABLE',
        message: 'Broadband provider is temporarily unavailable',
        statusCode: 503
    }),
    IDEMPOTENCY_CONFLICT: Object.freeze({
        publicCode: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency key was already used for a different Broadband purchase',
        statusCode: 409
    }),
    BROADBAND_IDEMPOTENCY_INDEX_MISSING: Object.freeze({
        publicCode: 'BROADBAND_IDEMPOTENCY_INDEX_MISSING',
        message: 'Broadband purchase is unavailable until the idempotency index migration is applied',
        statusCode: 503
    }),
    INVALID_BROADBAND_CONTEXT: Object.freeze({
        publicCode: 'INVALID_BROADBAND_CONTEXT',
        message: 'Invalid or expired Broadband verification context',
        statusCode: 400
    }),
    BROADBAND_PROVIDER_UNAVAILABLE: Object.freeze({
        publicCode: 'BROADBAND_PROVIDER_UNAVAILABLE',
        message: 'Broadband provider is temporarily unavailable',
        statusCode: 503
    }),
    BROADBAND_PIN_VERIFICATION_UNAVAILABLE: Object.freeze({
        publicCode: 'BROADBAND_PIN_VERIFICATION_UNAVAILABLE',
        message: 'We could not verify your transaction PIN right now. Please try again.',
        statusCode: 503
    }),
    BROADBAND_PURCHASE_UNAVAILABLE: Object.freeze({
        publicCode: 'BROADBAND_PURCHASE_UNAVAILABLE',
        message: 'Broadband purchase could not be completed right now. Please try again.',
        statusCode: 503
    })
});

const PIN_ERROR_CODES = Object.freeze({
    TRANSACTION_PIN_NOT_SET: true,
    TRANSACTION_PIN_INVALID: true,
    TRANSACTION_PIN_LOCKED: true,
    PIN_STATE_CONFLICT: true
});

const PURCHASE_ERROR_CODES = Object.freeze({
    ...PIN_ERROR_CODES,
    PURCHASE_PRICE_CHANGED: true,
    INSUFFICIENT_WALLET_BALANCE: true,
    PURCHASE_LIMIT_EXCEEDED: true,
    PROVIDER_OFFER_UNAVAILABLE: true,
    IDEMPOTENCY_CONFLICT: true,
    BROADBAND_IDEMPOTENCY_INDEX_MISSING: true,
    INVALID_BROADBAND_CONTEXT: true,
    BROADBAND_PROVIDER_UNAVAILABLE: true
});

const CONTROLLED_ERROR = Symbol('controlledBroadbandError');

function createControlledBroadbandError(message, statusCode = 400, code) {
    const policy = code ? POLICY[code] : null;
    const error = new Error(policy?.message || message);
    error.statusCode = policy?.statusCode || statusCode;
    if (policy?.publicCode || code) error.code = policy?.publicCode || code;
    error.publicMessage = policy?.message || message;
    error[CONTROLLED_ERROR] = true;
    return error;
}

function createPolicyError(code) {
    const policy = POLICY[code];
    if (!policy) throw new Error('Unknown Broadband public error policy');
    return createControlledBroadbandError(policy.message, policy.statusCode, code);
}

function resolveCustomerError(error, { allowedCodes, fallbackMessage, fallbackStatusCode = 500 } = {}) {
    if (error?.[CONTROLLED_ERROR]) {
        return {
            message: error.publicMessage,
            code: error.code,
            statusCode: error.statusCode || 400,
            trusted: true
        };
    }

    const policy = typeof error?.code === 'string' ? POLICY[error.code] : null;
    if (policy && (!allowedCodes || Object.prototype.hasOwnProperty.call(allowedCodes, error.code))) {
        return {
            message: policy.message,
            code: policy.publicCode,
            statusCode: policy.statusCode,
            trusted: true
        };
    }

    if (!fallbackMessage) return null;
    return {
        message: fallbackMessage,
        code: undefined,
        statusCode: error?.statusCode || fallbackStatusCode,
        trusted: false
    };
}

module.exports = {
    PIN_ERROR_CODES,
    PURCHASE_ERROR_CODES,
    createControlledBroadbandError,
    createPolicyError,
    resolveCustomerError
};
