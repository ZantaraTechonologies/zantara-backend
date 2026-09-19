'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');

const Kyc = require('../models/Kyc');
const notificationService = require('../services/notification.service');
const cloudinaryUtils = require('../utils/cloudinary');
const kycController = require('../controllers/kycController');
const authMiddleware = require('../middlewares/auth');

const originals = {
    findOne: Kyc.findOne,
    findById: Kyc.findById,
    create: Kyc.create,
    sendInApp: notificationService.sendInApp,
    destroyKycAsset: cloudinaryUtils.destroyKycAsset,
    generateKycDocumentAccess: cloudinaryUtils.generateKycDocumentAccess,
    privateDownloadUrl: cloudinaryUtils.cloudinary.utils.private_download_url,
    cloudinaryDestroy: cloudinaryUtils.cloudinary.uploader.destroy,
    verifyJWT: authMiddleware.verifyJWT,
    checkRoles: authMiddleware.checkRoles,
    getKycDocumentAccess: kycController.getKycDocumentAccess,
};

const validFile = (overrides = {}) => ({
    secure_url: 'https://res.cloudinary.com/zantara/image/authenticated/v1/zantara/kyc/document.jpg',
    public_id: 'zantara/kyc/document',
    resource_type: 'image',
    type: 'authenticated',
    format: 'jpg',
    bytes: 1024,
    ...overrides,
});

const validBody = (overrides = {}) => ({
    tier: 2,
    documentType: 'national-id',
    documentNumber: 'ID-123',
    address: 'Test address',
    ...overrides,
});

function makeRes() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
        json(body) { this.body = body; return this; },
    };
}

