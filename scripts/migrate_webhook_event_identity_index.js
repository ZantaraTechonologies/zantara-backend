'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const COLLECTION_NAME = 'webhookevents';
const COMPOUND_INDEX_NAME = 'provider_1_eventId_1';
const APPLY_CONFIRMATION = 'provider-event-identity';
const KNOWN_PROVIDERS = ['paystack', 'monnify', 'flutterwave'];

function isExactKey(index, expected) {
    const entries = Object.entries(index.key || {});
    const expectedEntries = Object.entries(expected);
    return entries.length === expectedEntries.length
        && expectedEntries.every(([key, value], position) => {
            return entries[position]?.[0] === key && entries[position]?.[1] === value;
        });
}

function isNamespaceNotFound(error) {
    return error?.code === 26
        || error?.codeName === 'NamespaceNotFound'
        || /\bns does not exist\b/i.test(String(error?.message || ''));
}

function emptyDataReport() {
    return {
        invalidIdentity: {
            missingProvider: 0,
            nullProvider: 0,
            nonStringProvider: 0,
            blankProvider: 0,
            missingEventId: 0,
            nullEventId: 0,
            nonStringEventId: 0,
            blankEventId: 0
        },
        duplicatePairs: [],
        unexpectedProviders: []
    };
}

async function readIndexes(collection) {
    try {
        return { collectionExists: true, indexes: await collection.indexes() };
    } catch (error) {
        if (isNamespaceNotFound(error)) return { collectionExists: false, indexes: [] };
        throw error;
    }
}

async function inspectData(collection) {
    const [missingProvider, nullProvider, nonStringProvider, blankProvider] = await Promise.all([
        collection.countDocuments({ provider: { $exists: false } }),
        collection.countDocuments({ provider: null }),
        collection.countDocuments({ provider: { $exists: true, $not: { $type: 'string' } } }),
        collection.countDocuments({ provider: { $type: 'string', $regex: /^\s*$/ } })
    ]);

    const [missingEventId, nullEventId, nonStringEventId, blankEventId] = await Promise.all([
        collection.countDocuments({ eventId: { $exists: false } }),
        collection.countDocuments({ eventId: null }),
        collection.countDocuments({ eventId: { $exists: true, $not: { $type: 'string' } } }),
        collection.countDocuments({ eventId: { $type: 'string', $regex: /^\s*$/ } })
    ]);

    const duplicatePairs = await collection.aggregate([
        {
            $match: {
                provider: { $type: 'string', $not: /^\s*$/ },
                eventId: { $type: 'string', $not: /^\s*$/ }
            }
        },
        { $group: { _id: { provider: '$provider', eventId: '$eventId' }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 }
    ]).toArray();

    const unexpectedProviders = await collection.aggregate([
        {
            $match: {
                provider: { $type: 'string', $not: /^\s*$/, $nin: KNOWN_PROVIDERS }
            }
        },
        { $group: { _id: '$provider', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 }
    ]).toArray();

    return {
        invalidIdentity: {
            missingProvider,
            nullProvider,
            nonStringProvider,
            blankProvider,
            missingEventId,
            nullEventId,
            nonStringEventId,
            blankEventId
        },
        duplicatePairs,
        unexpectedProviders
    };
}

function assertCompatible(report) {
    const invalidCount = Object.values(report.invalidIdentity).reduce((total, count) => total + count, 0);
    if (invalidCount > 0) {
        throw new Error(`Validation failed: ${invalidCount} invalid provider/eventId identity finding(s)`);
    }
    if (report.duplicatePairs.length > 0) {
        throw new Error(`Validation failed: ${report.duplicatePairs.length} duplicate provider/eventId pair(s) found`);
    }
    if (report.unexpectedProviders.length > 0) {
        throw new Error(`Validation failed: unexpected provider values found: ${report.unexpectedProviders.map(item => item._id).join(', ')}`);
    }
}

async function migrateCollection(collection, { apply, log = console.log } = {}) {
    const initialState = await readIndexes(collection);
    const { collectionExists, indexes } = initialState;
    const legacyUniqueIndexes = indexes.filter(index => index.unique && isExactKey(index, { eventId: 1 }));
    const compoundIndex = indexes.find(index => isExactKey(index, { provider: 1, eventId: 1 }));

    if (compoundIndex && !compoundIndex.unique) {
        throw new Error(`Index ${compoundIndex.name} exists but is not unique`);
    }

    const report = collectionExists ? await inspectData(collection) : emptyDataReport();
    if (!collectionExists) {
        log(`Collection ${COLLECTION_NAME} does not exist; treating it as empty.`);
    }
    log(JSON.stringify({
        mode: apply ? 'apply' : 'validation-only',
        collection: COLLECTION_NAME,
        collectionExists,
        currentIndexes: indexes.map(index => ({ name: index.name, key: index.key, unique: !!index.unique })),
        legacyUniqueIndexes: legacyUniqueIndexes.map(index => index.name),
        targetIndexPresent: !!compoundIndex,
        ...report
    }, null, 2));

    assertCompatible(report);

    if (!apply) {
        log('Validation passed. No indexes were changed. Re-run with --apply and the explicit confirmation variable during an approved deployment window.');
        return;
    }

    if (!compoundIndex) {
        await collection.createIndex(
            { provider: 1, eventId: 1 },
            { unique: true, name: COMPOUND_INDEX_NAME }
        );
        log(`Created unique index ${COMPOUND_INDEX_NAME}.`);
    }

    // Create the narrower provider-scoped guarantee before removing the old
    // global constraint so there is never an unindexed identity window.
    for (const index of legacyUniqueIndexes) {
        await collection.dropIndex(index.name);
        log(`Dropped legacy global unique index ${index.name}.`);
    }

    const finalState = await readIndexes(collection);
    const finalCompound = finalState.indexes.find(index => index.unique && isExactKey(index, { provider: 1, eventId: 1 }));
    const remainingLegacy = finalState.indexes.filter(index => index.unique && isExactKey(index, { eventId: 1 }));
    const freshIndexHasRequiredName = collectionExists || finalCompound?.name === COMPOUND_INDEX_NAME;
    if (!finalState.collectionExists || !finalCompound || !freshIndexHasRequiredName || remainingLegacy.length > 0) {
        throw new Error('Post-migration index verification failed');
    }

    log('Webhook event identity index migration completed and verified.');
}

async function run() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) throw new Error('MONGO_URI is required');

    const apply = process.argv.includes('--apply');
    if (apply && process.env.WEBHOOK_EVENT_INDEX_MIGRATION_CONFIRM !== APPLY_CONFIRMATION) {
        throw new Error(`Refusing --apply without WEBHOOK_EVENT_INDEX_MIGRATION_CONFIRM=${APPLY_CONFIRMATION}`);
    }

    await mongoose.connect(mongoUri, { autoIndex: false });
    try {
        const collection = mongoose.connection.collection(COLLECTION_NAME);
        await migrateCollection(collection, { apply });
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    run().catch(error => {
        console.error(`[Webhook Index Migration] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    inspectData,
    assertCompatible,
    isExactKey,
    isNamespaceNotFound,
    emptyDataReport,
    readIndexes,
    migrateCollection
};
