const { decryptSecret } = require('./crypto');

/**
 * List of metadata key patterns that must never contain raw secrets.
 */
const FORBIDDEN_METADATA_KEY_PATTERNS = [
    /password/i,
    /secret/i,
    /secretkey/i,
    /apikey/i,
    /token/i,
    /bearertoken/i,
    /accesstoken/i
];

/**
 * Explicit allowlist of supported metadata keys for Universal Provider configuration.
 */
const ALLOWED_METADATA_KEYS = new Set([
    // Generic endpoints
    'purchaseUrl',
    'queryUrl',
    'balanceUrl',
    'variationsUrl',
    'verifyUrl',

    // Category-specific purchase endpoint overrides
    'airtimePurchaseUrl',
    'dataPurchaseUrl',
    'electricityPurchaseUrl',
    'cablePurchaseUrl',
    'examPurchaseUrl',

    // HTTP methods
    'method',
    'airtimeMethod',
    'dataMethod',
    'electricityMethod',
    'cableMethod',
    'examMethod',
    'queryMethod',
    'balanceMethod',
    'variationsMethod',
    'verifyMethod',

    // Authentication configuration
    'authHeaderName',
    'authHeaderValue',

    // Request field mappings
    'fieldMap',
    'airtimeFieldMap',
    'dataFieldMap',
    'electricityFieldMap',
    'cableFieldMap',
    'examFieldMap',

    // Response normalization
    'successPath',
    'successValue',
    'statusPath',
    'transactionIdPath',
    'messagePath',
    'balancePath',
    'variationsPath',
    'variationFieldMap'
]);

const ALLOWED_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const APPROVED_AUTH_PLACEHOLDERS = new Set(['{{apiKey}}', '{{secretKey}}', '{{publicKey}}']);
const SAFE_DOT_PATH_REGEX = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;

/**
 * Checks whether a metadata key is forbidden from storing raw sensitive data directly.
 */
function isForbiddenMetadataKey(key) {
    if (!key || typeof key !== 'string') return false;
    return FORBIDDEN_METADATA_KEY_PATTERNS.some(pattern => pattern.test(key));
}

/**
 * Validates metadata object against security rules and supported schema.
 * Throws an Error if invalid.
 */
function validateMetadata(metadataObj) {
    if (!metadataObj) return {};

    const plain = metadataObj instanceof Map ? Object.fromEntries(metadataObj) : { ...metadataObj };
    const validated = {};

    for (const [key, val] of Object.entries(plain)) {
        // Reject unsupported metadata keys
        if (!ALLOWED_METADATA_KEYS.has(key)) {
            throw new Error(`Unsupported metadata key: '${key}'`);
        }

        if (val === undefined || val === null || val === '') {
            continue;
        }

        // 1. HTTP Methods validation
        if (key.endsWith('Method') || key === 'method') {
            if (typeof val !== 'string') {
                throw new Error(`Invalid HTTP method for '${key}': must be a string`);
            }
            const upperMethod = val.trim().toUpperCase();
            if (!ALLOWED_HTTP_METHODS.has(upperMethod)) {
                throw new Error(`Invalid HTTP method '${val}' for '${key}'. Allowed: ${Array.from(ALLOWED_HTTP_METHODS).join(', ')}`);
            }
            validated[key] = upperMethod;
            continue;
        }

        // 2. URLs / Endpoints validation
        if (key.endsWith('Url')) {
            if (typeof val !== 'string') {
                throw new Error(`Endpoint URL for '${key}' must be a string`);
            }
            const trimmed = val.trim();
            const isLocal = trimmed.includes('localhost') || trimmed.includes('127.0.0.1');
            const isRelative = trimmed.startsWith('/');
            const isHttps = trimmed.startsWith('https://');
            const isHttp = trimmed.startsWith('http://');

            if (!isRelative && !isHttps && !(isHttp && isLocal)) {
                if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
                    throw new Error(`Endpoint '${key}' must be a relative path or an HTTPS URL in production`);
                } else if (!isHttp) {
                    throw new Error(`Endpoint '${key}' must be a relative path or a valid URL`);
                }
            }
            validated[key] = trimmed;
            continue;
        }

        // 3. Auth Header Value Template validation
        if (key === 'authHeaderValue') {
            if (typeof val !== 'string') {
                throw new Error('authHeaderValue must be a string template');
            }
            const trimmed = val.trim();

            // Reject raw bearer tokens or hardcoded secrets without template placeholders
            if (trimmed.toLowerCase().startsWith('bearer ') && !trimmed.includes('{{')) {
                throw new Error("Raw bearer token rejected in authHeaderValue. Use template placeholder like 'Bearer {{apiKey}}'.");
            }

            // Check placeholders
            const matches = trimmed.match(/\{\{[^}]+\}\}/g) || [];
            for (const placeholder of matches) {
                if (!APPROVED_AUTH_PLACEHOLDERS.has(placeholder)) {
                    throw new Error(`Unsupported placeholder '${placeholder}' in authHeaderValue. Approved placeholders: ${Array.from(APPROVED_AUTH_PLACEHOLDERS).join(', ')}`);
                }
            }
            validated[key] = trimmed;
            continue;
        }

        // 4. Field Maps validation
        if (key.endsWith('FieldMap') || key === 'fieldMap') {
            if (typeof val !== 'object' || Array.isArray(val) || val === null) {
                throw new Error(`Field mapping for '${key}' must be an object`);
            }
            const cleanMap = {};
            for (const [k, v] of Object.entries(val)) {
                if (typeof k !== 'string' || typeof v !== 'string' || !k.trim() || !v.trim()) {
                    throw new Error(`Invalid mapping in '${key}': both key and value must be non-empty strings`);
                }
                cleanMap[k.trim()] = v.trim();
            }
            validated[key] = cleanMap;
            continue;
        }

        // 5. Response Path validation
        if (key.endsWith('Path')) {
            if (typeof val !== 'string') {
                throw new Error(`Response path for '${key}' must be a string`);
            }
            const trimmed = val.trim();
            if (!SAFE_DOT_PATH_REGEX.test(trimmed)) {
                throw new Error(`Invalid dot-path '${val}' for '${key}'. Must be a safe identifier path (e.g. 'data.status' or 'response_code')`);
            }
            validated[key] = trimmed;
            continue;
        }

        // 6. Success Value
        if (key === 'successValue') {
            validated[key] = typeof val === 'string' ? val.trim() : String(val);
            continue;
        }

        // 7. General strings (e.g. authHeaderName)
        if (typeof val === 'string') {
            validated[key] = val.trim();
            continue;
        }

        validated[key] = val;
    }

    return validated;
}

