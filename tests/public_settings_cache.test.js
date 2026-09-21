'use strict';

/**
 * Public branding/support settings cache regression tests.
 *
 * Run: node tests/public_settings_cache.test.js
 */
const assert = require('assert');
const Setting = require('../models/Setting');
const AuditLog = require('../models/AuditLog');
const settingsService = require('../services/settings.service');
const adminSettingController = require('../controllers/adminSettingController');
const adminRouter = require('../routes/admin');
const settingsRouter = require('../routes/settings');

const PUBLIC_KEYS = [
    'SITE_NAME',
    'SITE_URL',
    'SITE_LOGO',
    'SUPPORT_EMAIL',
    'SUPPORT_PHONE'
];

const originalMethods = {
    find: Setting.find,
    findOneAndUpdate: Setting.findOneAndUpdate,
    bulkWrite: Setting.bulkWrite,
    auditCreate: AuditLog.create,
    updateSetting: settingsService.updateSetting
};

const persisted = new Map([
    ['SITE_NAME', 'Old Brand'],
    ['SITE_URL', 'https://old.example.com'],
    ['SITE_LOGO', 'https://old.example.com/logo.png'],
    ['SUPPORT_EMAIL', 'old@example.com'],
    ['SUPPORT_PHONE', '+234 800 000 0000']
]);

let findCalls = 0;
let genericServiceCalls = 0;

Setting.find = async () => {
    findCalls++;
    return [...persisted].map(([key, value]) => ({ key, value }));
};

Setting.findOneAndUpdate = async ({ key }, update) => {
    persisted.set(key, update.value);
    return { key, value: update.value };
};

Setting.bulkWrite = async (operations) => {
    for (const { updateOne } of operations) {
        persisted.set(updateOne.filter.key, updateOne.update.value);
    }
    return { modifiedCount: operations.length };
};

AuditLog.create = async data => data;

settingsService.updateSetting = async function (...args) {
    genericServiceCalls++;
    return originalMethods.updateSetting.apply(this, args);
};

function makeRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };
}

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        console.log(`  [PASS] ${name}`);
        passed++;
    } catch (error) {
        console.error(`  [FAIL] ${name}`);
        console.error(`         ${error.message}`);
        failures.push(`${name}: ${error.message}`);
        failed++;
    }
}

async function run() {
    console.log('====================================================');
    console.log('  PUBLIC SETTINGS CACHE TESTS');
    console.log('====================================================\n');

    try {
        settingsService.cache.clear();
        settingsService.lastRefresh = 0;
        await settingsService.refreshCache();

        const updates = {
            SITE_NAME: 'New Brand',
            SITE_URL: 'https://new.example.com',
            SITE_LOGO: 'https://new.example.com/logo.png',
            SUPPORT_EMAIL: 'support@new.example.com',
            SUPPORT_PHONE: '+234 811 111 1111'
        };

        await test('business admin update persists all five public settings', async () => {
            const res = makeRes();
            await adminSettingController.updateBusinessSettings({ body: updates }, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.success, true);
            for (const key of PUBLIC_KEYS) {
                assert.strictEqual(persisted.get(key), updates[key], `${key} was not persisted`);
            }
        });

        await test('business admin update refreshes stale cached values', async () => {
            assert.ok(findCalls >= 2, 'bulk update did not refresh the settings cache');
            for (const key of PUBLIC_KEYS) {
                assert.strictEqual(await settingsService.getSetting(key), updates[key], `${key} cache is stale`);
            }
        });

        await test('GET /api/settings/public returns the updated values', async () => {
            const layer = settingsRouter.stack.find(item => item.route?.path === '/public' && item.route.methods.get);
            assert.ok(layer, 'public settings route not found');

            const res = makeRes();
            await layer.route.stack[0].handle({}, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.success, true);
            for (const key of PUBLIC_KEYS) {
                assert.strictEqual(res.body.data[key], updates[key], `${key} public value is stale`);
            }
        });

        await test('generic POST /api/admin/settings cannot bypass the cache for any public key', async () => {
            const layer = adminRouter.stack.find(item => item.route?.path === '/settings' && item.route.methods.post);
            assert.ok(layer, 'generic admin settings route not found');
            const handler = layer.route.stack[layer.route.stack.length - 1].handle;
            const genericUpdates = {
                SITE_NAME: 'Generic Brand',
                SITE_URL: 'https://generic.example.com',
                SITE_LOGO: 'https://generic.example.com/logo.png',
                SUPPORT_EMAIL: 'support@generic.example.com',
                SUPPORT_PHONE: '+234 822 222 2222'
            };

            for (const [key, value] of Object.entries(genericUpdates)) {
                const res = makeRes();
                const req = {
                    body: { key, value },
                    user: { id: 'admin-1', name: 'Test SuperAdmin' },
                    headers: {},
                    ip: '127.0.0.1'
                };

                await handler(req, res);

                assert.strictEqual(res.statusCode, 200);
                assert.strictEqual(res.body.success, true);
                assert.strictEqual(persisted.get(key), value, `${key} was not persisted by the generic path`);
                assert.strictEqual(await settingsService.getSetting(key), value, `${key} cache was not updated`);
            }

            assert.strictEqual(genericServiceCalls, PUBLIC_KEYS.length, 'a public key bypassed settingsService.updateSetting');
        });
    } finally {
        Setting.find = originalMethods.find;
        Setting.findOneAndUpdate = originalMethods.findOneAndUpdate;
        Setting.bulkWrite = originalMethods.bulkWrite;
        AuditLog.create = originalMethods.auditCreate;
        settingsService.updateSetting = originalMethods.updateSetting;
        settingsService.cache.clear();
        settingsService.lastRefresh = 0;
    }

    console.log('\n====================================================');
    console.log(`  RESULT: ${passed} passed, ${failed} failed`);
    if (failures.length) failures.forEach(failure => console.log(`  - ${failure}`));
    console.log('====================================================');
    process.exitCode = failed ? 1 : 0;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
