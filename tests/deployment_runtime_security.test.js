'use strict';

const assert = require('node:assert');
const test = require('node:test');
const express = require('express');
const securityHeaders = require('../middlewares/securityHeaders');
const publicRoutes = require('../routes');
const { validateRuntimeConfiguration } = require('../config/runtime');

async function withServer(run) {
    const app = express();
    app.use(securityHeaders);
    app.use('/api', publicRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const { port } = server.address();
        await run(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

test('public diagnostics are absent while the minimal API health route remains available', async () => {
    await withServer(async baseUrl => {
        const health = await fetch(`${baseUrl}/api`);
        assert.strictEqual(health.status, 200);
        assert.deepStrictEqual(await health.json(), { message: 'VTU API Ready' });

        for (const path of ['/api/cloudinary-debug', '/api/health-debug']) {
            const response = await fetch(`${baseUrl}${path}`, {
                headers: { Authorization: 'Bearer unauthorized' }
            });
            const body = (await response.text()).toLowerCase();
            assert.strictEqual(response.status, 404);
            for (const forbidden of ['cloudnamevalue', 'secretlength', 'nodenv', 'mongoset', 'apikey', 'apisecret']) {
                assert.ok(!body.includes(forbidden), `${path} disclosed ${forbidden}`);
            }
        }
    });
});

test('API responses receive narrow security headers without transport or CSP policy', async () => {
    await withServer(async baseUrl => {
        const response = await fetch(`${baseUrl}/api`);
        assert.strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
        assert.strictEqual(response.headers.get('x-frame-options'), 'DENY');
        assert.strictEqual(response.headers.get('referrer-policy'), 'no-referrer');
        assert.strictEqual(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
        assert.strictEqual(response.headers.get('x-powered-by'), null);
        assert.strictEqual(response.headers.get('content-security-policy'), null);
        assert.strictEqual(response.headers.get('strict-transport-security'), null);
    });
});

test('staging requires explicit HTTPS client, CORS, and payment-mode configuration', () => {
    const config = validateRuntimeConfiguration({
        NODE_ENV: 'staging',
        CLIENT_BASE_URL: 'https://testing.example',
        CORS_ORIGIN: 'https://testing.example, https://admin-testing.example',
        PAYMENT_GATEWAY_REQUIRE_LIVE: 'false'
    });
    assert.strictEqual(config.nodeEnv, 'staging');
    assert.deepStrictEqual(config.corsOrigins, ['https://testing.example', 'https://admin-testing.example']);
    assert.strictEqual(config.paymentGatewayRequireLive, false);
    assert.strictEqual(config.paymentGatewayEnvironment, 'test');

    assert.throws(() => validateRuntimeConfiguration({ NODE_ENV: 'staging' }), /CLIENT_BASE_URL/);
    assert.throws(() => validateRuntimeConfiguration({
        NODE_ENV: 'staging',
        CLIENT_BASE_URL: 'http://testing.example',
        CORS_ORIGIN: 'https://testing.example',
        PAYMENT_GATEWAY_REQUIRE_LIVE: 'false'
    }), /HTTPS/);
    assert.throws(() => validateRuntimeConfiguration({
        NODE_ENV: 'staging',
        CLIENT_BASE_URL: 'https://testing.example',
        CORS_ORIGIN: 'https://testing.example',
        PAYMENT_GATEWAY_REQUIRE_LIVE: 'false',
        PAYMENT_GATEWAY_ENVIRONMENT: 'live'
    }), /conflicts/);
});

test('production fails closed unless live gateway enforcement is enabled', () => {
    const base = {
        NODE_ENV: 'production',
        CLIENT_BASE_URL: 'https://app.example',
        CORS_ORIGIN: 'https://app.example'
    };
    assert.throws(() => validateRuntimeConfiguration({
        ...base,
        PAYMENT_GATEWAY_REQUIRE_LIVE: 'false'
    }), /must be true in production/);
    assert.strictEqual(validateRuntimeConfiguration({
        ...base,
        PAYMENT_GATEWAY_REQUIRE_LIVE: 'true'
    }).paymentGatewayRequireLive, true);
    assert.throws(() => validateRuntimeConfiguration({
        ...base,
        PAYMENT_GATEWAY_REQUIRE_LIVE: 'true',
        PAYMENT_GATEWAY_ENVIRONMENT: 'test'
    }), /must be live/);
});

test('explicit payment gateway environment accepts only test or live', () => {
    assert.throws(() => validateRuntimeConfiguration({
        NODE_ENV: 'test',
        PAYMENT_GATEWAY_ENVIRONMENT: 'sandbox'
    }), /must be test or live/);
    assert.strictEqual(validateRuntimeConfiguration({
        NODE_ENV: 'test',
        PAYMENT_GATEWAY_ENVIRONMENT: 'test'
    }).paymentGatewayEnvironment, 'test');
    assert.throws(() => validateRuntimeConfiguration({
        NODE_ENV: 'test',
        PAYMENT_GATEWAY_REQUIRE_LIVE: 'true',
        PAYMENT_GATEWAY_ENVIRONMENT: 'test'
    }), /conflicts/);
});
