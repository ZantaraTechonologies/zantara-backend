'use strict';

const assert = require('node:assert');
const mongoose = require('mongoose');

const Provider = require('../models/Provider');
const Transaction = require('../models/Transaction');
const TransactionStatus = require('../models/TransactionStatus');
const paymentGatewayService = require('../services/paymentGateway.service');
const providerService = require('../services/provider.service');
const { logTransaction } = require('../utils/transaction');

const duplicateError = field => {
    const error = new Error(`E11000 duplicate key index: ${field}_1`);
    error.code = 11000;
    error.keyPattern = { [field]: 1 };
    return error;
};

async function main() {
    let passed = 0;
    let failed = 0;
    const test = async (name, fn) => {
        try {
            await fn();
            console.log(`[PASS] ${name}`);
            passed++;
        } catch (error) {
            console.error(`[FAIL] ${name}: ${error.message}`);
            failed++;
        }
    };

    await test('ambiguous payment initialization remains pending under its reserved reference', async () => {
        const originals = {
            getGateway: paymentGatewayService.getGateway,
            getAdapterInstance: paymentGatewayService.getAdapterInstance,
            create: TransactionStatus.create,
            updateOne: TransactionStatus.updateOne,
        };
        const records = [];
        let initializeCalls = 0;
        try {
            paymentGatewayService.getGateway = async () => ({
                code: 'paystack', name: 'Paystack', adapterType: 'paystack', status: 'active',
                supportedChannels: ['card'],
            });
            paymentGatewayService.getAdapterInstance = () => ({
                initializePayment: async () => {
                    initializeCalls++;
                    const error = new Error('timeout of 20000ms exceeded');
                    error.code = 'ECONNABORTED';
                    throw error;
                },
            });
            TransactionStatus.create = async document => {
                records.push({ ...document });
                return records[records.length - 1];
            };
            TransactionStatus.updateOne = async (filter, update) => {
                const record = records.find(item => item.refId === filter.refId && item.status === filter.status);
                if (!record) return { matchedCount: 0, modifiedCount: 0 };
                Object.assign(record, update.$set || {});
                return { matchedCount: 1, modifiedCount: 1 };
            };

            let caught;
            try {
                await paymentGatewayService.initializeFunding({
                    gatewayCode: 'paystack',
                    user: { _id: new mongoose.Types.ObjectId(), email: 'user@example.com' },
                    amount: 1000,
                });
            } catch (error) {
                caught = error;
            }

            assert.strictEqual(caught.code, 'PAYMENT_INITIALIZATION_AMBIGUOUS');
            assert.strictEqual(caught.reference, records[0].refId);
            assert.strictEqual(initializeCalls, 1, 'the gateway must not be initialized twice');
            assert.strictEqual(records[0].status, 'pending');
            assert.strictEqual(records[0].initializationOutcome, 'ambiguous');
        } finally {
            paymentGatewayService.getGateway = originals.getGateway;
            paymentGatewayService.getAdapterInstance = originals.getAdapterInstance;
            TransactionStatus.create = originals.create;
            TransactionStatus.updateOne = originals.updateOne;
        }
    });

    await test('definitive payment initialization rejection becomes failed', async () => {
        const originals = {
            getGateway: paymentGatewayService.getGateway,
            getAdapterInstance: paymentGatewayService.getAdapterInstance,
            create: TransactionStatus.create,
            updateOne: TransactionStatus.updateOne,
        };
        let record;
        try {
            paymentGatewayService.getGateway = async () => ({
                code: 'paystack', name: 'Paystack', adapterType: 'paystack', status: 'active',
                supportedChannels: ['card'],
            });
            paymentGatewayService.getAdapterInstance = () => ({
                initializePayment: async () => {
                    const error = new Error('Gateway rejected the request');
                    error.gatewayInitializationOutcome = 'definitive_failure';
                    throw error;
                },
            });
            TransactionStatus.create = async document => {
                record = { ...document };
                return record;
            };
            TransactionStatus.updateOne = async (_filter, update) => {
                Object.assign(record, update.$set || {});
                return { matchedCount: 1, modifiedCount: 1 };
            };

            await assert.rejects(paymentGatewayService.initializeFunding({
                gatewayCode: 'paystack',
                user: { _id: new mongoose.Types.ObjectId(), email: 'user@example.com' },
                amount: 1000,
            }), /Gateway rejected/);
            assert.strictEqual(record.status, 'failed');
            assert.strictEqual(record.initializationOutcome, 'definitive_failure');
        } finally {
            paymentGatewayService.getGateway = originals.getGateway;
            paymentGatewayService.getAdapterInstance = originals.getAdapterInstance;
            TransactionStatus.create = originals.create;
            TransactionStatus.updateOne = originals.updateOne;
        }
    });

    await test('complete provider snapshot works when the live Provider is missing', async () => {
        const originalFindById = Provider.findById;
        const originalFindOne = Provider.findOne;
        const originalAdapter = providerService.adapterClasses.universal;
        let queriedReference;
        let receivedConfig;
        class SnapshotAdapter {
            constructor(config) { receivedConfig = config; }
            async queryTransaction(reference) {
                queriedReference = reference;
                return { status: 'pending' };
            }
        }
        try {
            Provider.findById = async () => { throw new Error('live Provider must not be queried'); };
            Provider.findOne = async () => { throw new Error('provider name fallback must not be queried'); };
            providerService.adapterClasses.universal = SnapshotAdapter;
            const providerRequestId = 'ZNT-P-23456789ABCDEFGH';
            await providerService.queryTransaction(providerRequestId, 'Deleted Provider', {
                providerId: new mongoose.Types.ObjectId(),
                adapterType: 'universal',
                configSnapshot: {
                    baseUrl: 'https://historical-provider.example',
                    publicKey: 'historical-public',
                    metadata: { queryUrl: '/historical-query' },
                },
                credentialSnapshot: {
                    apiKey: 'historical-api-key',
                    secretKey: 'historical-secret-key',
                },
            });
            assert.strictEqual(queriedReference, providerRequestId);
            assert.strictEqual(receivedConfig.baseUrl, 'https://historical-provider.example');
            assert.strictEqual(receivedConfig.apiKey, 'historical-api-key');
            assert.deepStrictEqual(receivedConfig.metadata, { queryUrl: '/historical-query' });
        } finally {
            Provider.findById = originalFindById;
            Provider.findOne = originalFindOne;
            providerService.adapterClasses.universal = originalAdapter;
        }
    });

    await test('incomplete snapshot with a deleted provider fails closed without name substitution', async () => {
        const originalFindById = Provider.findById;
        const originalFindOne = Provider.findOne;
        let nameLookupCalled = false;
        try {
            Provider.findById = async () => null;
            Provider.findOne = async () => { nameLookupCalled = true; return null; };
            await assert.rejects(providerService.queryTransaction('ZNT-P-23456789ABCDEFGH', 'Reused Name', {
                providerId: new mongoose.Types.ObjectId(),
                adapterType: 'universal',
                configSnapshot: { baseUrl: 'https://historical-provider.example' },
                credentialSnapshot: {},
            }), /snapshot is incomplete/);
            assert.strictEqual(nameLookupCalled, false);
        } finally {
            Provider.findById = originalFindById;
            Provider.findOne = originalFindOne;
        }
    });

    await test('new Transaction validation requires immutable identity and validates only new namespaces', async () => {
        await assert.rejects(new Transaction({ type: 'airtime', status: 'pending' }).validate(), /transactionId/);
        await assert.rejects(new Transaction({ transactionId: 'ZNT-BAD', type: 'airtime', status: 'pending' }).validate(), /Invalid Zantara/);
        await new Transaction({ transactionId: 'FT123456789', refId: 'ZNT-123-ABC', type: 'airtime', status: 'pending' }).validate();
        await new Transaction({
            transactionId: 'ZNT-23456789ABCD',
            refId: 'ZNT-R-23456789ABCDEFGH',
            providerRequestId: '20260926120023456789',
            providerAdapterType: 'vtpass',
            type: 'airtime',
            status: 'pending',
        }).validate();
        await Transaction.hydrate({ type: 'airtime', status: 'success' }).validate();
        assert.strictEqual(Transaction.schema.path('transactionId').options.immutable, true);
        assert.strictEqual(Transaction.schema.path('refId').options.immutable, true);
        assert.strictEqual(Transaction.schema.path('providerRequestId').options.immutable, true);
    });

    await test('generic transaction logging retries generated transactionId before succeeding', async () => {
        const originalCreate = Transaction.create;
        const attempts = [];
        try {
            Transaction.create = async document => {
                attempts.push(document);
                if (attempts.length === 1) throw duplicateError('transactionId');
                return document;
            };
            await logTransaction({
                userId: new mongoose.Types.ObjectId(),
                refId: 'EXTERNAL-REFERENCE',
                type: 'funding',
                service: 'Audit',
                amount: 100,
            });
            assert.strictEqual(attempts.length, 2);
            assert.match(attempts[0].transactionId, /^ZNT-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);
            assert.match(attempts[1].transactionId, /^ZNT-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);
            assert.notStrictEqual(attempts[0].transactionId, attempts[1].transactionId);
            assert.strictEqual(attempts[1].refId, 'EXTERNAL-REFERENCE');
        } finally {
            Transaction.create = originalCreate;
        }
    });

    console.log(`\nProduction-readiness remediation tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
