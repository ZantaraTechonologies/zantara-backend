'use strict';

const assert = require('node:assert');
const { migrateCollection } = require('../scripts/migrate_webhook_event_identity_index');

const namespaceNotFound = () => {
    const error = new Error('ns does not exist: zantara.webhookevents');
    error.code = 26;
    error.codeName = 'NamespaceNotFound';
    return error;
};

function fakeCollection({ exists = true, indexes = [{ name: '_id_', key: { _id: 1 } }], counts = [], aggregates = [] } = {}) {
    const state = {
        exists,
        indexes: indexes.map(index => ({ ...index, key: { ...index.key } })),
        countCalls: 0,
        aggregateCalls: 0,
        actions: [],
    };
    return {
        state,
        async indexes() {
            if (!state.exists) throw namespaceNotFound();
            return state.indexes.map(index => ({ ...index, key: { ...index.key } }));
        },
        async countDocuments() {
            state.countCalls++;
            return counts.shift() || 0;
        },
        aggregate() {
            state.aggregateCalls++;
            const result = aggregates.shift() || [];
            return { toArray: async () => result };
        },
        async createIndex(key, options) {
            state.actions.push(`create:${options.name}`);
            state.exists = true;
            state.indexes.push({ name: options.name, key: { ...key }, unique: Boolean(options.unique) });
            return options.name;
        },
        async dropIndex(name) {
            state.actions.push(`drop:${name}`);
            state.indexes = state.indexes.filter(index => index.name !== name);
        },
    };
}

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

    await test('missing collection validation passes without creating collection or index', async () => {
        const collection = fakeCollection({ exists: false });
        const logs = [];
        await migrateCollection(collection, { apply: false, log: message => logs.push(message) });
        assert.strictEqual(collection.state.exists, false);
        assert.strictEqual(collection.state.countCalls, 0);
        assert.strictEqual(collection.state.aggregateCalls, 0);
        assert.deepStrictEqual(collection.state.actions, []);
        assert.ok(logs.some(message => message.includes('does not exist; treating it as empty')));
        const report = JSON.parse(logs.find(message => message.startsWith('{')));
        assert.strictEqual(report.collectionExists, false);
        assert.deepStrictEqual(report.invalidIdentity, {
            missingProvider: 0,
            nullProvider: 0,
            nonStringProvider: 0,
            blankProvider: 0,
            missingEventId: 0,
            nullEventId: 0,
            nonStringEventId: 0,
            blankEventId: 0,
        });
        assert.deepStrictEqual(report.duplicatePairs, []);
        assert.deepStrictEqual(report.unexpectedProviders, []);
        assert.ok(logs.some(message => message.startsWith('Validation passed.')));
    });

    await test('missing collection apply creates and verifies required compound unique index', async () => {
        const collection = fakeCollection({ exists: false });
        await migrateCollection(collection, { apply: true, log: () => {} });
        assert.strictEqual(collection.state.exists, true);
        assert.deepStrictEqual(collection.state.actions, ['create:provider_1_eventId_1']);
        assert.deepStrictEqual(collection.state.indexes, [
            { name: '_id_', key: { _id: 1 } },
            {
                name: 'provider_1_eventId_1',
                key: { provider: 1, eventId: 1 },
                unique: true,
            },
        ]);
    });

    await test('existing valid collection is inspected and installs target before dropping legacy index', async () => {
        const collection = fakeCollection({
            indexes: [
                { name: '_id_', key: { _id: 1 } },
                { name: 'eventId_1', key: { eventId: 1 }, unique: true },
            ],
        });
        await migrateCollection(collection, { apply: true, log: () => {} });
        assert.strictEqual(collection.state.countCalls, 8);
        assert.strictEqual(collection.state.aggregateCalls, 2);
        assert.deepStrictEqual(collection.state.actions, [
            'create:provider_1_eventId_1',
            'drop:eventId_1',
        ]);
    });

    await test('existing malformed, duplicate, and unexpected provider data still fail closed', async () => {
        const malformed = fakeCollection({ counts: [1] });
        await assert.rejects(
            migrateCollection(malformed, { apply: true, log: () => {} }),
            /invalid provider\/eventId identity/
        );
        assert.deepStrictEqual(malformed.state.actions, []);

        const duplicate = fakeCollection({
            aggregates: [[{ _id: { provider: 'paystack', eventId: 'duplicate' }, count: 2 }], []],
        });
        await assert.rejects(
            migrateCollection(duplicate, { apply: true, log: () => {} }),
            /duplicate provider\/eventId pair/
        );
        assert.deepStrictEqual(duplicate.state.actions, []);

        const unexpectedProvider = fakeCollection({
            aggregates: [[], [{ _id: 'unknown-provider', count: 1 }]],
        });
        await assert.rejects(
            migrateCollection(unexpectedProvider, { apply: true, log: () => {} }),
            /unexpected provider values/
        );
        assert.deepStrictEqual(unexpectedProvider.state.actions, []);
    });

    console.log(`\nWebhook event identity migration tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
