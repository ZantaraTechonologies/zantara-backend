const assert = require('assert');
const Notification = require('../models/Notification');

async function runNotificationIndexTests() {
    console.log('====================================================');
    console.log('   NOTIFICATION SCHEMA INDEX DEFINITION TEST SUITE');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`✅ [PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`❌ [FAIL] ${name}`);
            console.error(`   Error: ${err.message}\n`, err.stack);
            failed++;
        }
    }

    const indexes = Notification.schema.indexes();

    const compound = indexes.find(([keys]) =>
        keys.userId === 1 && keys.eventKey === 1 && Object.keys(keys).length === 2
    );

    await test('I1. Notification schema defines exactly one compound { userId: 1, eventKey: 1 } index', () => {
        assert.ok(compound, 'compound (userId, eventKey) index not found in Notification.schema.indexes()');
    });

    const [, opts] = compound || [{}, {}];

    await test('I2. compound index is UNIQUE', () => {
        assert.strictEqual(opts.unique, true, 'expected unique === true');
    });

    await test('I3. partialFilterExpression is exactly { eventKey: { $type: "string" } }', () => {
        assert.deepStrictEqual(
            opts.partialFilterExpression,
            { eventKey: { $type: 'string' } },
            'expected partialFilterExpression { eventKey: { $type: "string" } }'
        );
    });

    await test('I4. sparse is NOT present on the compound index', () => {
        assert.ok(
            !('sparse' in opts) || opts.sparse !== true,
            'sparse must not be true on the (userId, eventKey) index'
        );
    });

    await test('I5. userId field still declares its standalone index (index: true)', () => {
        const userIdIndex = indexes.find(([keys]) =>
            keys.userId === 1 && Object.keys(keys).length === 1
        );
        assert.ok(userIdIndex, 'expected the legacy single-field { userId: 1 } index to remain');
    });

    await test('I6. schema defines exactly one unique index', () => {
        const uniqueIndexes = indexes.filter(([, options]) => options.unique === true);
        assert.strictEqual(uniqueIndexes.length, 1, 'expected exactly one unique index');
        assert.deepStrictEqual(uniqueIndexes[0][0], { userId: 1, eventKey: 1 });
    });

    console.log('\n====================================================');
    console.log(`   RESULT: ${passed} passed, ${failed} failed`);
    console.log('====================================================\n');

    if (failed > 0) {
        process.exitCode = 1;
    }
}

if (require.main === module) {
    runNotificationIndexTests();
}