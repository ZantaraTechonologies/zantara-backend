'use strict';

const assert = require('assert');
const http = require('http');
const { spawnSync } = require('child_process');
const express = require('express');

const authController = require('../controllers/authController');
const kycController = require('../controllers/kycController');
const authMiddleware = require('../middlewares/auth');
const limiter = require('../middlewares/limiter');
const cloudinaryUtils = require('../utils/cloudinary');
const Log = require('../models/Logs');
const Kyc = require('../models/Kyc');
const notificationService = require('../services/notification.service');
const errorHandler = require('../middlewares/errorHandler');

const originals = {
    register: authController.register,
    submitKyc: kycController.submitKyc,
    verifyJWT: authMiddleware.verifyJWT,
    kycLimiter: limiter.kycLimiter,
    storage: cloudinaryUtils.storage,
    logCreate: Log.create,
    kycFindOne: Kyc.findOne,
    kycExists: Kyc.exists,
    kycCreate: Kyc.create,
    sendInApp: notificationService.sendInApp,
    destroyKycAsset: cloudinaryUtils.destroyKycAsset,
};

let registrationCalls;
let kycControllerCalls;
let storageCalls;
let storageMode;
let lastRegistrationBody;
let lastKycFile;
let hasKnownPendingKyc;
let assetCleanupCalls;

const fakeStorage = {
    _handleFile(req, file, callback) {
        storageCalls++;
        if (storageMode === 'error') {
            file.stream.resume();
            return process.nextTick(() => callback(new Error('cloudinary secret internal failure')));
        }

        let size = 0;
        file.stream.on('data', chunk => { size += chunk.length; });
        file.stream.on('error', callback);
        file.stream.on('end', () => callback(null, {
            secure_url: 'https://res.cloudinary.com/zantara/image/authenticated/test-document.jpg',
            public_id: 'zantara/kyc/test-document',
            resource_type: 'image',
            type: 'authenticated',
            format: 'jpg',
            size,
            filename: 'test-document',
        }));
    },
    _removeFile(req, file, callback) {
        callback(null);
    },
};

function multipartBody({ fields = [], files = [], close = true } = {}) {
    const boundary = `----zantara-h12-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const chunks = [];

    for (const [name, value] of fields) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    for (const file of files) {
        chunks.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
            `Content-Type: ${file.contentType}\r\n\r\n`
        ));
        chunks.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
        chunks.push(Buffer.from('\r\n'));
    }
    if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`));

    return {
        body: Buffer.concat(chunks),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}

