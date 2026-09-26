'use strict';

const assert = require('node:assert');
const Transaction = require('../models/Transaction');
const {
    REQUIRED_INDEXES,
    hasExplicitDatabaseName,
    assertDataSafe,
    assertNoIndexConflicts,
    verifyIndexes,
} = require('../scripts/migrate_transaction_identifier_indexes');

const validReport = () => ({
    transactionId: {
        field: 'transactionId', required: true, missing: 0, nullValues: 0,
        nonString: 0, blank: 0, untrimmed: 0, duplicates: []
    },
    refId: {
        field: 'refId', required: false, missing: 5, nullValues: 2,
        nonString: 0, blank: 0, untrimmed: 0, duplicates: []
    },
    providerRequestId: {
        field: 'providerRequestId', required: false, missing: 20, nullValues: 0,
        nonString: 0, blank: 0, untrimmed: 0, duplicates: []
    },
});

async function main() {
    assert.strictEqual(Transaction.schema.options.autoIndex, false);
    assert.strictEqual(REQUIRED_INDEXES.length, 3);
    assert.deepStrictEqual(REQUIRED_INDEXES[1].options.partialFilterExpression, { refId: { $gte: 'ZNT-R-', $lt: 'ZNT-R.' } });
    assert.deepStrictEqual(REQUIRED_INDEXES[2].options.partialFilterExpression, { providerRequestId: { $type: 'string' } });

    assert.ok(hasExplicitDatabaseName('mongodb://localhost:27017/zantara'));
    assert.ok(!hasExplicitDatabaseName('mongodb://localhost:27017'));
    assert.doesNotThrow(() => assertDataSafe(validReport()));

    const duplicateReport = validReport();
    duplicateReport.refId.enforcedDuplicates = [{ _id: 'ZNT-R-23456789ABCDEFGH', count: 2 }];
    assert.throws(() => assertDataSafe(duplicateReport), /duplicate historical/);

    const grandfatheredTransferReport = validReport();
    grandfatheredTransferReport.refId.duplicates = [{ _id: 'TRF-OLD', count: 2 }];
    grandfatheredTransferReport.refId.enforcedDuplicates = [];
    assert.doesNotThrow(() => assertDataSafe(grandfatheredTransferReport));

    const missingRequired = validReport();
    missingRequired.transactionId.missing = 1;
    assert.throws(() => assertDataSafe(missingRequired), /missing\/null required/);

    const installed = REQUIRED_INDEXES.map(index => ({
        name: index.name,
        key: index.key,
        ...index.options,
    }));
    assert.doesNotThrow(() => assertNoIndexConflicts(installed));
    assert.doesNotThrow(() => verifyIndexes(installed));

    const conflicting = installed.map(index => ({ ...index }));
    conflicting[1] = { name: 'refId_1', key: { refId: 1 }, unique: false };
    assert.throws(() => assertNoIndexConflicts(conflicting), /Conflicting index/);

    const differentlyNamedEquivalent = installed.map(index => ({ ...index }));
    differentlyNamedEquivalent[1] = { ...differentlyNamedEquivalent[1], name: 'legacy_ref_lookup' };
    assert.throws(() => assertNoIndexConflicts(differentlyNamedEquivalent), /Conflicting index/);

    console.log('[PASS] transaction identifier migration is preflight-only and fail-closed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
