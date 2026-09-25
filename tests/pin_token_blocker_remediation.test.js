'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const SmsDelivery = require('../models/SmsDelivery');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const settingsService = require('../services/settings.service');
const purchaseService = require('../services/purchase.service');
const notificationService = require('../services/notification.service');
const { encryptFulfillment } = require('../utils/fulfillment');
const {
    encryptSecret,
    isEncrypted,
    validateEncryptionConfiguration,
} = require('../utils/crypto');

let passed = 0;
let failed = 0;

async function test(name, operation) {
    try {
        await operation();
        console.log(`[PASS] ${name}`);
        passed++;
    } catch (error) {
        console.error(`[FAIL] ${name}`);
        console.error(`       ${error.message}`);
        if (process.env.VERBOSE) console.error(error.stack);
        failed++;
    }
}

const idString = value => String(value?._id || value || '');

function installSmsDeliveryStore() {
    const records = new Map();
    let sequence = 0;

    const same = (left, right) => idString(left) === idString(right);
    const matchesState = (record, clause) => {
        if (clause.status && record.status !== clause.status) return false;
        if (clause.updatedAt?.$lt && !(record.updatedAt < clause.updatedAt.$lt)) return false;
        return true;
    };
    const matches = (record, filter) => {
        if (filter._id && !same(record._id, filter._id)) return false;
        if (filter.userId && !same(record.userId, filter.userId)) return false;
        if (filter.eventKey && record.eventKey !== filter.eventKey) return false;
        if (filter.reference && record.reference !== filter.reference) return false;
        if (filter.batchIndex !== undefined && record.batchIndex !== filter.batchIndex) return false;
        if (filter.status && typeof filter.status === 'string' && record.status !== filter.status) return false;
        if (filter.status?.$ne && record.status === filter.status.$ne) return false;
        if (filter.attempts?.$lt !== undefined && !(record.attempts < filter.attempts.$lt)) return false;
        if (typeof filter.attempts === 'number' && record.attempts !== filter.attempts) return false;
        if (filter.updatedAt?.$lt && !(record.updatedAt < filter.updatedAt.$lt)) return false;
        if (filter.$or && !filter.$or.some(clause => matchesState(record, clause))) return false;
        return true;
    };
    const duplicate = () => {
        const error = new Error('duplicate');
        error.code = 11000;
        return error;
    };

    const originals = {
        create: SmsDelivery.create,
        find: SmsDelivery.find,
        findOne: SmsDelivery.findOne,
        findOneAndUpdate: SmsDelivery.findOneAndUpdate,
        updateOne: SmsDelivery.updateOne,
    };

    SmsDelivery.create = async document => {
        const key = `${idString(document.userId)}:${document.eventKey}`;
        if (records.has(key)) throw duplicate();
        const now = new Date();
        const record = {
            _id: `sms-${++sequence}`,
            createdAt: now,
            updatedAt: now,
            ...document,
        };
        records.set(key, record);
        return { ...record };
    };
    SmsDelivery.findOneAndUpdate = async (filter, update) => {
        const record = [...records.values()].find(item => matches(item, filter));
        if (!record) return null;
        Object.assign(record, update.$set || {});
        if (update.$inc?.attempts) record.attempts += update.$inc.attempts;
        record.updatedAt = new Date();
        return { ...record };
    };
    SmsDelivery.findOne = async filter => {
        const record = [...records.values()].find(item => matches(item, filter));
        return record ? { ...record } : null;
    };
    SmsDelivery.updateOne = async (filter, update) => {
        const record = [...records.values()].find(item => matches(item, filter));
        if (!record) return { modifiedCount: 0 };
        Object.assign(record, update.$set || {});
        record.updatedAt = new Date();
        return { modifiedCount: 1 };
    };
    SmsDelivery.find = filter => {
        let result = [...records.values()].filter(item => matches(item, filter));
        const query = {
            sort(specification) {
                result.sort((left, right) => {
                    for (const [field, direction] of Object.entries(specification)) {
                        const comparison = String(left[field]).localeCompare(String(right[field]));
                        if (comparison) return comparison * direction;
                    }
                    return 0;
                });
                return query;
            },
            limit: async count => result.slice(0, count).map(item => ({ ...item })),
        };
        return query;
    };

    return {
        records,
        put(document) {
            const now = document.updatedAt || new Date();
            const record = {
                _id: document._id || `sms-${++sequence}`,
                createdAt: document.createdAt || now,
                ...document,
                updatedAt: now,
            };
            records.set(`${idString(record.userId)}:${record.eventKey}`, record);
            return record;
        },
        get(userId, eventKey) {
            return records.get(`${idString(userId)}:${eventKey}`);
        },
        clear() {
            records.clear();
        },
        restore() {
            Object.assign(SmsDelivery, originals);
        },
    };
}