function request(server, { method = 'POST', path, headers = {}, body }) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined
            ? null
            : Buffer.isBuffer(body)
                ? body
                : Buffer.from(JSON.stringify(body));
        const req = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            method,
            path,
            headers: {
                ...(payload ? { 'Content-Length': payload.length } : {}),
                ...headers,
            },
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch (_) {}
                resolve({ status: res.statusCode, text, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function resetState() {
    registrationCalls = 0;
    kycControllerCalls = 0;
    storageCalls = 0;
    storageMode = 'success';
    lastRegistrationBody = null;
    lastKycFile = null;
    hasKnownPendingKyc = false;
    assetCleanupCalls = 0;
}

function loadApp() {
    authController.register = (req, res) => {
        registrationCalls++;
        lastRegistrationBody = req.body;
        return res.status(201).json({ success: true });
    };
    kycController.submitKyc = (req, res) => {
        kycControllerCalls++;
        lastKycFile = req.file;
        return res.status(201).json({ success: true });
    };
    authMiddleware.verifyJWT = (req, res, next) => {
        if (req.headers.authorization !== 'Bearer valid-test-token') {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        req.user = { id: 'user-h12', role: 'user', roles: ['user'] };
        next();
    };
    limiter.kycLimiter = (req, res, next) => next();
    cloudinaryUtils.storage = fakeStorage;
    cloudinaryUtils.destroyKycAsset = async () => {
        assetCleanupCalls++;
        return { result: 'ok' };
    };
    Kyc.exists = async () => hasKnownPendingKyc;
    Log.create = async () => ({});

    delete require.cache[require.resolve('../routes/auth')];
    delete require.cache[require.resolve('../routes/kyc')];

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/kyc', require('../routes/kyc'));
    app.use(errorHandler);
    return app.listen(0, '127.0.0.1');
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
    resetState();
    try {
        await fn();
        console.log(`[PASS] ${name}`);
        passed++;
    } catch (error) {
        console.error(`[FAIL] ${name}`);
        console.error(`  ${error.message}`);
        failed++;
    }
}

async function run() {
    const server = loadApp();
    await new Promise(resolve => server.once('listening', resolve));

    try {
        await test('JSON registration remains unchanged', async () => {
            const response = await request(server, {
                path: '/api/auth/register',
                headers: { 'Content-Type': 'application/json' },
                body: { name: 'Test', email: 'test@example.test', phone: '08000000000', password: 'secret123' },
            });
            assert.strictEqual(response.status, 201);
            assert.strictEqual(registrationCalls, 1);
            assert.strictEqual(lastRegistrationBody.email, 'test@example.test');
        });

        await test('text-only multipart registration remains supported', async () => {
            const multipart = multipartBody({ fields: [
                ['name', 'Test'],
                ['email', 'test@example.test'],
                ['phone', '08000000000'],
                ['password', 'secret123'],
            ] });
            const response = await request(server, {
                path: '/api/auth/register',
                headers: { 'Content-Type': multipart.contentType },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 201);
            assert.strictEqual(registrationCalls, 1);
        });

        await test('registration file upload is a controlled client error', async () => {
            const multipart = multipartBody({ files: [{
                field: 'avatar', filename: 'avatar.jpg', contentType: 'image/jpeg', data: 'fake',
            }] });
            const response = await request(server, {
                path: '/api/auth/register',
                headers: { 'Content-Type': multipart.contentType },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 400);
            assert.strictEqual(registrationCalls, 0);
        });

        await test('excessive registration fields are rejected safely', async () => {
            const fields = Array.from({ length: 33 }, (_, index) => [`field${index}`, 'value']);
            const multipart = multipartBody({ fields });
            const response = await request(server, {
                path: '/api/auth/register',
                headers: { 'Content-Type': multipart.contentType },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 400);
            assert.strictEqual(registrationCalls, 0);
        });

        await test('oversized registration text field is rejected safely', async () => {
            const multipart = multipartBody({ fields: [['name', 'x'.repeat((64 * 1024) + 1)]] });
            const response = await request(server, {
                path: '/api/auth/register',
                headers: { 'Content-Type': multipart.contentType },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 413);
            assert.strictEqual(registrationCalls, 0);
        });

        await test('deeply nested registration fields are rejected safely', async () => {
            const multipart = multipartBody({ fields: [['profile[a][b][c][d][e]', 'value']] });
            const response = await request(server, {
                path: '/api/auth/register',
                headers: { 'Content-Type': multipart.contentType },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 400);
            assert.strictEqual(registrationCalls, 0);
        });

        await test('large registration array indexes are rejected safely', async () => {
            const multipart = multipartBody({ fields: [['items[17]', 'value']] });
            const response = await request(server, {
                path: '/api/auth/register',
                headers: { 'Content-Type': multipart.contentType },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 400);
            assert.strictEqual(registrationCalls, 0);
        });

        await test('malformed registration multipart fails without an uncaught process error', async () => {
            const multipart = multipartBody({ fields: [['name', 'Test']], close: false });
            const response = await request(server, {
                path: '/api/auth/register',
                headers: { 'Content-Type': multipart.contentType },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 400);
            assert.strictEqual(registrationCalls, 0);
        });

        await test('anonymous KYC is rejected before Multer storage', async () => {
            const multipart = multipartBody({ files: [{
                field: 'document', filename: 'document.jpg', contentType: 'image/jpeg', data: 'fake',
            }] });
            const response = await request(server, {
                path: '/api/kyc/submit',
                headers: { 'Content-Type': multipart.contentType },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 401);
            assert.strictEqual(storageCalls, 0);
            assert.strictEqual(kycControllerCalls, 0);
        });

        await test('malformed authenticated KYC multipart is rejected safely', async () => {
            const multipart = multipartBody({ fields: [['tier', '2']], close: false });
            const response = await request(server, {
                path: '/api/kyc/submit',
                headers: { 'Content-Type': multipart.contentType, Authorization: 'Bearer valid-test-token' },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 400);
            assert.strictEqual(storageCalls, 0);
            assert.strictEqual(kycControllerCalls, 0);
        });

        await test('known pending KYC is rejected before storage', async () => {
            hasKnownPendingKyc = true;
            const multipart = multipartBody({ files: [{
                field: 'document', filename: 'document.jpg', contentType: 'image/jpeg', data: 'fake',
            }] });
            const response = await request(server, {
                path: '/api/kyc/submit',
                headers: { 'Content-Type': multipart.contentType, Authorization: 'Bearer valid-test-token' },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 400);
            assert.strictEqual(storageCalls, 0);
            assert.strictEqual(kycControllerCalls, 0);
        });

        for (const [label, contentType] of [
            ['JPEG', 'image/jpeg'],
            ['PNG', 'image/png'],
            ['PDF', 'application/pdf'],
        ]) {
            await test(`authenticated ${label} KYC upload is accepted`, async () => {
                const multipart = multipartBody({
                    fields: [
                        ['tier', '2'],
                        ['documentType', 'national-id'],
                        ['documentNumber', 'ID-123'],
                        ['address', 'Test address'],
                    ],
                    files: [{
                        field: 'document', filename: `document.${label.toLowerCase()}`, contentType, data: 'valid-test-file',
                    }],
                });
                const response = await request(server, {
                    path: '/api/kyc/submit',
                    headers: { 'Content-Type': multipart.contentType, Authorization: 'Bearer valid-test-token' },
                    body: multipart.body,
                });
                assert.strictEqual(response.status, 201);
                assert.strictEqual(storageCalls, 1);
                assert.strictEqual(kycControllerCalls, 1);
                assert.strictEqual(lastKycFile.public_id, 'zantara/kyc/test-document');
                assert.strictEqual(lastKycFile.type, 'authenticated');
            });
        }

        await test('oversized KYC file is rejected before controller persistence', async () => {
            const multipart = multipartBody({ files: [{
                field: 'document', filename: 'large.jpg', contentType: 'image/jpeg', data: Buffer.alloc((10 * 1024 * 1024) + 1),
            }] });
            const response = await request(server, {
                path: '/api/kyc/submit',
                headers: { 'Content-Type': multipart.contentType, Authorization: 'Bearer valid-test-token' },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 413);
            assert.strictEqual(kycControllerCalls, 0);
        });

        await test('excessive KYC fields are rejected before storage', async () => {
            const fields = Array.from({ length: 5 }, (_, index) => [`field${index}`, 'value']);
            const multipart = multipartBody({ fields });
            const response = await request(server, {
                path: '/api/kyc/submit',
                headers: { 'Content-Type': multipart.contentType, Authorization: 'Bearer valid-test-token' },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 400);
            assert.strictEqual(storageCalls, 0);
            assert.strictEqual(kycControllerCalls, 0);
        });

        await test('oversized KYC text fields are rejected before storage', async () => {
            const multipart = multipartBody({ fields: [['address', 'x'.repeat((64 * 1024) + 1)]] });
            const response = await request(server, {
                path: '/api/kyc/submit',
                headers: { 'Content-Type': multipart.contentType, Authorization: 'Bearer valid-test-token' },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 413);
            assert.strictEqual(storageCalls, 0);
            assert.strictEqual(kycControllerCalls, 0);
        });

        await test('deeply nested KYC fields are rejected before storage', async () => {
            const multipart = multipartBody({ fields: [['address[street][line]', 'value']] });
            const response = await request(server, {
                path: '/api/kyc/submit',
                headers: { 'Content-Type': multipart.contentType, Authorization: 'Bearer valid-test-token' },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 400);
            assert.strictEqual(storageCalls, 0);
            assert.strictEqual(kycControllerCalls, 0);
        });

        await test('KYC array indexes are rejected before storage', async () => {
            const multipart = multipartBody({ fields: [['address[1]', 'value']] });
            const response = await request(server, {
                path: '/api/kyc/submit',
                headers: { 'Content-Type': multipart.contentType, Authorization: 'Bearer valid-test-token' },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 400);
            assert.strictEqual(storageCalls, 0);
            assert.strictEqual(kycControllerCalls, 0);
        });

        await test('unexpected KYC file field is rejected safely', async () => {
            const multipart = multipartBody({ files: [{
                field: 'avatar', filename: 'document.jpg', contentType: 'image/jpeg', data: 'fake',
            }] });
            const response = await request(server, {
                path: '/api/kyc/submit',
                headers: { 'Content-Type': multipart.contentType, Authorization: 'Bearer valid-test-token' },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 400);
            assert.strictEqual(kycControllerCalls, 0);
        });

        await test('multiple KYC files are rejected safely', async () => {
            const multipart = multipartBody({ files: [
                { field: 'document', filename: 'one.jpg', contentType: 'image/jpeg', data: 'one' },
                { field: 'document', filename: 'two.jpg', contentType: 'image/jpeg', data: 'two' },
            ] });
            const response = await request(server, {
                path: '/api/kyc/submit',
                headers: { 'Content-Type': multipart.contentType, Authorization: 'Bearer valid-test-token' },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 400);
            assert.strictEqual(kycControllerCalls, 0);
            assert.strictEqual(assetCleanupCalls, 1);
        });

        await test('disallowed KYC MIME type is rejected before storage', async () => {
            const multipart = multipartBody({ files: [{
                field: 'document', filename: 'payload.svg', contentType: 'image/svg+xml', data: '<svg/>',
            }] });
            const response = await request(server, {
                path: '/api/kyc/submit',
                headers: { 'Content-Type': multipart.contentType, Authorization: 'Bearer valid-test-token' },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 415);
            assert.strictEqual(storageCalls, 0);
            assert.strictEqual(kycControllerCalls, 0);
        });

        await test('Cloudinary storage error is controlled and does not persist', async () => {
            storageMode = 'error';
            const multipart = multipartBody({ files: [{
                field: 'document', filename: 'document.jpg', contentType: 'image/jpeg', data: 'fake',
            }] });
            const response = await request(server, {
                path: '/api/kyc/submit',
                headers: { 'Content-Type': multipart.contentType, Authorization: 'Bearer valid-test-token' },
                body: multipart.body,
            });
            assert.strictEqual(response.status, 502);
            assert.strictEqual(kycControllerCalls, 0);
            assert.ok(!response.text.includes('cloudinary secret internal failure'));
        });

        await test('production storage receives the Cloudinary root module shape', async () => {
            assert.strictEqual(typeof originals.storage.cloudinary?.v2?.uploader?.upload_stream, 'function');
        });

        await test('production storage invokes Cloudinary uploader without an uncaught exception', async () => {
            const script = `
                const { Writable, Readable } = require('stream');
                const root = require('cloudinary');
                root.v2.uploader.upload_stream = (params, cb) => {
                    if (params.folder !== 'zantara/kyc') throw new Error('invalid folder');
                    if (typeof params.public_id !== 'string') throw new Error('public_id was not resolved');
                    if (!params.allowed_formats.includes('pdf')) throw new Error('missing allowed format');
                    if (params.type !== 'authenticated') throw new Error('delivery is not authenticated');
                    if (params.resource_type !== 'image') throw new Error('invalid resource type');
                    console.log('UPLOADER_INVOKED');
                    const stream = new Writable({ write(chunk, enc, done) { done(); } });
                    stream.on('finish', () => cb(null, {
                        secure_url: 'https://example.test/doc',
                        public_id: 'doc',
                        resource_type: 'image',
                        type: 'authenticated',
                        format: 'jpg',
                        bytes: 4
                    }));
                    return stream;
                };
                const { storage } = require('./utils/cloudinary');
                storage._handleFile({ user: { id: 'user-h12' } }, { originalname: 'doc.jpg', stream: Readable.from(['test']) }, (err, info) => {
                    if (err) { console.error(err.message); process.exit(1); }
                    console.log('CALLBACK_OK ' + info.secure_url);
                });
            `;
            const child = spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8' });
            assert.strictEqual(child.status, 0, child.stderr || child.stdout);
            assert.match(child.stdout, /UPLOADER_INVOKED/);
            assert.match(child.stdout, /CALLBACK_OK/);
        });

        await test('controller persists authenticated Cloudinary metadata without a permanent URL', async () => {
            let created;
            Kyc.findOne = async () => null;
            Kyc.create = async doc => { created = doc; return { ...doc, _id: 'kyc-h12' }; };
            notificationService.sendInApp = async () => {};
            const res = {
                statusCode: 200,
                status(code) { this.statusCode = code; return this; },
                json(body) { this.body = body; return this; },
            };
            await originals.submitKyc({
                user: { id: 'user-h12' },
                body: { tier: 2, documentType: 'national-id', documentNumber: 'ID-123' },
                file: {
                    secure_url: 'https://res.cloudinary.com/zantara/image/authenticated/secure-document.jpg',
                    public_id: 'zantara/kyc/secure-document',
                    resource_type: 'image',
                    type: 'authenticated',
                    format: 'jpg'
                },
            }, res);
            assert.strictEqual(created.documentPublicId, 'zantara/kyc/secure-document');
            assert.strictEqual(created.documentDeliveryType, 'authenticated');
            assert.ok(!Object.prototype.hasOwnProperty.call(created, 'documentImage'));
            assert.ok(!JSON.stringify(res.body).includes('res.cloudinary.com'));
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }

    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    authController.register = originals.register;
    kycController.submitKyc = originals.submitKyc;
    authMiddleware.verifyJWT = originals.verifyJWT;
    limiter.kycLimiter = originals.kycLimiter;
    cloudinaryUtils.storage = originals.storage;
    Log.create = originals.logCreate;
    Kyc.findOne = originals.kycFindOne;
    Kyc.exists = originals.kycExists;
    Kyc.create = originals.kycCreate;
    notificationService.sendInApp = originals.sendInApp;
    cloudinaryUtils.destroyKycAsset = originals.destroyKycAsset;
    delete require.cache[require.resolve('../routes/auth')];
    delete require.cache[require.resolve('../routes/kyc')];
});
