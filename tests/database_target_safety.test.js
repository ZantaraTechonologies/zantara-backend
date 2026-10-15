'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
    hasExplicitDatabaseName,
    requiresExpectedDatabaseName,
    validateDatabaseTargetConfiguration,
    databaseTargetConnectionOptions,
    assertConnectedDatabaseName,
    sanitizeDatabaseErrorMessage
} = require('../config/db');
const { validateEncryptionConfiguration } = require('../utils/crypto');
const {
    APPLY_CONFIRMATION: TRANSACTION_CONFIRMATION,
    run: runTransactionMigration
} = require('../scripts/migrate_transaction_identifier_indexes');
const {
    APPLY_CONFIRMATION: WALLET_CONFIRMATION,
    run: runWalletMigration
} = require('../scripts/migrate_phase5a_wallet_identity_index');

const MONGO_URI = 'mongodb://user:secret@database.example.test:27017/zantara';
const PATHLESS_MONGO_URI = 'mongodb://user:secret@database.example.test:27017/';

function mismatchedMongoose() {
    const state = { connectOptions: null, collectionAccesses: 0, disconnects: 0 };
    return {
        state,
        connection: {
            name: 'wrong-database',
            collection() {
                state.collectionAccesses++;
                throw new Error('collection must not be accessed');
            }
        },
        async connect(_uri, options) {
            state.connectOptions = options;
        },
        async disconnect() {
            state.disconnects++;
        }
    };
}

test('database target configuration supports explicit URI and pathless selector modes', () => {
    assert.equal(hasExplicitDatabaseName('mongodb://localhost:27017/zantara'), true);
    assert.equal(hasExplicitDatabaseName('mongodb+srv://user:secret@example.test/zantara?retryWrites=true'), true);
    assert.equal(hasExplicitDatabaseName('mongodb://localhost:27017'), false);
    assert.equal(hasExplicitDatabaseName('mongodb+srv://user:secret@example.test/?retryWrites=true'), false);

    assert.equal(requiresExpectedDatabaseName({ nodeEnv: 'development' }), false);
    assert.equal(requiresExpectedDatabaseName({ nodeEnv: 'test' }), false);
    assert.equal(requiresExpectedDatabaseName({ nodeEnv: 'production' }), true);
    assert.equal(requiresExpectedDatabaseName({ nodeEnv: 'staging' }), true);
    assert.equal(requiresExpectedDatabaseName({ nodeEnv: ' Production ' }), true);
    assert.equal(requiresExpectedDatabaseName({ nodeEnv: 'STAGING' }), true);
    assert.equal(requiresExpectedDatabaseName({ nodeEnv: 'development', apply: true }), true);

    assert.equal(validateDatabaseTargetConfiguration({
        mongoUri: MONGO_URI,
        nodeEnv: 'test'
    }), 'zantara');
    assert.deepEqual(databaseTargetConnectionOptions({
        mongoUri: MONGO_URI,
        databaseName: 'zantara'
    }), {});
    assert.equal(validateDatabaseTargetConfiguration({
        mongoUri: PATHLESS_MONGO_URI,
        databaseName: 'test',
        nodeEnv: 'test'
    }), 'test');
    assert.deepEqual(databaseTargetConnectionOptions({
        mongoUri: PATHLESS_MONGO_URI,
        databaseName: 'test'
    }), { dbName: 'test' });
    assert.throws(() => validateDatabaseTargetConfiguration({
        mongoUri: MONGO_URI,
        nodeEnv: 'production'
    }), /EXPECTED_DB_NAME/);
    assert.throws(() => validateDatabaseTargetConfiguration({
        mongoUri: MONGO_URI,
        nodeEnv: 'development',
        apply: true
    }), /EXPECTED_DB_NAME/);
    assert.throws(() => validateDatabaseTargetConfiguration({
        mongoUri: PATHLESS_MONGO_URI,
        expectedDatabaseName: 'test',
        nodeEnv: 'production'
    }), /MONGO_DB_NAME/);
    assert.throws(() => validateDatabaseTargetConfiguration({
        mongoUri: MONGO_URI,
        databaseName: 'other',
        expectedDatabaseName: 'zantara',
        nodeEnv: 'production'
    }), /MONGO_DB_NAME does not match/);
    assert.throws(() => validateDatabaseTargetConfiguration({
        mongoUri: PATHLESS_MONGO_URI,
        databaseName: 'test',
        expectedDatabaseName: 'other',
        nodeEnv: 'production'
    }), /Configured database does not match/);
});

test('connected database checks are exact and do not disclose configured values', () => {
    assert.doesNotThrow(() => assertConnectedDatabaseName('zantara', 'zantara'));
    assert.doesNotThrow(() => assertConnectedDatabaseName('local-db', ''));
    assert.throws(
        () => assertConnectedDatabaseName('Zantara', 'zantara'),
        error => error.message === 'Connected database does not match EXPECTED_DB_NAME'
            && !error.message.includes('Zantara')
            && !error.message.includes('zantara')
    );

    const sanitized = sanitizeDatabaseErrorMessage(
        new Error(`Connection to ${MONGO_URI} failed for user and secret`),
        MONGO_URI
    );
    assert.equal(sanitized.includes(MONGO_URI), false);
    assert.equal(sanitized.includes('user'), false);
    assert.equal(sanitized.includes('secret'), false);
});

