const SENSITIVE_ROUTE_TOKEN = /(\/(?:api\/auth\/)?(?:reset-password|verify-email)\/)[^/?\s]+/gi;
const SENSITIVE_REQUEST_KEY = /(authorization|password|pin|otp|pushToken|token)/i;

const sanitizeUrl = value => String(value || '').replace(SENSITIVE_ROUTE_TOKEN, '$1[REDACTED]');

const maskSecret = value => value ? '[REDACTED]' : '';

const collectSensitiveValues = (value, values = [], parentKey = '') => {
    if (value === null || value === undefined) return values;
    if (Array.isArray(value)) {
        for (const item of value) collectSensitiveValues(item, values, parentKey);
        return values;
    }
    if (typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            collectSensitiveValues(child, values, key);
        }
        return values;
    }
    if (SENSITIVE_REQUEST_KEY.test(parentKey)) values.push(String(value));
    return values;
};

const sanitizeText = (value, sensitiveValues = []) => {
    let sanitized = sanitizeUrl(value);
    for (const secret of sensitiveValues) {
        if (secret) sanitized = sanitized.split(secret).join('[REDACTED]');
    }
    return sanitized;
};

const requestSecrets = req => {
    const values = [];
    collectSensitiveValues(req?.body, values);
    collectSensitiveValues(req?.params, values);
    collectSensitiveValues(req?.query, values);
    collectSensitiveValues(req?.cookies, values);
    if (req?.headers?.authorization) {
        const authorization = String(req.headers.authorization);
        values.push(authorization);
        if (authorization.startsWith('Bearer ')) values.push(authorization.slice(7));
    }
    return [...new Set(values.filter(Boolean))];
};

const sanitizeRequestText = (value, req) => sanitizeText(value, requestSecrets(req));

module.exports = {
    maskSecret,
    sanitizeRequestText,
    sanitizeText,
    sanitizeUrl
};