async function withEnvironment(values, operation) {
    const originals = {};
    for (const [name, value] of Object.entries(values)) {
        originals[name] = process.env[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    try {
        return await operation();
    } finally {
        for (const [name, value] of Object.entries(originals)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

async function main() {
    console.log('====================================================');
    console.log(' PIN/TOKEN BLOCKER REMEDIATION TESTS');
    console.log('====================================================\n');

    const store = installSmsDeliveryStore();
    const userId = new mongoose.Types.ObjectId();
    const originalSendSMS = notificationService.sendSMS;
    const originalTransactionFindOne = Transaction.findOne;
    const originalUserFindById = User.findById;
    const originalGetSetting = settingsService.getSetting;
    const originalProcessPurchase = purchaseService.processPurchase;
    const originalSetTimeout = global.setTimeout;

    try {
        await test('attempts 0, 1, and 2 are atomically claimable and increment once', async () => {
            for (const attempts of [0, 1, 2]) {
                store.clear();
                const eventKey = `purchase_success:REF-${attempts}:sms:1`;
                store.put({ userId, eventKey, reference: `REF-${attempts}`, batchIndex: 1, attempts, status: 'failed' });
                const claimed = await notificationService._claimCredentialSmsBatch({
                    userId, eventKey, reference: `REF-${attempts}`, batchIndex: 1,
                });
                assert.ok(claimed);
                assert.strictEqual(claimed.attempts, attempts + 1);
                assert.strictEqual(claimed.status, 'dispatching');
            }
        });

        await test('attempts 3 and attempts above 3 are never reclaimed', async () => {
            for (const attempts of [3, 4, 9]) {
                store.clear();
                const eventKey = `purchase_success:LIMIT-${attempts}:sms:1`;
                store.put({ userId, eventKey, reference: `LIMIT-${attempts}`, batchIndex: 1, attempts, status: 'failed' });
                const claimed = await notificationService._claimCredentialSmsBatch({
                    userId, eventKey, reference: `LIMIT-${attempts}`, batchIndex: 1,
                });
                assert.strictEqual(claimed, null);
                assert.strictEqual(store.get(userId, eventKey).attempts, attempts);
            }
        });

        await test('delivered rows are never reclaimed', async () => {
            store.clear();
            const eventKey = 'purchase_success:DELIVERED:sms:1';
            store.put({ userId, eventKey, reference: 'DELIVERED', batchIndex: 1, attempts: 1, status: 'delivered' });
            const claimed = await notificationService._claimCredentialSmsBatch({
                userId, eventKey, reference: 'DELIVERED', batchIndex: 1,
            });
            assert.strictEqual(claimed, null);
        });

        await test('concurrent retry claims cannot bypass the atomic maximum', async () => {
            store.clear();
            const eventKey = 'purchase_success:CONCURRENT:sms:1';
            store.put({ userId, eventKey, reference: 'CONCURRENT', batchIndex: 1, attempts: 2, status: 'failed' });
            const claims = await Promise.all(Array.from({ length: 8 }, () => (
                notificationService._claimCredentialSmsBatch({
                    userId, eventKey, reference: 'CONCURRENT', batchIndex: 1,
                })
            )));
            assert.strictEqual(claims.filter(Boolean).length, 1);
            assert.strictEqual(store.get(userId, eventKey).attempts, 3);
        });

        await test('repeated notification execution cannot cause attempt 4', async () => {
            store.clear();
            const eventKey = 'purchase_success:REPEAT';
            const batchKey = `${eventKey}:sms:1`;
            store.put({ userId, eventKey: batchKey, reference: 'REPEAT', batchIndex: 1, attempts: 2, status: 'failed' });
            let sends = 0;
            notificationService.sendSMS = async () => { sends++; return { success: false }; };
            await notificationService._dispatchCredentialSmsBatches(
                { _id: userId, phone: '08012345678' }, ['batch one'], 'purchase_success', eventKey, 'REPEAT'
            );
            await notificationService._dispatchCredentialSmsBatches(
                { _id: userId, phone: '08012345678' }, ['batch one'], 'purchase_success', eventKey, 'REPEAT'
            );
            assert.strictEqual(sends, 1);
            assert.strictEqual(store.get(userId, batchKey).attempts, 3);
        });

        await test('a skipped gateway response is not recorded as delivered', async () => {
            store.clear();
            global.setTimeout = () => ({ unref() {} });
            notificationService.sendSMS = async () => ({ success: true, delivered: false });
            const delivered = await notificationService._dispatchCredentialSmsBatches(
                { _id: userId, phone: '08012345678' },
                ['batch one'],
                'purchase_success',
                'purchase_success:SKIPPED',
                'SKIPPED',
                'OriginalBrand'
            );
            assert.strictEqual(delivered, false);
            const record = store.get(userId, 'purchase_success:SKIPPED:sms:1');
            assert.strictEqual(record.status, 'failed');
            assert.strictEqual(record.brandName, 'OriginalBrand');
            global.setTimeout = originalSetTimeout;
        });

        await test('credential batches remain sequential while batch 1 is delayed', async () => {
            store.clear();
            const observed = [];
            let releaseFirst;
            const firstGate = new Promise(resolve => { releaseFirst = resolve; });
            notificationService.sendSMS = async (_phone, message) => {
                observed.push(message);
                if (message === 'batch 1') await firstGate;
                return { success: true };
            };
            const dispatch = notificationService._dispatchCredentialSmsBatches(
                { _id: userId, phone: '08012345678' },
                ['batch 1', 'batch 2', 'batch 3'],
                'purchase_success',
                'purchase_success:ORDER',
                'ORDER'
            );
            await new Promise(resolve => setImmediate(resolve));
            assert.deepStrictEqual(observed, ['batch 1']);
            releaseFirst();
            assert.strictEqual(await dispatch, true);
            assert.deepStrictEqual(observed, ['batch 1', 'batch 2', 'batch 3']);
        });

        await test('an earlier failure stops later batches and retry resumes in order', async () => {
            store.clear();
            const observed = [];
            global.setTimeout = () => ({ unref() {} });
            notificationService.sendSMS = async (_phone, message) => {
                observed.push(message);
                return { success: message !== 'batch 1' };
            };
            const first = await notificationService._dispatchCredentialSmsBatches(
                { _id: userId, phone: '08012345678' },
                ['batch 1', 'batch 2', 'batch 3'],
                'purchase_success',
                'purchase_success:FAIL-ORDER',
                'FAIL-ORDER'
            );
            assert.strictEqual(first, false);
            assert.deepStrictEqual(observed, ['batch 1']);

            notificationService.sendSMS = async (_phone, message) => {
                observed.push(message);
                return { success: true };
            };
            const retry = await notificationService._dispatchCredentialSmsBatches(
                { _id: userId, phone: '08012345678' },
                ['batch 1', 'batch 2', 'batch 3'],
                'purchase_success',
                'purchase_success:FAIL-ORDER',
                'FAIL-ORDER'
            );
            assert.strictEqual(retry, true);
            assert.deepStrictEqual(observed, ['batch 1', 'batch 1', 'batch 2', 'batch 3']);
            global.setTimeout = originalSetTimeout;
        });

        await test('autonomous sweep selects only stale eligible dispatching rows', async () => {
            store.clear();
            const old = new Date(Date.now() - 10 * 60 * 1000);
            const fresh = new Date();
            store.put({ _id: 'stale', userId, eventKey: 'purchase_success:STALE:sms:1', reference: 'STALE', batchIndex: 1, attempts: 1, status: 'dispatching', updatedAt: old });
            store.put({ _id: 'fresh', userId, eventKey: 'purchase_success:FRESH:sms:1', reference: 'FRESH', batchIndex: 1, attempts: 1, status: 'dispatching', updatedAt: fresh });
            store.put({ _id: 'delivered', userId, eventKey: 'purchase_success:DONE:sms:1', reference: 'DONE', batchIndex: 1, attempts: 1, status: 'delivered', updatedAt: old });
            store.put({ _id: 'exhausted', userId, eventKey: 'purchase_success:EXHAUSTED:sms:1', reference: 'EXHAUSTED', batchIndex: 1, attempts: 3, status: 'dispatching', updatedAt: old });
            const originalRecoverOne = notificationService._recoverStaleCredentialSmsDelivery;
            const selected = [];
            notificationService._recoverStaleCredentialSmsDelivery = async candidate => {
                selected.push(candidate._id);
                return true;
            };
            try {
                const result = await notificationService.recoverStaleCredentialSmsDeliveries();
                assert.deepStrictEqual(selected, ['stale']);
                assert.deepStrictEqual(result, { skipped: false, recovered: 1 });
            } finally {
                notificationService._recoverStaleCredentialSmsDelivery = originalRecoverOne;
            }
        });

        await test('autonomous recovery is scheduled conservatively and does not overlap in-process', async () => {
            const cronSource = fs.readFileSync(
                path.join(__dirname, '..', 'cron', 'transactionRetryCron.js'),
                'utf8'
            );
            assert.match(cronSource, /cron\.schedule\('\*\/5 \* \* \* \*'/);
            assert.match(cronSource, /recoverStaleCredentialSmsDeliveries\(\)/);

            store.clear();
            store.put({
                _id: 'overlap',
                userId,
                eventKey: 'purchase_success:OVERLAP:sms:1',
                reference: 'OVERLAP',
                batchIndex: 1,
                attempts: 1,
                status: 'dispatching',
                updatedAt: new Date(Date.now() - 10 * 60 * 1000),
            });
            const originalRecoverOne = notificationService._recoverStaleCredentialSmsDelivery;
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            notificationService._recoverStaleCredentialSmsDelivery = async () => {
                await gate;
                return true;
            };
            try {
                const first = notificationService.recoverStaleCredentialSmsDeliveries();
                await new Promise(resolve => setImmediate(resolve));
                assert.deepStrictEqual(
                    await notificationService.recoverStaleCredentialSmsDeliveries(),
                    { skipped: true, recovered: 0 }
                );
                release();
                assert.deepStrictEqual(await first, { skipped: false, recovered: 1 });
            } finally {
                release();
                await gate;
                notificationService._recoverStaleCredentialSmsDelivery = originalRecoverOne;
                notificationService._credentialSmsRecoveryRunning = false;
            }
        });

        await test('stale recovery reconstructs encrypted fulfillment without financial/provider effects', async () => {
            store.clear();
            const reference = 'REF-RECOVERY';
            const eventKey = `purchase_success:${reference}`;
            const codes = [
                `PIN-1-${'A'.repeat(80)}`,
                `PIN-2-${'B'.repeat(80)}`,
                `PIN-3-${'C'.repeat(80)}`,
            ];
            const transaction = {
                _id: new mongoose.Types.ObjectId(),
                userId,
                transactionId: 'TX-RECOVERY',
                refId: reference,
                type: 'pin',
                service: 'waec',
                status: 'success',
                isLoss: false,
                amount: 3000,
                costPrice: 2700,
                profit: 300,
                details: { quantity: 3, productName: 'WAEC Result Checker' },
                fulfillment: encryptFulfillment({ items: codes.map(code => ({ code, serial: null })) }, {
                    expectedQuantity: 3,
                    complete: true,
                }),
            };
            const financialSnapshot = JSON.stringify({
                status: transaction.status,
                isLoss: transaction.isLoss,
                amount: transaction.amount,
                costPrice: transaction.costPrice,
                profit: transaction.profit,
            });
            const stale = store.put({
                userId,
                eventKey: `${eventKey}:sms:1`,
                reference,
                batchIndex: 1,
                brandName: 'OriginalBrand',
                attempts: 1,
                status: 'dispatching',
                updatedAt: new Date(Date.now() - 10 * 60 * 1000),
            });
            let transactionFilter;
            let providerPurchases = 0;
            const sent = [];
            Transaction.findOne = async filter => { transactionFilter = filter; return transaction; };
            User.findById = async lookupUserId => sameId(lookupUserId, userId)
                ? { _id: userId, phone: '08012345678', name: 'Recovery User' }
                : null;
            settingsService.getSetting = async (name, fallback) => name === 'SITE_NAME' ? 'ChangedBrand' : fallback;
            purchaseService.processPurchase = async () => { providerPurchases++; };
            notificationService.sendSMS = async (_phone, message) => { sent.push(message); return { success: true }; };

            const recovered = await notificationService._recoverStaleCredentialSmsDelivery(
                { ...stale },
                new Date(Date.now() - 5 * 60 * 1000)
            );
            assert.strictEqual(recovered, true);
            assert.strictEqual(providerPurchases, 0);
            assert.strictEqual(transactionFilter.status, 'success');
            assert.strictEqual(String(transactionFilter.userId), String(userId));
            assert.strictEqual(sent.length, 3);
            assert.ok(sent.every(message => message.startsWith('OriginalBrand:')));
            assert.ok(sent[0].includes(codes[0]));
            assert.ok(sent[1].includes(codes[1]));
            assert.ok(sent[2].includes(codes[2]));
            assert.strictEqual(JSON.stringify({
                status: transaction.status,
                isLoss: transaction.isLoss,
                amount: transaction.amount,
                costPrice: transaction.costPrice,
                profit: transaction.profit,
            }), financialSnapshot);
            for (const record of store.records.values()) {
                const persisted = JSON.stringify(record);
                assert.ok(!persisted.includes('PIN-1-'));
                assert.ok(!persisted.includes('PIN-2-'));
                assert.ok(!persisted.includes('PIN-3-'));
                assert.strictEqual(record.message, undefined);
            }
        });

        await test('production startup validation rejects missing and malformed keys without disclosure', async () => {
            await withEnvironment({ NODE_ENV: 'production', PROVIDER_CREDENTIAL_ENCRYPTION_KEY: undefined }, async () => {
                assert.throws(() => validateEncryptionConfiguration(), /PROVIDER_CREDENTIAL_ENCRYPTION_KEY/);
            });
            const secretMaterial = 'malformed-secret-material';
            await withEnvironment({ NODE_ENV: 'production', PROVIDER_CREDENTIAL_ENCRYPTION_KEY: secretMaterial }, async () => {
                let error;
                try { validateEncryptionConfiguration(); } catch (caught) { error = caught; }
                assert.ok(error);
                assert.match(error.message, /PROVIDER_CREDENTIAL_ENCRYPTION_KEY/);
                assert.ok(!error.message.includes(secretMaterial));
            });
        });

        await test('production valid key passes and non-production fallback remains compatible', async () => {
            const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
            await withEnvironment({ NODE_ENV: 'production', PROVIDER_CREDENTIAL_ENCRYPTION_KEY: key }, async () => {
                assert.strictEqual(validateEncryptionConfiguration(), true);
            });
            await withEnvironment({ NODE_ENV: 'test', PROVIDER_CREDENTIAL_ENCRYPTION_KEY: undefined }, async () => {
                assert.strictEqual(validateEncryptionConfiguration(), true);
                assert.strictEqual(isEncrypted(encryptSecret('test-credential')), true);
            });
            const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
            assert.ok(source.indexOf('validateEncryptionConfiguration();') < source.indexOf('app.listen('));
        });
    } finally {
        store.restore();
        notificationService.sendSMS = originalSendSMS;
        Transaction.findOne = originalTransactionFindOne;
        User.findById = originalUserFindById;
        settingsService.getSetting = originalGetSetting;
        purchaseService.processPurchase = originalProcessPurchase;
        global.setTimeout = originalSetTimeout;
        notificationService._credentialSmsRecoveryRunning = false;
    }

    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
}

function sameId(left, right) {
    return String(left) === String(right);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
