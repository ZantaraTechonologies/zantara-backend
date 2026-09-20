'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { isDeepStrictEqual } = require('util');

const COLLECTION_NAME = 'kycs';
const APPLY_CONFIRMATION = 'kyc-pending-index';
const TARGET_INDEX = {
    name: 'uniq_pending_kyc_per_user',
    key: { userId: 1, status: 1 },
    options: {
        unique: true,
        partialFilterExpression: { status: 'pending' }
    }
};

function hasExplicitDatabaseName(uri) {
    if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//i.test(uri)) return false;
    const withoutQuery = uri.split('?')[0];
    const authorityStart = withoutQuery.indexOf('://') + 3;
    const pathStart = withoutQuery.indexOf('/', authorityStart);
    if (pathStart < 0) return false;
    return withoutQuery.slice(pathStart + 1).split('/')[0].trim().length > 0;
}

function databaseNameFromArgs(args = process.argv) {
    const argument = args.find(value => value.startsWith('--database='));
    if (!argument) return null;
    const databaseName = argument.slice('--database='.length).trim();
    if (!/^[A-Za-z0-9._-]+$/.test(databaseName)) {
        throw new Error('Invalid explicit database name');
    }
    return databaseName;
}

function exactKey(actual = {}, expected = {}) {
    return isDeepStrictEqual(Object.entries(actual), Object.entries(expected));
}

function indexMatches(actual, expected = TARGET_INDEX) {
    return !!actual
        && actual.name === expected.name
        && exactKey(actual.key, expected.key)
        && actual.unique === true
        && isDeepStrictEqual(
            actual.partialFilterExpression || null,
            expected.options.partialFilterExpression
        );
}

async function readIndexes(collection) {
    try {
        return await collection.indexes();
    } catch (error) {
        if (error?.code === 26 || error?.codeName === 'NamespaceNotFound') return [];
        throw error;
    }
}

function assertNoIndexConflict(indexes) {
    const sameName = indexes.find(index => index.name === TARGET_INDEX.name);
    if (sameName && !indexMatches(sameName)) {
        throw new Error(`Index conflict: ${TARGET_INDEX.name} does not match the required definition`);
    }

    const sameKeyConflict = indexes.find(index =>
        exactKey(index.key, TARGET_INDEX.key) && index.name !== TARGET_INDEX.name
    );
    if (sameKeyConflict) {
        throw new Error(`Index conflict: required key already exists as ${sameKeyConflict.name}`);
    }
}

async function inspectData(collection) {
    const [missingUserId, nullUserId, malformedUserId, duplicateRows, statusRows] = await Promise.all([
        collection.countDocuments({ status: 'pending', userId: { $exists: false } }),
        collection.countDocuments({ status: 'pending', userId: { $type: 'null' } }),
        collection.countDocuments({
            status: 'pending',
            userId: { $exists: true, $ne: null },
            $expr: { $ne: [{ $type: '$userId' }, 'objectId'] }
        }),
        collection.aggregate([
            { $match: { status: 'pending', $expr: { $eq: [{ $type: '$userId' }, 'objectId'] } } },
            { $group: { _id: '$userId', count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
            {
                $group: {
                    _id: null,
                    groups: { $sum: 1 },
                    records: { $sum: '$count' },
                    maxPerUser: { $max: '$count' }
                }
            }
        ]).toArray(),
        collection.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]).toArray()
    ]);

    const duplicates = duplicateRows[0] || { groups: 0, records: 0, maxPerUser: 0 };
    return {
        pendingOwnerFindings: { missingUserId, nullUserId, malformedUserId },
        duplicatePending: {
            groups: duplicates.groups,
            records: duplicates.records,
            maxPerUser: duplicates.maxPerUser
        },
        statusCounts: statusRows.map(row => ({ status: row._id === undefined ? '<missing>' : row._id, count: row.count }))
    };
}

function assertCompatible(report) {
    const invalidOwners = Object.values(report.pendingOwnerFindings).reduce((sum, count) => sum + count, 0);
    if (invalidOwners > 0) {
        throw new Error(`Validation failed: ${invalidOwners} pending KYC record(s) have malformed or missing userId`);
    }
    if (report.duplicatePending.groups > 0) {
        throw new Error(`Validation failed: ${report.duplicatePending.groups} duplicate pending KYC user group(s) found`);
    }
}

async function ensureTargetIndex(collection) {
    const before = await readIndexes(collection);
    assertNoIndexConflict(before);

    if (!before.some(index => index.name === TARGET_INDEX.name)) {
        await collection.createIndex(TARGET_INDEX.key, {
            ...TARGET_INDEX.options,
            name: TARGET_INDEX.name
        });
    }

    const after = await readIndexes(collection);
    const installed = after.find(index => index.name === TARGET_INDEX.name);
    if (!indexMatches(installed)) throw new Error('Post-migration index verification failed');
    return installed;
}

function publicIndexDefinition(index) {
    if (!index) return null;
    return {
        name: index.name,
        key: index.key,
        unique: index.unique === true,
        partialFilterExpression: index.partialFilterExpression || null
    };
}

async function run() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) throw new Error('MONGO_URI is required');
    const databaseName = databaseNameFromArgs();
    if (!hasExplicitDatabaseName(mongoUri) && !databaseName) {
        throw new Error('MONGO_URI or --database must include an explicit database name');
    }

    const apply = process.argv.includes('--apply');
    const confirmed = process.env.KYC_PENDING_INDEX_MIGRATION_CONFIRM === APPLY_CONFIRMATION
        || process.argv.includes(`--confirm=${APPLY_CONFIRMATION}`);
    if (apply && !confirmed) {
        throw new Error(`Refusing --apply without KYC_PENDING_INDEX_MIGRATION_CONFIRM=${APPLY_CONFIRMATION}`);
    }

    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
    await mongoose.connect(mongoUri, {
        autoIndex: false,
        autoCreate: false,
        ...(databaseName ? { dbName: databaseName } : {})
    });
    try {
        const collection = mongoose.connection.collection(COLLECTION_NAME);
        const currentIndexes = await readIndexes(collection);
        assertNoIndexConflict(currentIndexes);
        const report = await inspectData(collection);

        console.log(JSON.stringify({
            mode: apply ? 'apply' : 'validation-only',
            collection: COLLECTION_NAME,
            targetIndex: TARGET_INDEX,
            installedTargetIndex: publicIndexDefinition(
                currentIndexes.find(index => index.name === TARGET_INDEX.name)
            ),
            ...report
        }, null, 2));

        assertCompatible(report);
        if (!apply) {
            console.log('Validation passed. No index changes were made.');
            return;
        }

        const installed = await ensureTargetIndex(collection);
        console.log(JSON.stringify({ installedIndex: publicIndexDefinition(installed) }, null, 2));
        console.log('KYC pending unique index migration completed and verified.');
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    run().catch(error => {
        console.error(`[KYC Pending Index Migration] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    TARGET_INDEX,
    hasExplicitDatabaseName,
    databaseNameFromArgs,
    indexMatches,
    assertNoIndexConflict,
    inspectData,
    assertCompatible,
    ensureTargetIndex
};
