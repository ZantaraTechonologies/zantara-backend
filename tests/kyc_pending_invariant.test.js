'use strict';

const assert = require('assert/strict');
const mongoose = require('mongoose');
const Kyc = require('../models/Kyc');
const {
    TARGET_INDEX,
    hasExplicitDatabaseName,
    databaseNameFromArgs,
    indexMatches,
    assertNoIndexConflict,
    assertCompatible,
    ensureTargetIndex
} = require('../scripts/migrate_kyc_pending_index');

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

const cleanReport = () => ({
    pendingOwnerFindings: { missingUserId: 0, nullUserId: 0, malformedUserId: 0 },
    duplicatePending: { groups: 0, records: 0, maxPerUser: 0 },
    statusCounts: []
});

async function runUnitTests() {
    await test('KYC schema declares the exact migration-controlled pending unique index', () => {
        assert.equal(Kyc.schema.options.autoIndex, false);
        const declared = Kyc.schema.indexes().find(([, options]) => options.name === TARGET_INDEX.name);
        assert.ok(declared);
        assert.deepEqual(declared[0], TARGET_INDEX.key);
        assert.equal(declared[1].unique, true);
        assert.deepEqual(declared[1].partialFilterExpression, { status: 'pending' });
    });

    await test('migration requires an explicit database name', () => {
        assert.equal(hasExplicitDatabaseName('mongodb://localhost:27017/zantara'), true);
        assert.equal(hasExplicitDatabaseName('mongodb+srv://user:pass@example.test/zantara?retryWrites=true'), true);
        assert.equal(hasExplicitDatabaseName('mongodb://localhost:27017'), false);
        assert.equal(hasExplicitDatabaseName('mongodb+srv://user:pass@example.test/?retryWrites=true'), false);
        assert.equal(databaseNameFromArgs(['node', 'script', '--database=zantara_test']), 'zantara_test');
        assert.equal(databaseNameFromArgs(['node', 'script']), null);
        assert.throws(() => databaseNameFromArgs(['node', 'script', '--database=bad/name']), /invalid/i);
    });

    await test('preflight fails closed for malformed pending owners and duplicate pending groups', () => {
        assert.doesNotThrow(() => assertCompatible(cleanReport()));
        assert.throws(() => assertCompatible({
            ...cleanReport(),
            pendingOwnerFindings: { missingUserId: 1, nullUserId: 0, malformedUserId: 0 }
        }), /malformed or missing userId/i);
        assert.throws(() => assertCompatible({
            ...cleanReport(),
            duplicatePending: { groups: 1, records: 2, maxPerUser: 2 }
        }), /duplicate pending/i);
    });

    await test('index verification accepts only the exact named partial unique definition', () => {
        const exact = {
            name: TARGET_INDEX.name,
            key: TARGET_INDEX.key,
            unique: true,
            partialFilterExpression: { status: 'pending' }
        };
        assert.equal(indexMatches(exact), true);
        assert.equal(indexMatches({ ...exact, unique: false }), false);
        assert.equal(indexMatches({ ...exact, partialFilterExpression: { status: 'approved' } }), false);
        assert.throws(() => assertNoIndexConflict([{ ...exact, unique: false }]), /conflict/i);
        assert.throws(() => assertNoIndexConflict([{ ...exact, name: 'wrong_name' }]), /conflict/i);
        assert.throws(() => assertNoIndexConflict([exact, { ...exact, name: 'also_wrong' }]), /conflict/i);
    });

    await test('index installation creates once, verifies, and is idempotent', async () => {
        const indexes = [{ name: '_id_', key: { _id: 1 }, unique: true }];
        let createCalls = 0;
        const collection = {
            indexes: async () => indexes,
            createIndex: async (key, options) => {
                createCalls++;
                assert.deepEqual(key, TARGET_INDEX.key);
                assert.deepEqual(options.partialFilterExpression, { status: 'pending' });
                indexes.push({ name: options.name, key, ...options });
                return options.name;
            }
        };

        const first = await ensureTargetIndex(collection);
        assert.equal(indexMatches(first), true);
        assert.equal(createCalls, 1);
        const second = await ensureTargetIndex(collection);
        assert.equal(indexMatches(second), true);
        assert.equal(createCalls, 1);
    });
}

