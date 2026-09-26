'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { isDeepStrictEqual } = require('node:util');

const COLLECTION_NAME = 'transactions';
const APPLY_CONFIRMATION = 'transaction-reference-identity';
const SAMPLE_LIMIT = 50;

const REQUIRED_INDEXES = [
    {
        name: 'transactionId_1',
        key: { transactionId: 1 },
        options: { unique: true }
    },
    {
        name: 'refId_1_unique_partial',
        key: { refId: 1 },
        options: {
            unique: true,
            partialFilterExpression: { refId: { $gte: 'ZNT-R-', $lt: 'ZNT-R.' } }
        }
    },
    {
        name: 'providerRequestId_1_unique_partial',
        key: { providerRequestId: 1 },
        options: {
            unique: true,
            partialFilterExpression: { providerRequestId: { $type: 'string' } }
        }
    }
];

function hasExplicitDatabaseName(uri) {
    if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//i.test(uri)) return false;
    const withoutQuery = uri.split('?')[0];
    const authorityStart = withoutQuery.indexOf('://') + 3;
    const pathStart = withoutQuery.indexOf('/', authorityStart);
    return pathStart >= 0 && withoutQuery.slice(pathStart + 1).trim().length > 0;
}

function isExactKey(index, expected) {
    return isDeepStrictEqual(index.key || {}, expected);
}

async function findDuplicates(collection, field, match = { [field]: { $type: 'string' } }) {
    return collection.aggregate([
        { $match: match },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: SAMPLE_LIMIT }
    ]).toArray();
}

async function inspectField(collection, field, { required, enforcedMatch }) {
    const [missing, nullValues, nonString, blank, untrimmed, duplicates, enforcedDuplicates] = await Promise.all([
        collection.countDocuments({ [field]: { $exists: false } }),
        collection.countDocuments({ [field]: { $exists: true, $eq: null } }),
        collection.countDocuments({
            [field]: { $exists: true, $ne: null, $not: { $type: 'string' } }
        }),
        collection.countDocuments({ [field]: { $type: 'string', $regex: /^\s*$/ } }),
        collection.countDocuments({
            [field]: { $type: 'string' },
            $expr: { $ne: [`$${field}`, { $trim: { input: `$${field}` } }] }
        }),
        findDuplicates(collection, field),
        enforcedMatch ? findDuplicates(collection, field, enforcedMatch) : Promise.resolve(null)
    ]);

    return { field, required, missing, nullValues, nonString, blank, untrimmed, duplicates, enforcedDuplicates };
}

async function inspectData(collection) {
    const fields = await Promise.all([
        inspectField(collection, 'transactionId', { required: true }),
        inspectField(collection, 'refId', {
            required: false,
            enforcedMatch: { refId: { $gte: 'ZNT-R-', $lt: 'ZNT-R.' } }
        }),
        inspectField(collection, 'providerRequestId', { required: false })
    ]);
    return Object.fromEntries(fields.map(report => [report.field, report]));
}

async function readIndexes(collection) {
    try {
        return await collection.indexes();
    } catch (error) {
        if (error && (error.code === 26 || error.codeName === 'NamespaceNotFound')) return [];
        throw error;
    }
}

function assertDataSafe(report) {
    for (const fieldReport of Object.values(report)) {
        const invalidRequired = fieldReport.required
            ? fieldReport.missing + fieldReport.nullValues
            : 0;
        if (invalidRequired > 0) {
            throw new Error(`${fieldReport.field} has ${invalidRequired} missing/null required value(s)`);
        }
        if (fieldReport.nonString > 0 || fieldReport.blank > 0 || fieldReport.untrimmed > 0) {
            throw new Error(`${fieldReport.field} contains malformed historical value(s)`);
        }
        const blockingDuplicates = fieldReport.enforcedDuplicates === null
            || fieldReport.enforcedDuplicates === undefined
            ? fieldReport.duplicates
            : fieldReport.enforcedDuplicates;
        if (blockingDuplicates.length > 0) {
            throw new Error(`${fieldReport.field} contains duplicate historical value(s)`);
        }
    }
}

function assertNoIndexConflicts(indexes) {
    for (const expected of REQUIRED_INDEXES) {
        const sameName = indexes.find(index => index.name === expected.name);
        const sameKey = indexes.find(index => isExactKey(index, expected.key));
        const candidate = sameName || sameKey;
        if (!candidate) continue;
        if (candidate.name !== expected.name) {
            throw new Error(`Conflicting index '${candidate.name}' exists for ${expected.name}`);
        }
        const actualOptions = {
            unique: Boolean(candidate.unique),
            ...(candidate.partialFilterExpression
                ? { partialFilterExpression: candidate.partialFilterExpression }
                : {})
        };
        if (!isExactKey(candidate, expected.key) || !isDeepStrictEqual(actualOptions, expected.options)) {
            throw new Error(`Conflicting index '${candidate.name}' exists for ${expected.name}`);
        }
    }
}

function verifyIndexes(indexes) {
    assertNoIndexConflicts(indexes);
    for (const expected of REQUIRED_INDEXES) {
        const installed = indexes.find(index => index.name === expected.name);
        if (!installed) throw new Error(`Required index '${expected.name}' is missing`);
    }
}

async function run() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) throw new Error('MONGO_URI is required');
    if (!hasExplicitDatabaseName(mongoUri)) {
        throw new Error('MONGO_URI must explicitly include the approved target database name');
    }

    const apply = process.argv.includes('--apply');
    if (apply && process.env.TRANSACTION_IDENTIFIER_MIGRATION_CONFIRM !== APPLY_CONFIRMATION) {
        throw new Error(`Refusing --apply without TRANSACTION_IDENTIFIER_MIGRATION_CONFIRM=${APPLY_CONFIRMATION}`);
    }

    await mongoose.connect(mongoUri, { autoIndex: false });
    try {
        const collection = mongoose.connection.collection(COLLECTION_NAME);
        const [report, indexes] = await Promise.all([
            inspectData(collection),
            readIndexes(collection)
        ]);
        assertNoIndexConflicts(indexes);

        console.log(JSON.stringify({
            mode: apply ? 'apply' : 'validation-only',
            targetDatabase: mongoose.connection.name,
            collection: COLLECTION_NAME,
            currentIndexes: indexes.map(index => ({
                name: index.name,
                key: index.key,
                unique: Boolean(index.unique),
                partialFilterExpression: index.partialFilterExpression
            })),
            data: report
        }, null, 2));

        assertDataSafe(report);
        if (!apply) {
            console.log('Validation passed. No data or indexes were changed.');
            return;
        }

        for (const expected of REQUIRED_INDEXES) {
            if (indexes.some(index => index.name === expected.name)) continue;
            await collection.createIndex(expected.key, {
                ...expected.options,
                name: expected.name
            });
        }

        const finalIndexes = await readIndexes(collection);
        verifyIndexes(finalIndexes);
        console.log('Transaction identifier indexes created and verified. No transaction data was modified.');
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    run().catch(error => {
        console.error(`[Transaction Identifier Migration] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    REQUIRED_INDEXES,
    hasExplicitDatabaseName,
    isExactKey,
    findDuplicates,
    inspectField,
    inspectData,
    assertDataSafe,
    assertNoIndexConflicts,
    verifyIndexes
};
