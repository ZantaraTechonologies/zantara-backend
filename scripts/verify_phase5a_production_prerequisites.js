'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { isDeepStrictEqual } = require('node:util');
const {
    hasExplicitDatabaseName,
    validateDatabaseTargetConfiguration,
    databaseTargetConnectionOptions,
    assertConnectedDatabaseName,
    sanitizeDatabaseErrorMessage
} = require('../config/db');

const REQUIRED_INDEXES = Object.freeze({
    transactionstatuses: [
        { name: 'refId_1', key: { refId: 1 }, unique: true },
        {
            name: 'confirmedProvider_1_confirmedProviderRef_1_unique_partial',
            key: { confirmedProvider: 1, confirmedProviderRef: 1 },
            unique: true,
            partialFilterExpression: {
                confirmedProvider: { $type: 'string' },
                confirmedProviderRef: { $type: 'string' }
            }
        }
    ],
    walletledgers: [{
        name: 'settlementKey_1_unique_partial',
        key: { settlementKey: 1 },
        unique: true,
        partialFilterExpression: { settlementKey: { $type: 'string' } }
    }],
    webhookevents: [{ name: 'provider_1_eventId_1', key: { provider: 1, eventId: 1 }, unique: true }],
    transactions: [{ name: 'transactionId_1', key: { transactionId: 1 }, unique: true }],
    wallets: [{ name: 'userId_1_unique', key: { userId: 1 }, unique: true }]
});

function indexMatches(actual, expected) {
    return !!actual
        && actual.name === expected.name
        && isDeepStrictEqual(actual.key || {}, expected.key)
        && Boolean(actual.unique) === Boolean(expected.unique)
        && isDeepStrictEqual(actual.partialFilterExpression, expected.partialFilterExpression);
}

function inspectIndexCatalog(catalog) {
    const missing = [];
    const malformed = [];
    for (const [collection, expectedIndexes] of Object.entries(REQUIRED_INDEXES)) {
        const actualIndexes = catalog[collection] || [];
        for (const expected of expectedIndexes) {
            const actual = actualIndexes.find(index => index.name === expected.name);
            if (!actual) missing.push(`${collection}.${expected.name}`);
            else if (!indexMatches(actual, expected)) malformed.push(`${collection}.${expected.name}`);
        }
    }
    return { missing, malformed };
}

function assertIndexCatalogSafe(report) {
    if (report.missing.length || report.malformed.length) {
        throw new Error(`Exactly-once index prerequisites failed: ${report.missing.length} missing, ${report.malformed.length} malformed`);
    }
}

function isTransactionCapableTopology({ topologyType, hello } = {}) {
    const type = String(topologyType || '');
    const hasSessions = Number.isFinite(Number(hello?.logicalSessionTimeoutMinutes));
    const replicaSet = /ReplicaSet/i.test(type) && Boolean(hello?.setName);
    const sharded = /Sharded/i.test(type) || hello?.msg === 'isdbgrid';
    return hasSessions && (replicaSet || sharded);
}

function snapshotFor(record) {
    const snapshots = record.virtualAccountGatewaySnapshots;
    if (!snapshots || !record.accountReference) return null;
    if (snapshots instanceof Map) return snapshots.get(record.accountReference) || null;
    return snapshots[record.accountReference] || null;
}

function inspectPaystackDvaOwnership(records, gateways) {
    const gatewayById = new Map((gateways || []).map(gateway => [String(gateway._id), gateway]));
    const identityMaps = {
        providerAccountId: new Map(),
        accountReference: new Map(),
        accountNumber: new Map(),
        providerCustomerId: new Map(),
        providerCustomerCode: new Map()
    };
    const malformedActive = [];
    const missingGateway = [];
    const missingSnapshot = [];
    const duplicateProvisioningKeys = [];
    const provisioningKeys = new Set();

    const addIdentity = (field, record) => {
        const value = String(record[field] || '').trim();
        if (!value) return;
        const key = `${String(record.gatewayId || '')}:${value}`;
        const identity = identityMaps[field].get(key) || { users: new Set(), count: 0 };
        identity.users.add(String(record.userId || ''));
        identity.count++;
        identityMaps[field].set(key, identity);
    };

    for (const record of records || []) {
        const userId = String(record.userId || '');
        const gatewayId = String(record.gatewayId || '');
        const active = record.provisioningStatus === 'active';
        for (const field of Object.keys(identityMaps)) addIdentity(field, record);

        if (record.provisioningKey) {
            const key = `${userId}:${record.provisioningKey}`;
            if (provisioningKeys.has(key)) duplicateProvisioningKeys.push(userId);
            provisioningKeys.add(key);
        }

        const gateway = gatewayById.get(gatewayId);
        if (!gateway || String(gateway.adapterType || '').toLowerCase() !== 'paystack') missingGateway.push(userId);
        if (active) {
            const providerAccountId = String(record.providerAccountId || '');
            if (
                !gatewayId
                || !providerAccountId
                || record.accountReference !== `PAYSTACK_DVA_${providerAccountId}`
                || !/^\d{10}$/.test(String(record.accountNumber || ''))
                || !String(record.providerCustomerId || '')
                || !String(record.providerCustomerCode || '')
                || record.currency !== 'NGN'
                || record.active !== true
                || record.assigned !== true
            ) malformedActive.push(userId);
            if (!snapshotFor(record)) missingSnapshot.push(userId);
        }
    }

    const duplicates = {};
    for (const [field, values] of Object.entries(identityMaps)) {
        const accountIdentity = ['providerAccountId', 'accountReference', 'accountNumber'].includes(field);
        duplicates[field] = [...values.values()].filter(identity => (
            identity.users.size > 1 || (accountIdentity && identity.count > 1)
        )).length;
    }
    return {
        scanned: (records || []).length,
        duplicates,
        malformedActive: malformedActive.length,
        missingGateway: missingGateway.length,
        missingSnapshot: missingSnapshot.length,
        duplicateProvisioningKeys: duplicateProvisioningKeys.length
    };
}