/**
 * Sanitizes metadata object for response and persistence.
 * Prevents direct storing of secret values in prohibited metadata keys.
 */
function sanitizeMetadata(metadataObj) {
    if (!metadataObj) return {};

    const plain = metadataObj instanceof Map ? Object.fromEntries(metadataObj) : { ...metadataObj };
    const cleaned = {};

    for (const [key, val] of Object.entries(plain)) {
        // If metadata key is secret-oriented, omit unless it is a generic template string (e.g. {{apiKey}})
        if (isForbiddenMetadataKey(key)) {
            // If value is a simple plaintext secret, omit it
            if (typeof val === 'string' && !val.includes('{{')) {
                continue; // Strip direct secret value stored under forbidden key
            }
        }
        cleaned[key] = val;
    }

    return cleaned;
}

/**
 * Sanitizes a Provider Mongoose document or plain object for client response.
 * Never returns plaintext or encrypted secretKey/apiKey blobs.
 */
function serializeProvider(provider) {
    if (!provider) return null;

    const doc = typeof provider.toObject === 'function' ? provider.toObject() : { ...provider };

    // Decrypt apiKey temporarily strictly to generate the safe masked string
    const rawApiKey = doc.apiKey ? decryptSecret(doc.apiKey) : '';
    let apiKeyMasked = 'Not Configured';

    if (rawApiKey) {
        if (rawApiKey.length > 4) {
            apiKeyMasked = `••••${rawApiKey.slice(-4)}`;
        } else {
            apiKeyMasked = '••••';
        }
    }

    const sanitizedMeta = sanitizeMetadata(doc.metadata);

    return {
        _id: doc._id,
        name: doc.name,
        adapterType: doc.adapterType || 'vtpass',
        baseUrl: doc.baseUrl,
        publicKey: doc.publicKey || '',
        status: doc.status || 'active',
        balance: doc.balance || 0,
        lastBalanceCheck: doc.lastBalanceCheck || null,
        apiKeyConfigured: Boolean(doc.apiKey),
        apiKeyMasked,
        secretKeyConfigured: Boolean(doc.secretKey),
        metadata: sanitizedMeta,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
    };
}

module.exports = {
    serializeProvider,
    sanitizeMetadata,
    validateMetadata,
    isForbiddenMetadataKey,
    ALLOWED_METADATA_KEYS,
    ALLOWED_HTTP_METHODS,
    APPROVED_AUTH_PLACEHOLDERS
};
