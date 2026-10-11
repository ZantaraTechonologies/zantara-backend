'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { isDeepStrictEqual } = require('node:util');

const COLLECTION_NAME = 'wallets';
const INDEX = Object.freeze({ name: 'userId_1_unique', key: { userId: 1 }, unique: true });
const APPLY_CONFIRMATION = 'phase5a-wallet-identity';

function hasExplicitDatabaseName(uri) {
    if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//i.test(uri)) return false;
    const withoutQuery = uri.split('?')[0];
    const authorityStart = withoutQuery.indexOf('://') + 3;
    const pathStart = withoutQuery.indexOf('/', authorityStart);
    return pathStart >= 0 && withoutQuery.slice(pathStart + 1).trim().length > 0;
}

function indexMatches(index) {
    return !!index
        && index.name === INDEX.name
        && index.unique === true
        && isDeepStrictEqual(index.key || {}, INDEX.key);
}

async function inspectWallets(collection) {
    const [missingUserId, nullUserId, duplicateUsers] = await Promise.all([
        collection.countDocuments({ userId: { $exists: false } }),
        collection.countDocuments({ userId: { $type: 'null' } }),
        collection.aggregate([
            { $match: { userId: { $exists: true, $ne: null } } },
            { $group: { _id: '$userId', count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
            { $project: { _id: 0, count: 1 } },
            { $sort: { count: -1 } },
            { $limit: 50 }
        ]).toArray()
    ]);
    return { missingUserId, nullUserId, duplicateUsers };
}

function assertWalletsSafe(report) {
    if (report.missingUserId > 0) throw new Error(`Found ${report.missingUserId} wallet(s) without userId`);
    if (report.nullUserId > 0) throw new Error(`Found ${report.nullUserId} wallet(s) with null userId`);
    if (report.duplicateUsers.length > 0) {
        throw new Error(`Found ${report.duplicateUsers.length} duplicate wallet ownership group(s)`);
    }
}

function assertNoIndexConflict(indexes) {
    const named = indexes.find(index => index.name === INDEX.name);
    if (named && !indexMatches(named)) throw new Error(`Index '${INDEX.name}' exists with an incompatible specification`);
    const sameKey = indexes.find(index => isDeepStrictEqual(index.key || {}, INDEX.key));
    if (sameKey && !indexMatches(sameKey)) throw new Error('A conflicting userId wallet index already exists');
}

async function run() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) throw new Error('MONGO_URI is required');
    if (!hasExplicitDatabaseName(mongoUri)) {
        throw new Error('MONGO_URI must explicitly include the approved target database name');
    }
    const apply = process.argv.includes('--apply');
    if (apply && process.env.PHASE5A_WALLET_INDEX_CONFIRM !== APPLY_CONFIRMATION) {
        throw new Error(`Refusing --apply without PHASE5A_WALLET_INDEX_CONFIRM=${APPLY_CONFIRMATION}`);
    }

    await mongoose.connect(mongoUri, { autoIndex: false, autoCreate: false });
    try {
        const collection = mongoose.connection.collection(COLLECTION_NAME);
        const [report, indexes] = await Promise.all([inspectWallets(collection), collection.indexes()]);
        assertWalletsSafe(report);
        assertNoIndexConflict(indexes);
        console.log(JSON.stringify({
            mode: apply ? 'apply' : 'validation-only',
            targetDatabase: mongoose.connection.name,
            report,
            indexPresent: indexes.some(indexMatches)
        }, null, 2));
        if (!apply) return;

        if (!indexes.some(indexMatches)) {
            await collection.createIndex(INDEX.key, { unique: true, name: INDEX.name });
        }
        const installed = (await collection.indexes()).find(index => index.name === INDEX.name);
        if (!indexMatches(installed)) throw new Error('Post-migration wallet identity index verification failed');
        console.log('Wallet identity index created and verified. No wallet data was modified.');
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    run().catch(error => {
        console.error(`[Phase 5A Wallet Migration] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    INDEX,
    APPLY_CONFIRMATION,
    hasExplicitDatabaseName,
    indexMatches,
    inspectWallets,
    assertWalletsSafe,
    assertNoIndexConflict
};