function assertDvaOwnershipSafe(report) {
    const duplicateCount = Object.values(report.duplicates).reduce((sum, count) => sum + count, 0);
    const issueCount = duplicateCount
        + report.malformedActive
        + report.missingGateway
        + report.missingSnapshot
        + report.duplicateProvisioningKeys;
    if (issueCount > 0) throw new Error(`Paystack DVA ownership preflight found ${issueCount} blocking issue(s)`);
}

async function run() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) throw new Error('MONGO_URI is required');
    const expectedDatabaseName = validateDatabaseTargetConfiguration({
        mongoUri,
        databaseName: process.env.MONGO_DB_NAME,
        expectedDatabaseName: process.env.EXPECTED_DB_NAME,
        nodeEnv: process.env.NODE_ENV
    });

    await mongoose.connect(mongoUri, {
        autoIndex: false,
        autoCreate: false,
        ...databaseTargetConnectionOptions({ mongoUri, databaseName: process.env.MONGO_DB_NAME })
    });
    try {
        assertConnectedDatabaseName(mongoose.connection.name, expectedDatabaseName);
        const client = mongoose.connection.getClient();
        const hello = await mongoose.connection.db.admin().command({ hello: 1 });
        const topologyType = client.topology?.description?.type || '';
        if (!isTransactionCapableTopology({ topologyType, hello })) {
            throw new Error(`MongoDB topology '${topologyType || 'unknown'}' does not satisfy transaction prerequisites`);
        }

        const catalog = {};
        for (const collectionName of Object.keys(REQUIRED_INDEXES)) {
            catalog[collectionName] = await mongoose.connection.collection(collectionName).indexes();
        }
        const indexReport = inspectIndexCatalog(catalog);
        assertIndexCatalogSafe(indexReport);

        const [records, gateways] = await Promise.all([
            mongoose.connection.collection('users').aggregate([
                { $unwind: '$virtualAccounts' },
                { $match: { 'virtualAccounts.provider': 'paystack' } },
                {
                    $project: {
                        _id: 0,
                        userId: '$_id',
                        virtualAccountGatewaySnapshots: 1,
                        gatewayId: '$virtualAccounts.gatewayId',
                        accountNumber: '$virtualAccounts.accountNumber',
                        accountReference: '$virtualAccounts.accountReference',
                        providerAccountId: '$virtualAccounts.providerAccountId',
                        providerCustomerId: '$virtualAccounts.providerCustomerId',
                        providerCustomerCode: '$virtualAccounts.providerCustomerCode',
                        currency: '$virtualAccounts.currency',
                        active: '$virtualAccounts.active',
                        assigned: '$virtualAccounts.assigned',
                        provisioningKey: '$virtualAccounts.provisioningKey',
                        provisioningStatus: '$virtualAccounts.provisioningStatus'
                    }
                }
            ]).toArray(),
            mongoose.connection.collection('paymentgateways').find(
                { adapterType: 'paystack' },
                { projection: { _id: 1, code: 1, adapterType: 1 } }
            ).toArray()
        ]);
        const dvaReport = inspectPaystackDvaOwnership(records, gateways);
        assertDvaOwnershipSafe(dvaReport);

        console.log(JSON.stringify({
            verified: true,
            targetDatabase: mongoose.connection.name,
            topology: { type: topologyType, setName: hello.setName || null, transactionCapable: true },
            exactlyOnceIndexes: indexReport,
            paystackDvaOwnership: dvaReport,
            embeddedDvaUniquenessIndex: false
        }, null, 2));
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    run().catch(error => {
        console.error(`[Phase 5A Prerequisite Verification] ${sanitizeDatabaseErrorMessage(error, process.env.MONGO_URI)}`);
        process.exitCode = 1;
    });
}

module.exports = {
    REQUIRED_INDEXES,
    hasExplicitDatabaseName,
    indexMatches,
    inspectIndexCatalog,
    assertIndexCatalogSafe,
    isTransactionCapableTopology,
    inspectPaystackDvaOwnership,
    assertDvaOwnershipSafe
};
