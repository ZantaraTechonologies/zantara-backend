'use strict';

// The default unit suite must remain hermetic even when a developer has a
// credentialed .env file. Explicit real-database tests use a separate command.
process.env.NODE_ENV = 'test';
for (const name of [
    'MONGO_URI',
    'MAIL_USER',
    'MAIL_PASS',
    'PAYSTACK_SECRET_KEY',
    'PAYSTACK_PUBLIC_KEY',
    'MONNIFY_API_KEY',
    'MONNIFY_SECRET_KEY',
    'FLUTTERWAVE_SECRET_KEY',
    'FLUTTERWAVE_PUBLIC_KEY',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET'
]) {
    process.env[name] = '';
}
process.env.TERMII_API_KEY = 'mock';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function targetHost(args) {
    const first = args[0];
    if (first && typeof first === 'object') {
        if (first.path && !first.host && !first.hostname) return null;
        return first.hostname || first.host || 'localhost';
    }
    if (typeof first === 'number') return typeof args[1] === 'string' ? args[1] : 'localhost';
    return null;
}

function assertLoopback(host) {
    if (host == null || loopbackHosts.has(String(host).toLowerCase())) return;
    const error = new Error('External network access is disabled during the unit test suite');
    error.code = 'TEST_EXTERNAL_NETWORK_BLOCKED';
    throw error;
}

function guardConnect(module, method) {
    const original = module[method];
    module[method] = function guardedConnection(...args) {
        assertLoopback(targetHost(args));
        return original.apply(this, args);
    };
    return module[method];
}

const net = require('node:net');
const guardedNetConnect = guardConnect(net, 'connect');
net.createConnection = guardedNetConnect;

const tls = require('node:tls');
guardConnect(tls, 'connect');

if (typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, init) {
        const rawUrl = typeof input === 'string' || input instanceof URL ? input : input?.url;
        const parsed = new URL(rawUrl);
        try {
            assertLoopback(parsed.hostname);
        } catch (error) {
            return Promise.reject(error);
        }
        return originalFetch.call(this, input, init);
    };
}