test('deployment environment normalization remains fail closed for encryption configuration', () => {
    const originalEnvironment = process.env.NODE_ENV;
    const originalKey = process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY;
    try {
        process.env.NODE_ENV = ' Production ';
        delete process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY;
        assert.throws(() => validateEncryptionConfiguration(), /PROVIDER_CREDENTIAL_ENCRYPTION_KEY/);
    } finally {
        if (originalEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalEnvironment;
        if (originalKey === undefined) delete process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY;
        else process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY = originalKey;
    }
});

test('transaction migration checks connected identity before collection access', async () => {
    const mongooseInstance = mismatchedMongoose();
    await assert.rejects(runTransactionMigration({
        env: {
            NODE_ENV: 'development',
            MONGO_URI,
            EXPECTED_DB_NAME: 'zantara',
            TRANSACTION_IDENTIFIER_MIGRATION_CONFIRM: TRANSACTION_CONFIRMATION
        },
        argv: ['node', 'migration', '--apply'],
        mongooseInstance,
        logger: { log() {} }
    }), /does not match EXPECTED_DB_NAME/);

    assert.deepEqual(mongooseInstance.state.connectOptions, {
        autoIndex: false,
        autoCreate: false
    });
    assert.equal(mongooseInstance.state.collectionAccesses, 0);
    assert.equal(mongooseInstance.state.disconnects, 1);
});

test('pathless migration connection uses approved dbName and still verifies connected identity', async () => {
    const mongooseInstance = mismatchedMongoose();
    await assert.rejects(runTransactionMigration({
        env: {
            NODE_ENV: 'development',
            MONGO_URI: PATHLESS_MONGO_URI,
            MONGO_DB_NAME: 'test',
            EXPECTED_DB_NAME: 'test'
        },
        argv: ['node', 'migration'],
        mongooseInstance,
        logger: { log() {} }
    }), /does not match EXPECTED_DB_NAME/);

    assert.deepEqual(mongooseInstance.state.connectOptions, {
        autoIndex: false,
        autoCreate: false,
        dbName: 'test'
    });
    assert.equal(mongooseInstance.state.collectionAccesses, 0);
});

test('wallet migration checks connected identity before collection access', async () => {
    const mongooseInstance = mismatchedMongoose();
    await assert.rejects(runWalletMigration({
        env: {
            NODE_ENV: 'development',
            MONGO_URI,
            EXPECTED_DB_NAME: 'zantara',
            PHASE5A_WALLET_INDEX_CONFIRM: WALLET_CONFIRMATION
        },
        argv: ['node', 'migration', '--apply'],
        mongooseInstance,
        logger: { log() {} }
    }), /does not match EXPECTED_DB_NAME/);

    assert.deepEqual(mongooseInstance.state.connectOptions, {
        autoIndex: false,
        autoCreate: false
    });
    assert.equal(mongooseInstance.state.collectionAccesses, 0);
    assert.equal(mongooseInstance.state.disconnects, 1);
});

test('migration apply requires EXPECTED_DB_NAME before connecting', async () => {
    for (const [run, confirmationName, confirmation] of [
        [runTransactionMigration, 'TRANSACTION_IDENTIFIER_MIGRATION_CONFIRM', TRANSACTION_CONFIRMATION],
        [runWalletMigration, 'PHASE5A_WALLET_INDEX_CONFIRM', WALLET_CONFIRMATION]
    ]) {
        let connects = 0;
        const mongooseInstance = {
            async connect() { connects++; },
            connection: {},
            async disconnect() {}
        };
        await assert.rejects(run({
            env: {
                NODE_ENV: 'development',
                MONGO_URI,
                [confirmationName]: confirmation
            },
            argv: ['node', 'migration', '--apply'],
            mongooseInstance,
            logger: { log() {} }
        }), /EXPECTED_DB_NAME/);
        assert.equal(connects, 0);
    }
});

test('all existing mutating migration entry points require EXPECTED_DB_NAME on apply', () => {
    const scripts = [
        ['migrate_batch3_financial_integrity.js', 'BATCH3_FINANCIAL_MIGRATION_CONFIRM', 'batch3-financial-integrity'],
        ['migrate_webhook_event_identity_index.js', 'WEBHOOK_EVENT_INDEX_MIGRATION_CONFIRM', 'provider-event-identity'],
        ['migrate_kyc_pending_index.js', 'KYC_PENDING_INDEX_MIGRATION_CONFIRM', 'kyc-pending-index']
    ];

    for (const [filename, confirmationName, confirmation] of scripts) {
        const result = spawnSync(
            process.execPath,
            [path.join(__dirname, '..', 'scripts', filename), '--apply'],
            {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    NODE_ENV: 'development',
                    MONGO_URI,
                    EXPECTED_DB_NAME: '',
                    [confirmationName]: confirmation
                }
            }
        );
        assert.notEqual(result.status, 0, `${filename} must reject apply without EXPECTED_DB_NAME`);
        assert.match(`${result.stdout}\n${result.stderr}`, /EXPECTED_DB_NAME/);
    }
});
