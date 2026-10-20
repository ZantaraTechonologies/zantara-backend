'use strict';

const KNOWN_ENVIRONMENTS = new Set(['development', 'test', 'staging', 'production']);
const DEPLOYMENT_ENVIRONMENTS = new Set(['staging', 'production']);

function parseOrigin(value, label, { requireHttps = false } = {}) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch (_) {
        throw new Error(`${label} must be a valid URL origin`);
    }

    if (!['http:', 'https:'].includes(parsed.protocol)
        || (requireHttps && parsed.protocol !== 'https:')
        || parsed.username
        || parsed.password
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash) {
        throw new Error(`${label} must be an ${requireHttps ? 'HTTPS ' : ''}origin without credentials, path, query, or fragment`);
    }
    return parsed.origin;
}

function validateRuntimeConfiguration(env = process.env) {
    const nodeEnv = String(env.NODE_ENV || 'development').trim().toLowerCase();
    if (!KNOWN_ENVIRONMENTS.has(nodeEnv)) {
        throw new Error('NODE_ENV must be one of: development, test, staging, production');
    }

    const deployment = DEPLOYMENT_ENVIRONMENTS.has(nodeEnv);
    const clientBaseUrlValue = String(env.CLIENT_BASE_URL || '').trim();
    const corsValue = String(env.CORS_ORIGIN || '').trim();
    const requireLiveValue = String(env.PAYMENT_GATEWAY_REQUIRE_LIVE || '').trim().toLowerCase();
    const paymentGatewayEnvironment = String(env.PAYMENT_GATEWAY_ENVIRONMENT || '').trim().toLowerCase();

    if (deployment && !clientBaseUrlValue) throw new Error('CLIENT_BASE_URL is required in staging and production');
    if (deployment && !corsValue) throw new Error('CORS_ORIGIN is required in staging and production');
    if (deployment && !requireLiveValue) {
        throw new Error('PAYMENT_GATEWAY_REQUIRE_LIVE must be explicitly set in staging and production');
    }
    if (requireLiveValue && !['true', 'false'].includes(requireLiveValue)) {
        throw new Error('PAYMENT_GATEWAY_REQUIRE_LIVE must be true or false');
    }
    if (nodeEnv === 'production' && requireLiveValue !== 'true') {
        throw new Error('PAYMENT_GATEWAY_REQUIRE_LIVE must be true in production');
    }
    if (paymentGatewayEnvironment && !['test', 'live'].includes(paymentGatewayEnvironment)) {
        throw new Error('PAYMENT_GATEWAY_ENVIRONMENT must be test or live');
    }
    if (nodeEnv === 'production' && paymentGatewayEnvironment && paymentGatewayEnvironment !== 'live') {
        throw new Error('PAYMENT_GATEWAY_ENVIRONMENT must be live in production');
    }
    if (paymentGatewayEnvironment && ['true', 'false'].includes(requireLiveValue)) {
        const requiredEnvironment = requireLiveValue === 'true' ? 'live' : 'test';
        if (paymentGatewayEnvironment !== requiredEnvironment) {
            throw new Error('PAYMENT_GATEWAY_ENVIRONMENT conflicts with PAYMENT_GATEWAY_REQUIRE_LIVE');
        }
    }

    const clientBaseUrl = clientBaseUrlValue
        ? parseOrigin(clientBaseUrlValue, 'CLIENT_BASE_URL', { requireHttps: deployment })
        : null;
    const corsOrigins = corsValue
        ? corsValue.split(',').map(value => value.trim()).filter(Boolean).map((value, index) => (
            parseOrigin(value, `CORS_ORIGIN entry ${index + 1}`, { requireHttps: deployment })
        ))
        : [];

    if (corsOrigins.includes('*')) throw new Error('CORS_ORIGIN must not contain a wildcard');

    return {
        nodeEnv,
        clientBaseUrl,
        corsOrigins,
        paymentGatewayRequireLive: requireLiveValue === 'true',
        paymentGatewayEnvironment: paymentGatewayEnvironment || (
            nodeEnv === 'production'
                ? 'live'
                : nodeEnv === 'staging'
                    ? (requireLiveValue === 'true' ? 'live' : 'test')
                    : null
        )
    };
}

module.exports = { validateRuntimeConfiguration, parseOrigin };