function request(server, { path, authorization }) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            path,
            method: 'GET',
            headers: authorization ? { Authorization: authorization } : {},
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
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
    let createdDocs = [];
    let cleanupCalls = [];

    const resetControllerState = () => {
        createdDocs = [];
        cleanupCalls = [];
        Kyc.findOne = async () => null;
        Kyc.create = async doc => {
            createdDocs.push(doc);
            return { ...doc, _id: '507f1f77bcf86cd799439012' };
        };
        notificationService.sendInApp = async () => {};
        cloudinaryUtils.destroyKycAsset = async asset => {
            cleanupCalls.push(asset);
            return { result: 'ok' };
        };
    };

    const submit = async ({ body = validBody(), file } = {}) => {
        const res = makeRes();
        await kycController.submitKyc({
            user: { id: '507f1f77bcf86cd799439011' },
            body,
            file,
        }, res);
        return res;
    };

    try {
        await test('missing KYC document fails without persistence', async () => {
            resetControllerState();
            const res = await submit();
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(createdDocs.length, 0);
            assert.strictEqual(cleanupCalls.length, 0);
        });

        await test('storage result missing public identifier fails without persistence', async () => {
            resetControllerState();
            const res = await submit({ file: validFile({ public_id: undefined }) });
            assert.strictEqual(res.statusCode, 502);
            assert.strictEqual(createdDocs.length, 0);
        });

        await test('storage result missing access metadata fails and is cleaned', async () => {
            resetControllerState();
            const res = await submit({ file: validFile({ type: undefined }) });
            assert.strictEqual(res.statusCode, 502);
            assert.strictEqual(createdDocs.length, 0);
            assert.strictEqual(cleanupCalls.length, 1);
        });

        await test('storage result missing secure URL fails and is cleaned', async () => {
            resetControllerState();
            const res = await submit({ file: validFile({ secure_url: undefined }) });
            assert.strictEqual(res.statusCode, 502);
            assert.strictEqual(createdDocs.length, 0);
            assert.strictEqual(cleanupCalls.length, 1);
        });

        await test('non-HTTPS storage URL fails and is cleaned', async () => {
            resetControllerState();
            const res = await submit({ file: validFile({ secure_url: 'http://example.test/document.jpg' }) });
            assert.strictEqual(res.statusCode, 502);
            assert.strictEqual(createdDocs.length, 0);
            assert.strictEqual(cleanupCalls.length, 1);
        });

        await test('required-field rejection cleans the uploaded asset', async () => {
            resetControllerState();
            const res = await submit({ body: validBody({ documentNumber: '' }), file: validFile() });
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(createdDocs.length, 0);
            assert.strictEqual(cleanupCalls.length, 1);
        });

        await test('existing-pending rejection cleans the newly uploaded asset', async () => {
            resetControllerState();
            Kyc.findOne = async () => ({ _id: 'existing' });
            const res = await submit({ file: validFile() });
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(createdDocs.length, 0);
            assert.strictEqual(cleanupCalls.length, 1);
        });

        await test('Kyc.create failure cleans the asset and hides the database error', async () => {
            resetControllerState();
            Kyc.create = async () => { throw new Error('database topology secret'); };
            const res = await submit({ file: validFile() });
            assert.strictEqual(res.statusCode, 500);
            assert.strictEqual(cleanupCalls.length, 1);
            assert.ok(!JSON.stringify(res.body).includes('database topology secret'));
        });

        await test('cleanup failure preserves the primary validation failure', async () => {
            resetControllerState();
            let cleanupAttempts = 0;
            cloudinaryUtils.destroyKycAsset = async () => {
                cleanupAttempts++;
                throw new Error('cloudinary cleanup secret');
            };
            const res = await submit({ body: validBody({ documentType: '' }), file: validFile() });
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(createdDocs.length, 0);
            assert.strictEqual(cleanupAttempts, 1);
            assert.ok(!JSON.stringify(res.body).includes('cloudinary cleanup secret'));
        });

        await test('successful KYC persists authenticated asset metadata without a permanent URL', async () => {
            resetControllerState();
            const res = await submit({ file: validFile() });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(createdDocs.length, 1);
            assert.strictEqual(createdDocs[0].documentPublicId, 'zantara/kyc/document');
            assert.strictEqual(createdDocs[0].documentResourceType, 'image');
            assert.strictEqual(createdDocs[0].documentDeliveryType, 'authenticated');
            assert.strictEqual(createdDocs[0].documentFormat, 'jpg');
            assert.ok(!Object.prototype.hasOwnProperty.call(createdDocs[0], 'documentImage'));
            assert.strictEqual(cleanupCalls.length, 0);
            const responseText = JSON.stringify(res.body);
            assert.ok(!responseText.includes('res.cloudinary.com'));
            assert.ok(!responseText.includes('documentPublicId'));
        });

        await test('notification failure after persistence keeps success and does not clean the asset', async () => {
            resetControllerState();
            notificationService.sendInApp = async () => { throw new Error('notification unavailable'); };
            const res = await submit({ file: validFile() });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(createdDocs.length, 1);
            assert.strictEqual(cleanupCalls.length, 0);
        });

        await test('KYC Cloudinary upload explicitly uses authenticated delivery', async () => {
            const params = await new Promise((resolve, reject) => {
                cloudinaryUtils.storage.getParams(
                    { user: { id: '507f1f77bcf86cd799439011' } },
                    { originalname: 'identity.pdf' },
                    (err, result) => err ? reject(err) : resolve(result)
                );
            });
            assert.strictEqual(params.type, 'authenticated');
            assert.strictEqual(params.resource_type, 'image');
            assert.strictEqual(params.overwrite, false);
            assert.ok(!params.public_id.includes('507f1f77bcf86cd799439011'));
        });

        await test('temporary document access uses authenticated private download with five-minute expiry', async () => {
            assert.strictEqual(typeof cloudinaryUtils.generateKycDocumentAccess, 'function');
            let captured;
            cloudinaryUtils.cloudinary.utils.private_download_url = (publicId, format, options) => {
                captured = { publicId, format, options };
                return 'https://api.cloudinary.com/temporary-signed-download';
            };
            const before = Math.floor(Date.now() / 1000);
            const access = cloudinaryUtils.generateKycDocumentAccess({
                publicId: 'zantara/kyc/document',
                resourceType: 'image',
                deliveryType: 'authenticated',
                format: 'pdf',
            });
            assert.strictEqual(captured.publicId, 'zantara/kyc/document');
            assert.strictEqual(captured.format, 'pdf');
            assert.strictEqual(captured.options.type, 'authenticated');
            assert.strictEqual(captured.options.resource_type, 'image');
            assert.ok(captured.options.expires_at >= before + 299);
            assert.ok(captured.options.expires_at <= before + 301);
            assert.strictEqual(access.expiresAt, captured.options.expires_at);
        });

        await test('KYC cleanup uses the authenticated identity tuple', async () => {
            let captured;
            cloudinaryUtils.cloudinary.uploader.destroy = async (publicId, options) => {
                captured = { publicId, options };
                return { result: 'ok' };
            };
            await originals.destroyKycAsset({
                publicId: 'zantara/kyc/document',
                resourceType: 'image',
                deliveryType: 'authenticated',
            });
            assert.strictEqual(captured.publicId, 'zantara/kyc/document');
            assert.deepStrictEqual(captured.options, {
                resource_type: 'image',
                type: 'authenticated',
                invalidate: true,
            });
        });

        await test('authorized admin obtains only temporary controlled document access', async () => {
            assert.strictEqual(typeof kycController.getKycDocumentAccess, 'function');
            Kyc.findById = () => ({
                select: async () => ({
                    documentPublicId: 'zantara/kyc/document',
                    documentResourceType: 'image',
                    documentDeliveryType: 'authenticated',
                    documentFormat: 'pdf',
                }),
            });
            cloudinaryUtils.generateKycDocumentAccess = () => ({
                url: 'https://api.cloudinary.com/temporary-signed-download',
                expiresAt: 1234567890,
            });
            const res = makeRes();
            await kycController.getKycDocumentAccess({
                params: { id: '507f1f77bcf86cd799439012' },
                user: { id: 'admin', roles: ['admin'] },
            }, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.url, 'https://api.cloudinary.com/temporary-signed-download');
            assert.strictEqual(res.body.data.expiresAt, 1234567890);
            assert.strictEqual(res.headers['cache-control'], 'no-store');
        });

        await test('legacy public KYC record does not return its permanent URL', async () => {
            assert.strictEqual(typeof kycController.getKycDocumentAccess, 'function');
            Kyc.findById = () => ({
                select: async () => ({ documentImage: 'https://res.cloudinary.com/public-legacy-document' }),
            });
            const res = makeRes();
            await kycController.getKycDocumentAccess({
                params: { id: '507f1f77bcf86cd799439012' },
                user: { id: 'admin', roles: ['admin'] },
            }, res);
            assert.strictEqual(res.statusCode, 409);
            assert.ok(!JSON.stringify(res.body).includes('res.cloudinary.com'));
        });

        await test('legacy or incomplete KYC record cannot be approved', async () => {
            let saveCalls = 0;
            Kyc.findById = () => ({
                select: async () => ({
                    documentImage: 'https://res.cloudinary.com/public-legacy-document',
                    save: async () => { saveCalls++; },
                }),
            });
            const res = makeRes();
            await kycController.reviewKyc({
                params: { id: '507f1f77bcf86cd799439012' },
                body: { status: 'approved' },
                user: { id: 'admin', name: 'Admin' },
            }, res);
            assert.strictEqual(res.statusCode, 409);
            assert.strictEqual(saveCalls, 0);
            assert.ok(!JSON.stringify(res.body).includes('res.cloudinary.com'));
        });

        await test('document access rejects malformed KYC IDs before lookup', async () => {
            let lookupCalls = 0;
            Kyc.findById = () => { lookupCalls++; return null; };
            const res = makeRes();
            await kycController.getKycDocumentAccess({
                params: { id: 'not-an-object-id' },
                user: { id: 'admin', roles: ['admin'] },
            }, res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(lookupCalls, 0);
        });

        await test('document access returns normal not-found response', async () => {
            Kyc.findById = () => ({ select: async () => null });
            const res = makeRes();
            await kycController.getKycDocumentAccess({
                params: { id: '507f1f77bcf86cd799439012' },
                user: { id: 'admin', roles: ['admin'] },
            }, res);
            assert.strictEqual(res.statusCode, 404);
        });

        await test('sensitive KYC asset fields are hidden by default in the schema', async () => {
            for (const field of [
                'documentImage',
                'documentPublicId',
                'documentResourceType',
                'documentDeliveryType',
                'documentFormat',
            ]) {
                assert.strictEqual(Kyc.schema.path(field)?.options?.select, false, `${field} must be select:false`);
            }
        });

        await test('admin document route rejects anonymous and ordinary users but allows admin', async () => {
            authMiddleware.verifyJWT = (req, res, next) => {
                const token = req.headers.authorization;
                if (!token) return res.status(401).json({ message: 'Not authenticated' });
                req.user = token === 'Bearer admin'
                    ? { id: 'admin', role: 'admin', roles: ['admin'] }
                    : { id: 'user', role: 'user', roles: ['user'] };
                return next();
            };
            authMiddleware.checkRoles = (...allowed) => (req, res, next) => {
                const roles = [req.user?.role, ...(req.user?.roles || [])].filter(Boolean);
                if (!roles.some(role => allowed.includes(role))) {
                    return res.status(403).json({ message: 'Forbidden' });
                }
                return next();
            };
            kycController.getKycDocumentAccess = (req, res) => res.status(200).json({ success: true });

            delete require.cache[require.resolve('../routes/admin')];
            const app = express();
            app.use('/api/admin', require('../routes/admin'));
            const server = app.listen(0, '127.0.0.1');
            await new Promise(resolve => server.once('listening', resolve));
            try {
                const path = '/api/admin/kyc/507f1f77bcf86cd799439012/document';
                const anonymous = await request(server, { path });
                const ordinary = await request(server, { path, authorization: 'Bearer user' });
                const admin = await request(server, { path, authorization: 'Bearer admin' });
                assert.strictEqual(anonymous.status, 401);
                assert.strictEqual(ordinary.status, 403);
                assert.strictEqual(admin.status, 200);
            } finally {
                await new Promise(resolve => server.close(resolve));
            }
        });
    } finally {
        Kyc.findOne = originals.findOne;
        Kyc.findById = originals.findById;
        Kyc.create = originals.create;
        notificationService.sendInApp = originals.sendInApp;
        cloudinaryUtils.cloudinary.utils.private_download_url = originals.privateDownloadUrl;
        cloudinaryUtils.cloudinary.uploader.destroy = originals.cloudinaryDestroy;
        authMiddleware.verifyJWT = originals.verifyJWT;
        authMiddleware.checkRoles = originals.checkRoles;

        if (originals.destroyKycAsset === undefined) delete cloudinaryUtils.destroyKycAsset;
        else cloudinaryUtils.destroyKycAsset = originals.destroyKycAsset;
        if (originals.generateKycDocumentAccess === undefined) delete cloudinaryUtils.generateKycDocumentAccess;
        else cloudinaryUtils.generateKycDocumentAccess = originals.generateKycDocumentAccess;
        if (originals.getKycDocumentAccess === undefined) delete kycController.getKycDocumentAccess;
        else kycController.getKycDocumentAccess = originals.getKycDocumentAccess;

        delete require.cache[require.resolve('../routes/admin')];
    }

    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
