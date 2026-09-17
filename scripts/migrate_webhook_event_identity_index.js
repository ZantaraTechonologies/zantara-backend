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
        const indexes = await collection.indexes();
        const legacyUniqueIndexes = indexes.filter(index => index.unique && isExactKey(index, { eventId: 1 }));
        const compoundIndex = indexes.find(index => isExactKey(index, { provider: 1, eventId: 1 }));

        if (compoundIndex && !compoundIndex.unique) {
            throw new Error(`Index ${compoundIndex.name} exists but is not unique`);
        }

        const report = await inspectData(collection);
        console.log(JSON.stringify({
            mode: apply ? 'apply' : 'validation-only',
            collection: COLLECTION_NAME,
            currentIndexes: indexes.map(index => ({ name: index.name, key: index.key, unique: !!index.unique })),
            legacyUniqueIndexes: legacyUniqueIndexes.map(index => index.name),
            targetIndexPresent: !!compoundIndex,
            ...report
        }, null, 2));

        assertCompatible(report);

        if (!apply) {
            console.log('Validation passed. No indexes were changed. Re-run with --apply and the explicit confirmation variable during an approved deployment window.');
            return;
        }

        if (!compoundIndex) {
            await collection.createIndex(
                { provider: 1, eventId: 1 },
                { unique: true, name: COMPOUND_INDEX_NAME }
            );
            console.log(`Created unique index ${COMPOUND_INDEX_NAME}.`);
        }

        // Create the narrower provider-scoped guarantee before removing the old
        // global constraint so there is never an unindexed identity window.
        for (const index of legacyUniqueIndexes) {
            await collection.dropIndex(index.name);
            console.log(`Dropped legacy global unique index ${index.name}.`);
        }

        const finalIndexes = await collection.indexes();
        const finalCompound = finalIndexes.find(index => index.unique && isExactKey(index, { provider: 1, eventId: 1 }));
        const remainingLegacy = finalIndexes.filter(index => index.unique && isExactKey(index, { eventId: 1 }));
        if (!finalCompound || remainingLegacy.length > 0) {
            throw new Error('Post-migration index verification failed');
        }

        console.log('Webhook event identity index migration completed and verified.');
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

module.exports = { inspectData, assertCompatible, isExactKey };
