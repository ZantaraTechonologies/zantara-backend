'use strict';

const assert = require('assert/strict');
const TransactionStatus = require('../models/TransactionStatus');
const WalletLedger = require('../models/WalletLedger');
const {
    REQUIRED_INDEXES,
    assertIndexSafe,
    hasExplicitDatabaseName,
    validateSettlementRecord,
    validateWithdrawalRecord,
    validateShareExitRecord,
    validateUserShareRecord,
    verifyIndexList
} = require('../scripts/migrate_batch3_financial_integrity');

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

function types(overrides = {}) {
    return {
        refId: 'string',
        userId: 'objectId',
        type: 'string',
        amountKobo: 'double',
        confirmedAmountKobo: 'double',
        provider: 'string',
        confirmedProvider: 'string',
        confirmedReference: 'string',
        expectedCurrency: 'string',
        confirmedCurrency: 'string',
        confirmedProviderRef: 'string',
        settlementClaimToken: 'string',
        settlementLeaseExpiresAt: 'date',
        ...overrides
    };
}

function validSettlement(overrides = {}) {
    return {
        _id: 'settlement-1',
        refId: 'LOCAL-REF-1',
        userId: '507f1f77bcf86cd799439011',
        type: 'funding',
        status: 'processing',
        amountKobo: 500000,
        confirmedAmountKobo: 500000,
        provider: 'paystack',
        confirmedProvider: 'paystack',
        confirmedReference: 'LOCAL-REF-1',
        expectedCurrency: 'NGN',
        confirmedCurrency: 'NGN',
        confirmedProviderRef: '123456789',
        settlementClaimToken: 'claim-token',
        settlementLeaseExpiresAt: new Date(Date.now() + 60000),
        _types: types(),
        ...overrides
    };
}

function validWithdrawal(overrides = {}) {
    return {
        amount: 200,
        feePercent: 1.5,
        feeCharged: 3,
        netAmount: 197,
        source: 'dividend',
        reservationVersion: 1,
        reservedAmountKobo: 20000,
        reservedSource: 'dividend',
        _types: {
            amount: 'double', feePercent: 'double', feeCharged: 'double', netAmount: 'double',
            source: 'string', reservationVersion: 'double', reservedAmountKobo: 'double', reservedSource: 'string'
        },
        ...overrides
    };
}

function validExit(overrides = {}) {
    return {
        sharesRequested: 2,
        sharePrice: 10000,
        grossAmount: 20000,
        exitFeePercent: 5,
        exitFeeCharged: 1000,
        netAmount: 19000,
        reservationVersion: 1,
        reservedShares: 2,
        _types: {
            sharesRequested: 'double', sharePrice: 'double', grossAmount: 'double',
            exitFeePercent: 'double', exitFeeCharged: 'double', netAmount: 'double',
            reservationVersion: 'double', reservedShares: 'double'
        },
        ...overrides
    };
}

