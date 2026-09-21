'use strict';

/**
 * Focused first-SuperAdmin bootstrap tests.
 * Run: node tests/bootstrap_superadmin.test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
    BCRYPT_COST,
    CONFIRMATION_VALUE,
    validateBootstrapEnvironment,
    bootstrapSuperAdmin,
    runCli
} = require('../scripts/bootstrap_superadmin');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`[PASS] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(`       ${error.message}`);
    }
}

function validEnvironment(overrides = {}) {
    return {
        MONGO_URI: 'mongodb://localhost:27017/zantara_bootstrap_test',
        BOOTSTRAP_SUPERADMIN_CONFIRM: CONFIRMATION_VALUE,
        BOOTSTRAP_SUPERADMIN_NAME: ' Initial Admin ',
        BOOTSTRAP_SUPERADMIN_PHONE: ' 08012345678 ',
        BOOTSTRAP_SUPERADMIN_EMAIL: ' Admin@Example.COM ',
        BOOTSTRAP_SUPERADMIN_PASSWORD: 'temporary-secret-password',
        ...overrides
    };
}

function fakeUserModel(options = {}) {
    const existsResults = [...(options.existsResults || [null, null])];
    const state = {
        createCalls: [],
        existsCalls: [],
        findByIdCalls: []
    };

    const model = {
        async exists(filter) {
            state.existsCalls.push(filter);
            return existsResults.length ? existsResults.shift() : null;
        },
        async create(data) {
            state.createCalls.push({ ...data, roles: [...data.roles] });
            if (options.createError) throw options.createError;
            return { _id: '507f1f77bcf86cd799439011', ...data };
        },
        findById(id) {
            state.findByIdCalls.push(id);
            return {
                select: async () => {
                    const created = state.createCalls[0];
                    if (!created) return null;
                    return {
                        _id: id,
                        ...created,
                        ...(options.persistedOverrides || {})
                    };
                }
            };
        }
    };

    return { model, state };
}

function fakeBcrypt(hash = '$2b$12$bootstrap-test-hash') {
    const calls = [];
    return {
        calls,
        module: {
            async hash(value, cost) {
                calls.push({ value, cost });
                return hash;
            }
        }
    };
}

async function run() {
    await test('missing MONGO_URI is rejected', () => {
        assert.throws(
            () => validateBootstrapEnvironment(validEnvironment({ MONGO_URI: undefined })),
            /MONGO_URI is required/
        );
    });

    await test('missing confirmation is rejected', () => {
        assert.throws(
            () => validateBootstrapEnvironment(validEnvironment({ BOOTSTRAP_SUPERADMIN_CONFIRM: undefined })),
            /must exactly equal/
        );
    });

    await test('incorrect confirmation is rejected', () => {
        assert.throws(
            () => validateBootstrapEnvironment(validEnvironment({ BOOTSTRAP_SUPERADMIN_CONFIRM: 'yes' })),
            /must exactly equal/
        );
    });

    await test('missing required identity values are rejected while email remains optional', () => {
        for (const key of [
            'BOOTSTRAP_SUPERADMIN_NAME',
            'BOOTSTRAP_SUPERADMIN_PHONE',
            'BOOTSTRAP_SUPERADMIN_PASSWORD'
        ]) {
            assert.throws(() => validateBootstrapEnvironment(validEnvironment({ [key]: '' })), /is required/);
        }
        const withoutEmail = validateBootstrapEnvironment(
            validEnvironment({ BOOTSTRAP_SUPERADMIN_EMAIL: undefined })
        );
        assert.equal(withoutEmail.email, undefined);
    });

    await test('identity values use registration-compatible normalization', () => {
        const config = validateBootstrapEnvironment(validEnvironment());
        assert.equal(config.name, 'Initial Admin');
        assert.equal(config.phone, '08012345678');
        assert.equal(config.email, 'admin@example.com');
        assert.equal(config.password, 'temporary-secret-password');
    });

    await test('an existing SuperAdmin aborts before hashing or creation', async () => {
        const users = fakeUserModel({ existsResults: [{ _id: 'existing-admin' }] });
        const hashing = fakeBcrypt();
        await assert.rejects(
            () => bootstrapSuperAdmin(validateBootstrapEnvironment(validEnvironment()), {
                UserModel: users.model,
                bcryptModule: hashing.module
            }),
            /already exists/
        );
        assert.equal(hashing.calls.length, 0);
        assert.equal(users.state.createCalls.length, 0);
    });

    await test('a connected CLI run disconnects when the existing-SuperAdmin guard aborts', async () => {
        const users = fakeUserModel({ existsResults: [{ _id: 'existing-admin' }] });
        let connectCalls = 0;
        let disconnectCalls = 0;
        const mongooseInstance = {
            async connect() { connectCalls++; },
            async disconnect() { disconnectCalls++; }
        };

        await assert.rejects(
            () => runCli({
                env: validEnvironment(),
                mongooseInstance,
                UserModel: users.model,
                bcryptModule: fakeBcrypt().module,
                logger: { log() {} }
            }),
            /already exists/
        );
        assert.equal(connectCalls, 1);
        assert.equal(disconnectCalls, 1);
        assert.equal(users.state.createCalls.length, 0);
    });

    await test('duplicate phone or email aborts without modifying the existing user', async () => {
        for (const duplicateId of ['duplicate-phone', 'duplicate-email']) {
            const users = fakeUserModel({ existsResults: [null, { _id: duplicateId }] });
            await assert.rejects(
                () => bootstrapSuperAdmin(validateBootstrapEnvironment(validEnvironment()), {
                    UserModel: users.model,
                    bcryptModule: fakeBcrypt().module
                }),
                /phone or email already exists/
            );
            assert.equal(users.state.createCalls.length, 0);
        }
    });

    await test('one active SuperAdmin is created through the User model with a hashed password', async () => {
        const users = fakeUserModel();
        const hashing = fakeBcrypt();
        const config = validateBootstrapEnvironment(validEnvironment());
        const result = await bootstrapSuperAdmin(config, {
            UserModel: users.model,
            bcryptModule: hashing.module
        });

        assert.equal(hashing.calls.length, 1);
        assert.deepEqual(hashing.calls[0], {
            value: 'temporary-secret-password',
            cost: BCRYPT_COST
        });
        assert.equal(users.state.createCalls.length, 1);
        const created = users.state.createCalls[0];
        assert.notEqual(created.password, config.password);
        assert.equal(created.password, '$2b$12$bootstrap-test-hash');
        assert.equal(created.status, true);
        assert.equal(created.role, 'superAdmin');
        assert.deepEqual(created.roles, ['superAdmin']);
        assert.equal(created.phone, '08012345678');
        assert.equal(created.email, 'admin@example.com');
        assert.equal(result._id, '507f1f77bcf86cd799439011');
        assert.equal(users.state.findByIdCalls.length, 1);
    });

    await test('the script deliberately creates no associated bootstrap records', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'scripts', 'bootstrap_superadmin.js'),
            'utf8'
        );
        assert.doesNotMatch(source, /Wallet\.create|LegalAcceptance\.(?:create|insertMany)/);
        assert.doesNotMatch(source, /Kyc\.create|Notification\.create|Transaction\.create/);
        assert.doesNotMatch(source, /createReservedAccount|transactionPin\s*:/);
    });

    await test('normal success output emits no URI, password, hash, or unmasked identity', async () => {
        const users = fakeUserModel();
        const hashing = fakeBcrypt();
        const output = [];
        const connections = [];
        const mongooseInstance = {
            async connect(uri, options) { connections.push({ uri, options }); },
            async disconnect() { connections.push({ disconnected: true }); }
        };

        await runCli({
            env: validEnvironment(),
            mongooseInstance,
            UserModel: users.model,
            bcryptModule: hashing.module,
            logger: { log: message => output.push(String(message)) }
        });

        const text = output.join('\n');
        assert.equal(connections.length, 2);
        assert.match(text, /Active SuperAdmin role verified/);
        assert.doesNotMatch(text, /temporary-secret-password/);
        assert.doesNotMatch(text, /mongodb:\/\//);
        assert.doesNotMatch(text, /\$2b\$12\$bootstrap-test-hash/);
        assert.doesNotMatch(text, /08012345678/);
        assert.doesNotMatch(text, /admin@example\.com/);
    });

    console.log(`\nSuperAdmin bootstrap: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
}

run().catch(error => {
    console.error('[FATAL]', error.message);
    process.exitCode = 1;
});
