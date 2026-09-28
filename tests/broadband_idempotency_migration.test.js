'use strict';

const assert = require('assert');
const mongoose = require('mongoose');
const {
    APPLY_CONFIRMATION,
    INDEX_KEY,
    INDEX_NAME,
    INDEX_OPTIONS,
    assertDataSafe,
    inspectHistoricalRecovery,
    run
} = require('../scripts/migrate_broadband_idempotency_index');

const cursor = rows => ({ toArray: async () => rows });

function fakeMigration({
    databaseName = 'target',
    indexes = [{ name: '_id_', key: { _id: 1 } }],
    recoveryRows = [],
    duplicateGroups = [],
    references = {}
} = {}) {
    const state = {
        connected: 0,
        disconnected: 0,
        collectionCalls: 0,
        createCalls: [],
        writes: []
    };
    const currentIndexes = indexes.map(index => ({ ...index }));
    const collection = {
        async indexes() { return currentIndexes.map(index => ({ ...index })); },
        async countDocuments() { return 0; },
        aggregate() { return { toArray: async () => duplicateGroups }; },
        find(filter = {}) {
            return cursor(recoveryRows.filter(row => !filter.status || row.status === filter.status));
        },
        async createIndex(key, options) {
            state.createCalls.push({ key, options });
            currentIndexes.push({ name: options.name, key, ...options });
            return options.name;
        }
    };
    const referenceCollection = name => ({
        find(filter) {
            const wanted = new Set((filter?._id?.$in || []).map(id => id.toHexString()));
            return cursor((references[name] || []).filter(item => wanted.has(item._id.toHexString())));
        },
        async createIndex() {
            state.writes.push(`${name}.createIndex`);
            throw new Error('Unexpected reference write');
        }
    });
    const mongooseInstance = {
        connection: {
            name: databaseName,
            collection(name) {
                state.collectionCalls++;
                return name === 'transactions' ? collection : referenceCollection(name);
            }
        },
        async connect() { state.connected++; },
        async disconnect() { state.disconnected++; }
    };
    return { state, mongooseInstance, collection, referenceCollection };
}

const validMetadata = {
    broadbandPurchaseUrl: '/broadband/purchase',
    broadbandSuccessPath: 'status',
    broadbandSuccessValue: 'success',
    broadbandPendingPath: 'status',
    broadbandPendingValue: 'pending',
    broadbandFailurePath: 'status',
    broadbandFailureValue: 'failed',
    queryUrl: '/query',
    querySuccessPath: 'status',
    querySuccessValue: 'success',
    queryPendingPath: 'status',
    queryPendingValue: 'pending',
    queryFailurePath: 'status',
    queryFailureValue: 'failed',
    broadbandFieldMap: {
        request_id: 'request_id', serviceID: 'service_id', variation_code: 'variation_code',
        identifier: 'identifier', amount: 'amount'
    },
    queryFieldMap: { request_id: 'request_id' }
};

const validPayload = {
    serviceID: 'BROADBAND',
    variation_code: 'PLAN-1',
    identifier: 'SUBSCRIBER-1',
    amount: 900,
    phone: '08012345678'
};

function recoveryFixture(rowOverrides = {}, referenceOverrides = {}) {
    const providerId = new mongoose.Types.ObjectId();
    const offerId = new mongoose.Types.ObjectId();
    const serviceId = new mongoose.Types.ObjectId();
    const identityId = new mongoose.Types.ObjectId();
    const row = {
        _id: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        transactionId: 'ZNT-23456789ABCD',
        idempotencyKey: 'bbv:test-key',
        type: 'broadband',
        status: 'pending',
        dispatchState: 'not_dispatched',
        amount: 1000,
        provider: 'Provider',
        providerId,
        providerAdapterType: 'universal',
        providerRequestId: 'ZNT-P-23456789ABCDEFGH',
        providerOfferId: offerId,
        providerConfigSnapshot: {
            baseUrl: 'https://provider.example',
            metadata: {
                ...validMetadata,
                broadbandFieldMap: { ...validMetadata.broadbandFieldMap },
                queryFieldMap: { ...validMetadata.queryFieldMap }
            }
        },
        providerCredentialSnapshot: { apiKey: 'legacy-compatible-key' },
        pricingSnapshot: {
            serviceId,
            providerId,
            providerOfferId: offerId,
            salePrice: 1000
        },
        recoveryPayload: 'mockenc:payload',
        ...rowOverrides
    };
    const references = {
        providers: [{ _id: providerId, name: 'Provider', adapterType: 'universal', ...referenceOverrides.provider }],
        provideroffers: [{
            _id: offerId, serviceId, providerId, providerCode: 'PLAN-1',
            providerServiceCode: 'BROADBAND', costMode: 'fixed', ...referenceOverrides.offer
        }],
        services: [{ _id: serviceId, identityId, category: 'broadband', ...referenceOverrides.service }],
        serviceidentities: [{ _id: identityId, purchaseMode: 'plan', ...referenceOverrides.identity }]
    };
    return { row, references };
}