async function run() {
    await test('complete TransactionStatus and WalletLedger index sets are migration-controlled', () => {
        assert.deepEqual(REQUIRED_INDEXES.transactionStatuses.map(item => item.name), [
            'refId_1',
            'userId_1',
            'status_1',
            'createdAt_-1',
            'status_1_settlementLeaseExpiresAt_1',
            'confirmedProvider_1_confirmedProviderRef_1_unique_partial'
        ]);
        assert.deepEqual(REQUIRED_INDEXES.walletLedgers.map(item => item.name), [
            'walletId_1',
            'userId_1',
            'reference_1',
            'settlementKey_1_unique_partial'
        ]);
        assert.equal(REQUIRED_INDEXES.transactionStatuses[0].options.unique, true);
        assert.equal(REQUIRED_INDEXES.walletLedgers[3].options.unique, true);
    });

    await test('schemas disable unsafe startup builds while declaring every migrated index', () => {
        assert.equal(TransactionStatus.schema.options.autoIndex, false);
        assert.equal(WalletLedger.schema.options.autoIndex, false);
        for (const expected of REQUIRED_INDEXES.transactionStatuses) {
            const declared = TransactionStatus.schema.indexes().find(([key]) =>
                JSON.stringify(key) === JSON.stringify(expected.key)
            );
            assert.ok(declared, `TransactionStatus schema is missing ${expected.name}`);
            assert.equal(!!declared[1].unique, !!expected.options.unique, `${expected.name} uniqueness drifted`);
        }
        for (const expected of REQUIRED_INDEXES.walletLedgers) {
            const declared = WalletLedger.schema.indexes().find(([key]) =>
                JSON.stringify(key) === JSON.stringify(expected.key)
            );
            assert.ok(declared, `WalletLedger schema is missing ${expected.name}`);
            assert.equal(!!declared[1].unique, !!expected.options.unique, `${expected.name} uniqueness drifted`);
        }
    });

    await test('provider duplicate and baseline duplicate reports block apply', () => {
        const clean = {
            duplicateTransactionReferences: { count: 0, samples: [] },
            duplicateSettlementKeys: { count: 0, samples: [] },
            duplicateProviderTransactionIdentities: { count: 0, samples: [] },
            malformedProviderTransactionIdentities: { count: 0, samples: [] },
            malformedUserShareBalances: { count: 0, samples: [] }
        };
        assert.doesNotThrow(() => assertIndexSafe(clean));
        assert.throws(() => assertIndexSafe({
            ...clean,
            duplicateProviderTransactionIdentities: { count: 1, samples: [{ provider: 'paystack', providerTransactionId: '7' }] }
        }), /provider transaction/i);
        assert.throws(() => assertIndexSafe({
            ...clean,
            duplicateTransactionReferences: { count: 1, samples: [{ refId: 'DUPLICATE' }] }
        }), /transaction reference/i);
    });

    await test('settlement validation matches persisted runtime evidence requirements', () => {
        assert.deepEqual(validateSettlementRecord(validSettlement()), []);
        assert.match(validateSettlementRecord(validSettlement({ confirmedProviderRef: '' })).join(' '), /provider transaction/i);
        assert.match(validateSettlementRecord(validSettlement({ confirmedAmountKobo: 499999 })).join(' '), /amount/i);
        assert.match(validateSettlementRecord(validSettlement({
            confirmedProvider: 'Paystack',
            _types: types()
        })).join(' '), /provider/i);
        assert.match(validateSettlementRecord(validSettlement({
            settlementLeaseExpiresAt: 'tomorrow',
            _types: types({ settlementLeaseExpiresAt: 'string' })
        })).join(' '), /lease/i);
    });

    await test('present but malformed withdrawal reservation proof is rejected', () => {
        assert.deepEqual(validateWithdrawalRecord(validWithdrawal()), []);
        assert.match(validateWithdrawalRecord(validWithdrawal({ reservedAmountKobo: 19999 })).join(' '), /reservation/i);
        assert.match(validateWithdrawalRecord(validWithdrawal({ reservedSource: 'referral' })).join(' '), /reservation/i);
        assert.match(validateWithdrawalRecord(validWithdrawal({
            reservedAmountKobo: '20000',
            _types: { ...validWithdrawal()._types, reservedAmountKobo: 'string' }
        })).join(' '), /reservation/i);
    });

    await test('present but malformed share-exit reservation proof is rejected', () => {
        assert.deepEqual(validateShareExitRecord(validExit()), []);
        assert.match(validateShareExitRecord(validExit({ reservedShares: 1 })).join(' '), /reservation/i);
        assert.match(validateShareExitRecord(validExit({ grossAmount: 19999 })).join(' '), /gross/i);
    });

    await test('share balances reject malformed frozenShares and BSON numeric types with inconsistent runtime behavior', () => {
        assert.deepEqual(validateUserShareRecord({
            sharesOwned: 2,
            frozenShares: 1,
            isShareholder: true,
            _types: { sharesOwned: 'double', frozenShares: 'double', isShareholder: 'bool' }
        }), []);
        assert.match(validateUserShareRecord({
            sharesOwned: 2,
            frozenShares: -1,
            isShareholder: true,
            _types: { sharesOwned: 'double', frozenShares: 'double', isShareholder: 'bool' }
        }).join(' '), /frozenShares/);
        assert.match(validateUserShareRecord({
            sharesOwned: 2,
            frozenShares: 0,
            isShareholder: true,
            _types: { sharesOwned: 'decimal', frozenShares: 'double', isShareholder: 'bool' }
        }).join(' '), /sharesOwned/);
        assert.match(validateUserShareRecord({
            frozenShares: 1,
            isShareholder: false,
            _types: { sharesOwned: 'missing', frozenShares: 'double', isShareholder: 'bool' }
        }).join(' '), /frozenShares/);
    });

    await test('migration requires an explicit database name', () => {
        assert.equal(hasExplicitDatabaseName('mongodb://localhost:27017/zantara'), true);
        assert.equal(hasExplicitDatabaseName('mongodb+srv://user:pass@example.test/zantara?retryWrites=true'), true);
        assert.equal(hasExplicitDatabaseName('mongodb://localhost:27017'), false);
        assert.equal(hasExplicitDatabaseName('mongodb+srv://user:pass@example.test/?retryWrites=true'), false);
    });

    await test('postcondition verification rejects missing or conflicting index specifications', () => {
        const expected = [{ name: 'refId_1', key: { refId: 1 }, options: { unique: true } }];
        assert.doesNotThrow(() => verifyIndexList([
            { name: '_id_', key: { _id: 1 }, unique: true },
            { name: 'refId_1', key: { refId: 1 }, unique: true }
        ], expected, 'transactionstatuses'));
        assert.throws(() => verifyIndexList([
            { name: 'refId_1', key: { refId: 1 } }
        ], expected, 'transactionstatuses'), /conflict/i);
        assert.throws(() => verifyIndexList([], expected, 'transactionstatuses'), /missing/i);
    });

    console.log(`\nBatch 3 migration safety: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
}

run().catch(error => {
    console.error('[FATAL]', error);
    process.exitCode = 1;
});