async function runRealDatabaseTests() {
    if (!process.argv.includes('--real')) {
        console.log('[SKIP] real MongoDB KYC invariant tests require --real');
        return;
    }
    const realTestConfirmed = process.env.KYC_PENDING_INDEX_TEST_CONFIRM === 'kyc-pending-index-test'
        || process.argv.includes('--confirm-real=kyc-pending-index-test');
    if (!realTestConfirmed) {
        throw new Error('Refusing real test without KYC_PENDING_INDEX_TEST_CONFIRM=kyc-pending-index-test');
    }
    const databaseName = databaseNameFromArgs();
    if (!process.env.MONGO_URI || (!hasExplicitDatabaseName(process.env.MONGO_URI) && !databaseName)) {
        throw new Error('Real test requires an explicit database name in MONGO_URI or --database');
    }
    if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
        throw new Error('Refusing to run KYC pending-index test with NODE_ENV=production');
    }

    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
    await mongoose.connect(process.env.MONGO_URI, {
        autoIndex: false,
        autoCreate: false,
        ...(databaseName ? { dbName: databaseName } : {})
    });

    const fixtureUsers = [];
    const newFixtureUser = () => {
        const userId = new mongoose.Types.ObjectId();
        fixtureUsers.push(userId);
        return userId;
    };
    const createKyc = (userId, status, suffix) => Kyc.create({
        userId,
        tier: 1,
        documentType: 'item13_test_fixture',
        documentNumber: `item13-${userId.toString()}-${suffix}`,
        status
    });

    const baselineTotal = await Kyc.countDocuments({});
    try {
        const topologyType = mongoose.connection.getClient().topology.description.type;
        assert.match(topologyType, /ReplicaSet/i);
        const installed = (await Kyc.collection.indexes()).find(index => index.name === TARGET_INDEX.name);
        assert.equal(indexMatches(installed), true);

        await test('first pending succeeds and second sequential pending is rejected', async () => {
            const userId = newFixtureUser();
            await createKyc(userId, 'pending', 'sequential-winner');
            await assert.rejects(
                createKyc(userId, 'pending', 'sequential-loser'),
                error => error?.code === 11000
            );
            assert.equal(await Kyc.countDocuments({ userId, status: 'pending' }), 1);
        });

        await test('approved history does not block a new pending record', async () => {
            const userId = newFixtureUser();
            await createKyc(userId, 'approved', 'approved-history');
            await createKyc(userId, 'pending', 'approved-new-pending');
            assert.equal(await Kyc.countDocuments({ userId }), 2);
        });

        await test('rejected history does not block a new pending record', async () => {
            const userId = newFixtureUser();
            await createKyc(userId, 'rejected', 'rejected-history');
            await createKyc(userId, 'pending', 'rejected-new-pending');
            assert.equal(await Kyc.countDocuments({ userId }), 2);
        });

        await test('multiple approved and rejected historical records remain allowed', async () => {
            const userId = newFixtureUser();
            await Promise.all([
                createKyc(userId, 'approved', 'approved-1'),
                createKyc(userId, 'approved', 'approved-2'),
                createKyc(userId, 'rejected', 'rejected-1'),
                createKyc(userId, 'rejected', 'rejected-2')
            ]);
            assert.equal(await Kyc.countDocuments({ userId, status: { $in: ['approved', 'rejected'] } }), 4);
        });

        await test('ten concurrent pending attempts commit exactly one record', async () => {
            const userId = newFixtureUser();
            const attempts = await Promise.allSettled(
                Array.from({ length: 10 }, (_, index) => createKyc(userId, 'pending', `race-${index}`))
            );
            const successes = attempts.filter(result => result.status === 'fulfilled');
            const losers = attempts.filter(result => result.status === 'rejected');
            assert.equal(successes.length, 1);
            assert.equal(losers.length, 9);
            assert.ok(losers.every(result => result.reason?.code === 11000));
            assert.equal(await Kyc.countDocuments({ userId, status: 'pending' }), 1);
        });
    } finally {
        if (fixtureUsers.length > 0) await Kyc.deleteMany({ userId: { $in: fixtureUsers } });
        const remaining = fixtureUsers.length > 0
            ? await Kyc.countDocuments({ userId: { $in: fixtureUsers } })
            : 0;
        const finalTotal = await Kyc.countDocuments({});
        console.log(JSON.stringify({
            realDatabaseCleanup: {
                fixtureRecordsRemaining: remaining,
                totalRestored: finalTotal === baselineTotal
            }
        }));
        await mongoose.disconnect();
    }
}

async function run() {
    await runUnitTests();
    await runRealDatabaseTests();
    console.log(`\nKYC pending invariant: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
}

run().catch(async error => {
    console.error('[FATAL]', error.message);
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    process.exitCode = 1;
});