function fakeCrypto(decryptions = new Map([['mockenc:payload', JSON.stringify(validPayload)]])) {
    return {
        isEncrypted: value => typeof value === 'string' && value.startsWith('mockenc:'),
        decryptSecretStrict: value => decryptions.get(value) || null
    };
}

async function inspectFixture(fixture, cryptoHelpers = fakeCrypto()) {
    const fake = fakeMigration({ recoveryRows: [fixture.row], references: fixture.references });
    const report = await inspectHistoricalRecovery(fake.collection, {
        getCollection: name => fake.referenceCollection(name),
        cryptoHelpers
    });
    return { report, fake };
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
    const baseEnv = { MONGO_URI: 'mongodb://example.invalid/target' };

    await test('unsafe historical replay state fails validation', () => {
        for (const field of ['blank', 'untrimmed', 'oversized', 'invalidFingerprint', 'missingUser', 'unrecoverable']) {
            assert.throws(() => assertDataSafe({
                blank: 0,
                untrimmed: 0,
                oversized: 0,
                invalidFingerprint: 0,
                missingUser: 0,
                unrecoverable: 0,
                duplicates: [],
                [field]: 1
            }), /not safe/);
        }
    });

    await test('conflicting idempotency index aborts validation', async () => {
        const fake = fakeMigration({
            indexes: [{ name: INDEX_NAME, key: INDEX_KEY, unique: false }]
        });
        await assert.rejects(run({
            env: baseEnv,
            argv: ['node', 'migration'],
            mongooseInstance: fake.mongooseInstance,
            logger: { log() {} }
        }), /Conflicting index/);
        assert.strictEqual(fake.state.createCalls.length, 0);
    });

    await test('validation-only mode inspects without creating an index', async () => {
        const fake = fakeMigration();
        const logs = [];
        await run({
            env: baseEnv,
            argv: ['node', 'migration'],
            mongooseInstance: fake.mongooseInstance,
            logger: { log: message => logs.push(message) }
        });
        assert.strictEqual(fake.state.connected, 1);
        assert.strictEqual(fake.state.disconnected, 1);
        assert.strictEqual(fake.state.collectionCalls, 1);
        assert.deepStrictEqual(fake.state.createCalls, []);
        assert.deepStrictEqual(fake.state.writes, []);
        assert.ok(logs.some(message => String(message).includes('validation-only')));
    });

    await test('--apply without confirmation aborts before connecting', async () => {
        const fake = fakeMigration();
        await assert.rejects(run({
            env: { ...baseEnv, BROADBAND_IDEMPOTENCY_EXPECTED_DB: 'target' },
            argv: ['node', 'migration', '--apply'],
            mongooseInstance: fake.mongooseInstance,
            logger: { log() {} }
        }), /MIGRATION_CONFIRM/);
        assert.strictEqual(fake.state.connected, 0);
    });

    await test('--apply without expected database aborts before connecting', async () => {
        const fake = fakeMigration();
        await assert.rejects(run({
            env: { ...baseEnv, BROADBAND_IDEMPOTENCY_MIGRATION_CONFIRM: APPLY_CONFIRMATION },
            argv: ['node', 'migration', '--apply'],
            mongooseInstance: fake.mongooseInstance,
            logger: { log() {} }
        }), /EXPECTED_DB/);
        assert.strictEqual(fake.state.connected, 0);
    });

    await test('connected database mismatch aborts before collection access', async () => {
        const fake = fakeMigration({ databaseName: 'wrong-target' });
        await assert.rejects(run({
            env: {
                ...baseEnv,
                BROADBAND_IDEMPOTENCY_MIGRATION_CONFIRM: APPLY_CONFIRMATION,
                BROADBAND_IDEMPOTENCY_EXPECTED_DB: 'target'
            },
            argv: ['node', 'migration', '--apply'],
            mongooseInstance: fake.mongooseInstance,
            logger: { log() {} }
        }), /does not match/);
        assert.strictEqual(fake.state.collectionCalls, 0);
        assert.strictEqual(fake.state.disconnected, 1);
    });

    await test('matching guarded apply reaches mocked index creation idempotently', async () => {
        const fake = fakeMigration();
        const options = {
            env: {
                ...baseEnv,
                BROADBAND_IDEMPOTENCY_MIGRATION_CONFIRM: APPLY_CONFIRMATION,
                BROADBAND_IDEMPOTENCY_EXPECTED_DB: 'target'
            },
            argv: ['node', 'migration', '--apply'],
            mongooseInstance: fake.mongooseInstance,
            logger: { log() {} }
        };
        await run(options);
        await run(options);
        assert.strictEqual(fake.state.createCalls.length, 1);
        assert.deepStrictEqual(fake.state.createCalls[0], {
            key: INDEX_KEY,
            options: { ...INDEX_OPTIONS, name: INDEX_NAME }
        });
    });

    await test('safe encrypted historical recovery state is READY', async () => {
        const { report } = await inspectFixture(recoveryFixture());
        assert.strictEqual(report.scanned, 1);
        assert.strictEqual(report.unsafe, 0);
    });

    await test('plaintext and undecryptable recovery payloads are NOT READY', async () => {
        const plaintext = recoveryFixture({ recoveryPayload: JSON.stringify(validPayload) });
        let inspected = await inspectFixture(plaintext);
        assert.strictEqual(inspected.report.unsafe, 1);
        assert.strictEqual(inspected.report.issues.encryption.count, 1);
        const diagnostic = JSON.stringify(inspected.report);
        assert.ok(diagnostic.includes(plaintext.row._id.toHexString()));
        assert.ok(!diagnostic.includes('SUBSCRIBER-1'));
        assert.ok(!diagnostic.includes('08012345678'));
        assert.ok(!diagnostic.includes('mockenc:payload'));

        inspected = await inspectFixture(recoveryFixture(), fakeCrypto(new Map()));
        assert.strictEqual(inspected.report.unsafe, 1);
        assert.strictEqual(inspected.report.issues.encryption.count, 1);
    });

    await test('malformed decrypted recovery schema is NOT READY', async () => {
        const cryptoHelpers = fakeCrypto(new Map([
            ['mockenc:payload', JSON.stringify({ ...validPayload, phone: undefined })]
        ]));
        const { report } = await inspectFixture(recoveryFixture(), cryptoHelpers);
        assert.strictEqual(report.unsafe, 1);
        assert.strictEqual(report.issues.schema.count, 1);
    });

    await test('invalid BSON IDs are NOT READY and are not used in reference queries', async () => {
        const fixture = recoveryFixture({ providerId: new mongoose.Types.ObjectId().toHexString() });
        const { report } = await inspectFixture(fixture);
        assert.strictEqual(report.unsafe, 1);
        assert.strictEqual(report.issues.objectId.count, 1);
    });

    await test('missing referenced offer or provider is NOT READY', async () => {
        for (const collection of ['providers', 'provideroffers']) {
            const fixture = recoveryFixture();
            fixture.references[collection] = [];
            const { report } = await inspectFixture(fixture);
            assert.strictEqual(report.unsafe, 1);
            assert.strictEqual(report.issues.reference.count, 1);
        }
    });

    await test('incomplete provider recovery mapping is NOT READY', async () => {
        const fixture = recoveryFixture();
        delete fixture.row.providerConfigSnapshot.metadata.queryFailureValue;
        let inspected = await inspectFixture(fixture);
        assert.strictEqual(inspected.report.unsafe, 1);
        assert.strictEqual(inspected.report.issues.providerConfiguration.count, 1);

        const unsafeAuth = recoveryFixture();
        unsafeAuth.row.providerConfigSnapshot.metadata.authHeaderValue = 'Bearer {{apiKey}} literal-secret';
        inspected = await inspectFixture(unsafeAuth);
        assert.strictEqual(inspected.report.unsafe, 1);
        assert.strictEqual(inspected.report.issues.providerConfiguration.count, 1);

        const trailingNewline = recoveryFixture();
        trailingNewline.row.providerConfigSnapshot.metadata.authHeaderValue = 'Bearer {{apiKey}}\r\n';
        inspected = await inspectFixture(trailingNewline);
        assert.strictEqual(inspected.report.unsafe, 1);
        assert.strictEqual(inspected.report.issues.providerConfiguration.count, 1);
    });

    await test('dispatching recovery state validates exact-provider requery without dispatch payload', async () => {
        const fixture = recoveryFixture({
            dispatchState: 'dispatching',
            providerOutcome: 'unknown',
            recoveryPayload: undefined
        });
        const { report } = await inspectFixture(fixture);
        assert.strictEqual(report.scanned, 1);
        assert.strictEqual(report.unsafe, 0);
        assert.strictEqual(report.issues.encryption.count, 0);
    });

    await test('dispatching recovery state without provider request identity is NOT READY', async () => {
        const fixture = recoveryFixture({
            dispatchState: 'dispatching',
            providerOutcome: 'unknown',
            providerRequestId: undefined,
            recoveryPayload: undefined
        });
        const { report } = await inspectFixture(fixture);
        assert.strictEqual(report.unsafe, 1);
        assert.strictEqual(report.issues.reference.count, 1);
    });

    await test('dispatched pending recovery state with exact query configuration is READY', async () => {
        const fixture = recoveryFixture({
            dispatchState: 'dispatched',
            providerOutcome: 'pending',
            recoveryPayload: undefined
        });
        const { report } = await inspectFixture(fixture);
        assert.strictEqual(report.scanned, 1);
        assert.strictEqual(report.unsafe, 0);
    });

    await test('dispatched pending recovery state with unusable query mapping is NOT READY', async () => {
        const fixture = recoveryFixture({
            dispatchState: 'dispatched',
            providerOutcome: 'pending',
            recoveryPayload: undefined
        });
        delete fixture.row.providerConfigSnapshot.metadata.queryFieldMap.request_id;
        const { report } = await inspectFixture(fixture);
        assert.strictEqual(report.unsafe, 1);
        assert.strictEqual(report.issues.providerConfiguration.count, 1);
    });

    await test('terminal Broadband transaction does not require dispatch recovery material', async () => {
        const fixture = recoveryFixture({
            status: 'success',
            dispatchState: 'dispatched',
            recoveryPayload: undefined,
            providerRequestId: undefined
        });
        const { report } = await inspectFixture(fixture);
        assert.strictEqual(report.scanned, 0);
        assert.strictEqual(report.unsafe, 0);
    });

    await test('duplicate diagnostics contain safe transaction IDs and never raw idempotency keys', async () => {
        const rawKey = 'RAW-IDEMPOTENCY-KEY-SUPER-SECRET';
        const duplicateGroups = [{
            _id: { userId: new mongoose.Types.ObjectId(), idempotencyKey: rawKey },
            count: 2,
            transactionIds: ['ZNT-23456789ABCD', 'ZNT-3456789ABCDE']
        }];
        const fake = fakeMigration({ duplicateGroups });
        const logs = [];
        await assert.rejects(run({
            env: baseEnv,
            argv: ['node', 'migration'],
            mongooseInstance: fake.mongooseInstance,
            logger: { log: message => logs.push(String(message)) }
        }), /not safe/);
        const output = logs.join('\n');
        assert.ok(output.includes('ZNT-23456789ABCD'));
        assert.ok(output.includes('"count": 2'));
        assert.ok(!output.includes(rawKey));
        const diagnostic = JSON.parse(logs.find(message => message.trim().startsWith('{')));
        assert.deepStrictEqual(diagnostic.data.duplicates, [{
            count: 2,
            transactionIds: ['ZNT-23456789ABCD', 'ZNT-3456789ABCDE']
        }]);
        assert.deepStrictEqual(fake.state.createCalls, []);
        assert.deepStrictEqual(fake.state.writes, []);
    });

    await test('unsafe post-dispatch recovery state blocks guarded apply', async () => {
        const fixture = recoveryFixture({
            dispatchState: 'dispatched',
            providerOutcome: 'pending',
            providerRequestId: undefined,
            recoveryPayload: undefined
        });
        const fake = fakeMigration({ recoveryRows: [fixture.row], references: fixture.references });
        await assert.rejects(run({
            env: {
                ...baseEnv,
                BROADBAND_IDEMPOTENCY_MIGRATION_CONFIRM: APPLY_CONFIRMATION,
                BROADBAND_IDEMPOTENCY_EXPECTED_DB: 'target'
            },
            argv: ['node', 'migration', '--apply'],
            mongooseInstance: fake.mongooseInstance,
            cryptoHelpers: fakeCrypto(),
            logger: { log() {} }
        }), /not safe/);
        assert.strictEqual(fake.state.createCalls.length, 0);
        assert.deepStrictEqual(fake.state.writes, []);
    });

    await test('--apply refuses unsafe recovery state before index creation', async () => {
        const fixture = recoveryFixture({ recoveryPayload: JSON.stringify(validPayload) });
        const fake = fakeMigration({ recoveryRows: [fixture.row], references: fixture.references });
        await assert.rejects(run({
            env: {
                ...baseEnv,
                BROADBAND_IDEMPOTENCY_MIGRATION_CONFIRM: APPLY_CONFIRMATION,
                BROADBAND_IDEMPOTENCY_EXPECTED_DB: 'target'
            },
            argv: ['node', 'migration', '--apply'],
            mongooseInstance: fake.mongooseInstance,
            cryptoHelpers: fakeCrypto(),
            logger: { log() {} }
        }), /not safe/);
        assert.strictEqual(fake.state.createCalls.length, 0);
        assert.deepStrictEqual(fake.state.writes, []);
    });

    console.log(`\nBroadband idempotency migration tests: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
