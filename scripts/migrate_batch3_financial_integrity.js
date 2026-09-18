'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { isDeepStrictEqual } = require('util');

const APPLY_CONFIRMATION = 'batch3-financial-integrity';
const SUPPORTED_PROVIDERS = new Set(['paystack', 'monnify', 'flutterwave']);
const RUNTIME_NUMBER_TYPES = new Set(['double', 'int']);
const SAMPLE_LIMIT = 50;

const REQUIRED_INDEXES = {
    transactionStatuses: [
        { name: 'refId_1', key: { refId: 1 }, options: { unique: true } },
        { name: 'userId_1', key: { userId: 1 }, options: {} },
        { name: 'status_1', key: { status: 1 }, options: {} },
        { name: 'createdAt_-1', key: { createdAt: -1 }, options: {} },
        { name: 'status_1_settlementLeaseExpiresAt_1', key: { status: 1, settlementLeaseExpiresAt: 1 }, options: {} },
        {
            name: 'confirmedProvider_1_confirmedProviderRef_1_unique_partial',
            key: { confirmedProvider: 1, confirmedProviderRef: 1 },
            options: {
                unique: true,
                partialFilterExpression: {
                    confirmedProvider: { $type: 'string' },
                    confirmedProviderRef: { $type: 'string' }
                }
            }
        }
    ],
    walletLedgers: [
        { name: 'walletId_1', key: { walletId: 1 }, options: {} },
        { name: 'userId_1', key: { userId: 1 }, options: {} },
        { name: 'reference_1', key: { reference: 1 }, options: {} },
        {
            name: 'settlementKey_1_unique_partial',
            key: { settlementKey: 1 },
            options: {
                unique: true,
                partialFilterExpression: { settlementKey: { $type: 'string' } }
            }
        }
    ]
};

const SETTLEMENT_FIELDS = [
    'refId', 'userId', 'type', 'status', 'amountKobo', 'confirmedAmountKobo',
    'provider', 'confirmedProvider', 'confirmedReference', 'expectedCurrency',
    'confirmedCurrency', 'confirmedProviderRef', 'settlementClaimToken',
    'settlementLeaseExpiresAt', 'sharePrice'
];
const WITHDRAWAL_FIELDS = [
    'amount', 'feePercent', 'feeCharged', 'netAmount', 'source',
    'reservationVersion', 'reservedAmountKobo', 'reservedSource'
];
const SHARE_EXIT_FIELDS = [
    'sharesRequested', 'sharePrice', 'grossAmount', 'exitFeePercent',
    'exitFeeCharged', 'netAmount', 'reservationVersion', 'reservedShares'
];
const USER_SHARE_FIELDS = ['sharesOwned', 'frozenShares', 'isShareholder'];

function hasExplicitDatabaseName(uri) {
    if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//i.test(uri)) return false;
    const withoutQuery = uri.split('?')[0];
    const authorityStart = withoutQuery.indexOf('://') + 3;
    const pathStart = withoutQuery.indexOf('/', authorityStart);
    if (pathStart < 0) return false;
    const databaseName = withoutQuery.slice(pathStart + 1).split('/')[0];
    return databaseName.trim().length > 0;
}

function exactKey(actual = {}, expected = {}) {
    return isDeepStrictEqual(Object.entries(actual), Object.entries(expected));
}

function indexMatches(actual, expected) {
    if (!actual || !exactKey(actual.key, expected.key)) return false;
    const options = expected.options || {};
    if (!!actual.unique !== !!options.unique) return false;
    if (!!actual.sparse !== !!options.sparse) return false;
    return isDeepStrictEqual(
        actual.partialFilterExpression || null,
        options.partialFilterExpression || null
    );
}

function assertNoIndexConflicts(actualIndexes, expectedIndexes, collectionName) {
    for (const expected of expectedIndexes) {
        const sameName = actualIndexes.find(index => index.name === expected.name);
        if (sameName && !indexMatches(sameName, expected)) {
            throw new Error(`Index conflict on ${collectionName}.${expected.name}: existing specification does not match the required specification`);
        }
        const sameKey = actualIndexes.find(index => exactKey(index.key, expected.key));
        if (sameKey && sameKey.name !== expected.name) {
            throw new Error(`Index conflict on ${collectionName}: required key ${JSON.stringify(expected.key)} already exists as '${sameKey.name}', expected '${expected.name}'`);
        }
    }
}

function verifyIndexList(actualIndexes, expectedIndexes, collectionName) {
    for (const expected of expectedIndexes) {
        const actual = actualIndexes.find(index => index.name === expected.name);
        if (!actual) throw new Error(`Required index missing on ${collectionName}: ${expected.name}`);
        if (!indexMatches(actual, expected)) {
            throw new Error(`Required index conflict on ${collectionName}.${expected.name}`);
        }
    }
    return true;
}

async function readIndexes(collection) {
    try {
        return await collection.indexes();
    } catch (error) {
        if (error && (error.code === 26 || error.codeName === 'NamespaceNotFound')) return [];
        throw error;
    }
}

async function ensureRequiredIndexes(collection, expectedIndexes, collectionName) {
    const before = await readIndexes(collection);
    assertNoIndexConflicts(before, expectedIndexes, collectionName);
    const created = [];
    for (const expected of expectedIndexes) {
        if (before.some(index => index.name === expected.name)) continue;
        await collection.createIndex(expected.key, { ...expected.options, name: expected.name });
        created.push(expected.name);
    }
    const after = await readIndexes(collection);
    verifyIndexList(after, expectedIndexes, collectionName);
    return { created, indexes: after };
}

function projectionFor(fields) {
    const projection = { _id: 1 };
    const types = {};
    for (const field of fields) {
        projection[field] = 1;
        types[field] = { $type: `$${field}` };
    }
    projection._types = types;
    return projection;
}

function isRuntimeNumber(record, field) {
    return RUNTIME_NUMBER_TYPES.has(record._types?.[field]) && typeof record[field] === 'number' && Number.isFinite(record[field]);
}

function safeInteger(record, field, { allowZero = false } = {}) {
    return isRuntimeNumber(record, field)
        && Number.isSafeInteger(record[field])
        && (allowZero ? record[field] >= 0 : record[field] > 0);
}

function moneyKobo(record, field, { allowZero = false } = {}) {
    if (!isRuntimeNumber(record, field)) return null;
    const rawKobo = record[field] * 100;
    const kobo = Math.round(rawKobo);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(rawKobo)) * 4;
    if (!Number.isSafeInteger(kobo) || Math.abs(rawKobo - kobo) > tolerance) return null;
    if (allowZero ? kobo < 0 : kobo <= 0) return null;
    return kobo;
}

function validCanonicalString(record, field) {
    return record._types?.[field] === 'string'
        && typeof record[field] === 'string'
        && record[field].length > 0
        && record[field] === record[field].trim();
}

function validateTransactionReference(record) {
    return validCanonicalString(record, 'refId') ? [] : ['refId must be a non-empty canonical string'];
}

function validateProviderIdentityRecord(record) {
    const providerType = record._types?.confirmedProvider;
    const providerRefType = record._types?.confirmedProviderRef;
    if (providerType === 'missing' && providerRefType === 'missing') return [];

    const issues = [];
    if (!validCanonicalString(record, 'confirmedProvider') ||
        record.confirmedProvider !== record.confirmedProvider.toLowerCase() ||
        !SUPPORTED_PROVIDERS.has(record.confirmedProvider)) {
        issues.push('confirmed provider identity is missing, malformed, or unsupported');
    }
    if (!validCanonicalString(record, 'confirmedProviderRef')) {
        issues.push('confirmed provider transaction identity is missing or malformed');
    }
    return issues;
}

function validateSettlementRecord(record) {
    const issues = [];
    if (!validCanonicalString(record, 'refId')) issues.push('settlement reference is missing or malformed');
    if (record._types?.userId !== 'objectId') issues.push('settlement owner is missing or malformed');
    if (record._types?.type !== 'string' || !['funding', 'investment_buy'].includes(record.type)) {
        issues.push('settlement type is unsupported');
    }
    if (!safeInteger(record, 'amountKobo')) issues.push('expected amount is not positive safe-integer kobo');
    if (!safeInteger(record, 'confirmedAmountKobo')) issues.push('confirmed amount is not positive safe-integer kobo');
    if (safeInteger(record, 'amountKobo') && safeInteger(record, 'confirmedAmountKobo') && record.amountKobo !== record.confirmedAmountKobo) {
        issues.push('settlement amount evidence does not reconcile');
    }
    if (!validCanonicalString(record, 'provider') || record.provider !== record.provider.toLowerCase() || !SUPPORTED_PROVIDERS.has(record.provider)) {
        issues.push('initialized provider is missing, malformed, or unsupported');
    }
    if (!validCanonicalString(record, 'confirmedProvider') || record.confirmedProvider !== record.confirmedProvider.toLowerCase() || !SUPPORTED_PROVIDERS.has(record.confirmedProvider)) {
        issues.push('confirmed provider is missing, malformed, or unsupported');
    }
    if (validCanonicalString(record, 'provider') && validCanonicalString(record, 'confirmedProvider') && record.provider !== record.confirmedProvider) {
        issues.push('settlement provider evidence does not reconcile');
    }
    if (!validCanonicalString(record, 'confirmedReference') || record.confirmedReference !== record.refId) {
        issues.push('settlement reference evidence does not reconcile');
    }
    if (!validCanonicalString(record, 'expectedCurrency') || record.expectedCurrency !== 'NGN') {
        issues.push('expected settlement currency is missing or unsupported');
    }
    if (!validCanonicalString(record, 'confirmedCurrency') || record.confirmedCurrency !== record.expectedCurrency) {
        issues.push('confirmed settlement currency does not reconcile');
    }
    if (!validCanonicalString(record, 'confirmedProviderRef')) issues.push('provider transaction identifier is missing or malformed');
    if (!validCanonicalString(record, 'settlementClaimToken')) issues.push('settlement claim token is missing or malformed');
    if (record._types?.settlementLeaseExpiresAt !== 'date' || !(record.settlementLeaseExpiresAt instanceof Date) || !Number.isFinite(record.settlementLeaseExpiresAt.getTime())) {
        issues.push('settlement lease is missing or malformed');
    }
    if (record.type === 'investment_buy') {
        const sharePriceKobo = moneyKobo(record, 'sharePrice');
        if (sharePriceKobo == null) issues.push('investment settlement share price is malformed');
        else if (safeInteger(record, 'confirmedAmountKobo') && record.confirmedAmountKobo % sharePriceKobo !== 0) {
            issues.push('investment settlement amount is not a whole share multiple');
        }
    }
    return issues;
}

function validatePercentage(record, field) {
    const kobo = moneyKobo(record, field, { allowZero: true });
    return kobo != null && kobo < 10000;
}

function validateWithdrawalRecord(record) {
    const issues = [];
    const amountKobo = moneyKobo(record, 'amount');
    const feeKobo = moneyKobo(record, 'feeCharged', { allowZero: true });
    const netKobo = moneyKobo(record, 'netAmount');
    if (amountKobo == null) issues.push('withdrawal amount is malformed');
    if (feeKobo == null) issues.push('withdrawal fee is malformed');
    if (netKobo == null) issues.push('withdrawal net amount is malformed');
    if (!validatePercentage(record, 'feePercent')) issues.push('withdrawal fee percent is malformed');
    if (amountKobo != null && feeKobo != null && netKobo != null && amountKobo !== feeKobo + netKobo) {
        issues.push('withdrawal monetary fields do not reconcile');
    }
    if (record._types?.source !== 'string' || !['dividend', 'referral'].includes(record.source)) {
        issues.push('withdrawal source is malformed');
    }
    if (!safeInteger(record, 'reservationVersion') || record.reservationVersion !== 1 ||
        !safeInteger(record, 'reservedAmountKobo') || record.reservedAmountKobo !== amountKobo ||
        record._types?.reservedSource !== 'string' || record.reservedSource !== record.source) {
        issues.push('withdrawal reservation proof is missing or invalid');
    }
    return issues;
}

function validateShareExitRecord(record) {
    const issues = [];
    const shares = safeInteger(record, 'sharesRequested') ? record.sharesRequested : null;
    const sharePriceKobo = moneyKobo(record, 'sharePrice');
    const grossKobo = moneyKobo(record, 'grossAmount');
    const feeKobo = moneyKobo(record, 'exitFeeCharged', { allowZero: true });
    const netKobo = moneyKobo(record, 'netAmount');
    if (shares == null) issues.push('share exit quantity is malformed');
    if (sharePriceKobo == null) issues.push('share exit price is malformed');
    if (grossKobo == null) issues.push('share exit gross amount is malformed');
    if (feeKobo == null) issues.push('share exit fee is malformed');
    if (netKobo == null) issues.push('share exit net amount is malformed');
    if (!validatePercentage(record, 'exitFeePercent')) issues.push('share exit fee percent is malformed');
    if (shares != null && sharePriceKobo != null && grossKobo != null &&
        (!Number.isSafeInteger(shares * sharePriceKobo) || grossKobo !== shares * sharePriceKobo)) {
        issues.push('share exit gross amount does not reconcile');
    }
    if (grossKobo != null && feeKobo != null && netKobo != null && grossKobo !== feeKobo + netKobo) {
        issues.push('share exit monetary fields do not reconcile');
    }
    if (!safeInteger(record, 'reservationVersion') || record.reservationVersion !== 1 ||
        !safeInteger(record, 'reservedShares') || record.reservedShares !== shares) {
        issues.push('share exit reservation proof is missing or invalid');
    }
    return issues;
}

function validateUserShareRecord(record) {
    const issues = [];
    const sharesMissing = record._types?.sharesOwned === 'missing';
    if (sharesMissing) {
        if (record.isShareholder === true) issues.push('sharesOwned is missing for a shareholder');
    } else if (!safeInteger(record, 'sharesOwned', { allowZero: true })) {
        issues.push('sharesOwned has a BSON type or value rejected by the runtime validator');
    }

    const frozenMissing = record._types?.frozenShares === 'missing';
    if (!frozenMissing && !safeInteger(record, 'frozenShares', { allowZero: true })) {
        issues.push('frozenShares has a BSON type or value rejected by the runtime validator');
    }
    if (sharesMissing && !frozenMissing &&
        safeInteger(record, 'frozenShares', { allowZero: true }) && record.frozenShares > 0) {
        issues.push('frozenShares is positive while sharesOwned is missing');
    }
    if (!sharesMissing && !frozenMissing &&
        safeInteger(record, 'sharesOwned', { allowZero: true }) &&
        safeInteger(record, 'frozenShares', { allowZero: true }) &&
        record.frozenShares > record.sharesOwned) {
        issues.push('frozenShares exceeds sharesOwned');
    }
    return issues;
}

async function scanInvalid(collection, match, fields, validator) {
    const cursor = collection.aggregate([
        { $match: match },
        { $project: projectionFor(fields) }
    ], { allowDiskUse: true });
    let count = 0;
    const samples = [];
    for await (const record of cursor) {
        const issues = validator(record);
        if (issues.length === 0) continue;
        count++;
        if (samples.length < SAMPLE_LIMIT) samples.push({ _id: record._id, refId: record.refId, issues });
    }
    return { count, samples };
}

async function duplicateGroups(collection, match, groupId) {
    const result = await collection.aggregate([
        { $match: match },
        { $group: { _id: groupId, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        {
            $facet: {
                summary: [{ $count: 'count' }],
                samples: [{ $sort: { count: -1 } }, { $limit: SAMPLE_LIMIT }]
            }
        }
    ], { allowDiskUse: true }).toArray();
    return {
        count: result[0]?.summary[0]?.count || 0,
        samples: result[0]?.samples || []
    };
}

async function inspect(collections) {
    const [
        duplicateTransactionReferences,
        malformedTransactionReferences,
        duplicateSettlementKeys,
        duplicateProviderTransactionIdentities,
        malformedProviderTransactionIdentities,
        incompatibleSettlementRecords,
        malformedPendingInvestmentWithdrawals,
        malformedPendingShareExitRequests,
        malformedUserShareBalances,
        globalShareLock
    ] = await Promise.all([
        duplicateGroups(collections.transactionStatuses, {}, '$refId'),
        scanInvalid(collections.transactionStatuses, {}, ['refId'], validateTransactionReference),
        duplicateGroups(collections.walletLedgers, { settlementKey: { $type: 'string' } }, '$settlementKey'),
        duplicateGroups(
            collections.transactionStatuses,
            { confirmedProvider: { $type: 'string' }, confirmedProviderRef: { $type: 'string' } },
            { provider: '$confirmedProvider', providerTransactionId: '$confirmedProviderRef' }
        ),
        scanInvalid(
            collections.transactionStatuses,
            { $or: [{ confirmedProvider: { $exists: true } }, { confirmedProviderRef: { $exists: true } }] },
            ['confirmedProvider', 'confirmedProviderRef'],
            validateProviderIdentityRecord
        ),
        scanInvalid(
            collections.transactionStatuses,
            { status: { $in: ['processing', 'settlement_pending'] } },
            SETTLEMENT_FIELDS,
            validateSettlementRecord
        ),
        scanInvalid(collections.investmentWithdrawals, { status: 'pending' }, WITHDRAWAL_FIELDS, validateWithdrawalRecord),
        scanInvalid(collections.shareExitRequests, { status: 'pending' }, SHARE_EXIT_FIELDS, validateShareExitRecord),
        scanInvalid(collections.users, {}, USER_SHARE_FIELDS, validateUserShareRecord),
        collections.shareIssuanceLocks.findOne({ _id: 'global' })
    ]);

    const invalidGlobalShareLock = globalShareLock &&
        (!Number.isSafeInteger(globalShareLock.revision) || globalShareLock.revision < 0)
        ? { count: 1, samples: [{ _id: 'global', issue: 'revision must be a non-negative safe integer' }] }
        : { count: 0, samples: [] };

    return {
        duplicateTransactionReferences,
        malformedTransactionReferences,
        duplicateSettlementKeys,
        duplicateProviderTransactionIdentities,
        malformedProviderTransactionIdentities,
        incompatibleSettlementRecords,
        malformedPendingInvestmentWithdrawals,
        malformedPendingShareExitRequests,
        malformedUserShareBalances,
        invalidGlobalShareLock
    };
}

function findingCount(finding) {
    if (Array.isArray(finding)) return finding.length;
    return Number(finding?.count || 0);
}

function assertIndexSafe(report) {
    const blockers = [
        ['duplicate transaction reference', report.duplicateTransactionReferences],
        ['malformed transaction reference', report.malformedTransactionReferences],
        ['duplicate settlement key', report.duplicateSettlementKeys],
        ['duplicate provider transaction identity', report.duplicateProviderTransactionIdentities],
        ['malformed provider transaction identity', report.malformedProviderTransactionIdentities],
        ['malformed user share balance', report.malformedUserShareBalances],
        ['malformed global share lock', report.invalidGlobalShareLock]
    ];
    for (const [label, finding] of blockers) {
        const count = findingCount(finding);
        if (count > 0) throw new Error(`Cannot apply Batch 3 migration: ${count} ${label} finding(s) require manual reconciliation`);
    }
}

function assertQuarantineComplete(report) {
    const remaining = [
        ['settlement', report.incompatibleSettlementRecords],
        ['investment withdrawal', report.malformedPendingInvestmentWithdrawals],
        ['share exit', report.malformedPendingShareExitRequests]
    ];
    for (const [label, finding] of remaining) {
        const count = findingCount(finding);
        if (count > 0) throw new Error(`Post-migration verification failed: ${count} incompatible active ${label} record(s) remain`);
    }
}

async function quarantineInvalid(collection, match, fields, validator, update) {
    const cursor = collection.aggregate([
        { $match: match },
        { $project: projectionFor(fields) }
    ], { allowDiskUse: true });
    let modifiedCount = 0;
    let operations = [];
    const flush = async () => {
        if (operations.length === 0) return;
        const result = await collection.bulkWrite(operations, { ordered: true });
        modifiedCount += result.modifiedCount;
        operations = [];
    };
    for await (const record of cursor) {
        if (validator(record).length === 0) continue;
        operations.push({
            updateOne: {
                filter: { _id: record._id, ...match },
                update
            }
        });
        if (operations.length >= 500) await flush();
    }
    await flush();
    return modifiedCount;
}

async function quarantineHistoricalRecords(collections) {
    const quarantineNote = 'Batch 3 migration: reservation proof is malformed or unavailable; manual reconciliation required.';
    const legacySettlementsQuarantined = await quarantineInvalid(
        collections.transactionStatuses,
        { status: { $in: ['processing', 'settlement_pending'] } },
        SETTLEMENT_FIELDS,
        validateSettlementRecord,
        {
            $set: {
                status: 'reconciliation_required',
                reconciliationReason: 'Batch 3 migration: settlement evidence or lease ownership proof is incompatible with runtime validation.'
            },
            $unset: { settlementClaimToken: 1, settlementLeaseExpiresAt: 1 }
        }
    );
    const withdrawalsQuarantined = await quarantineInvalid(
        collections.investmentWithdrawals,
        { status: 'pending' },
        WITHDRAWAL_FIELDS,
        validateWithdrawalRecord,
        { $set: { status: 'manual_review', adminNote: quarantineNote } }
    );
    const shareExitsQuarantined = await quarantineInvalid(
        collections.shareExitRequests,
        { status: 'pending' },
        SHARE_EXIT_FIELDS,
        validateShareExitRecord,
        { $set: { status: 'manual_review', adminNote: quarantineNote } }
    );
    return { legacySettlementsQuarantined, withdrawalsQuarantined, shareExitsQuarantined };
}

async function indexStatus(collection, expected, collectionName) {
    const actual = await readIndexes(collection);
    assertNoIndexConflicts(actual, expected, collectionName);
    return {
        required: expected.map(index => index.name),
        present: expected.filter(item => actual.some(index => index.name === item.name && indexMatches(index, item))).map(item => item.name),
        missing: expected.filter(item => !actual.some(index => index.name === item.name)).map(item => item.name)
    };
}

async function run() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) throw new Error('MONGO_URI is required');
    if (!hasExplicitDatabaseName(mongoUri)) {
        throw new Error('MONGO_URI must explicitly include the approved target database name');
    }
    const apply = process.argv.includes('--apply');
    if (apply && process.env.BATCH3_FINANCIAL_MIGRATION_CONFIRM !== APPLY_CONFIRMATION) {
        throw new Error(`Refusing --apply without BATCH3_FINANCIAL_MIGRATION_CONFIRM=${APPLY_CONFIRMATION}`);
    }

    await mongoose.connect(mongoUri, { autoIndex: false });
    try {
        const collections = {
            transactionStatuses: mongoose.connection.collection('transactionstatuses'),
            walletLedgers: mongoose.connection.collection('walletledgers'),
            investmentWithdrawals: mongoose.connection.collection('investmentwithdrawals'),
            shareExitRequests: mongoose.connection.collection('shareexitrequests'),
            shareIssuanceLocks: mongoose.connection.collection('shareissuancelocks'),
            users: mongoose.connection.collection('users')
        };
        const [report, transactionStatusIndexes, walletLedgerIndexes] = await Promise.all([
            inspect(collections),
            indexStatus(collections.transactionStatuses, REQUIRED_INDEXES.transactionStatuses, 'transactionstatuses'),
            indexStatus(collections.walletLedgers, REQUIRED_INDEXES.walletLedgers, 'walletledgers')
        ]);
        console.log(JSON.stringify({
            mode: apply ? 'apply' : 'validation-only',
            targetDatabase: mongoose.connection.name,
            indexes: { transactionStatuses: transactionStatusIndexes, walletLedgers: walletLedgerIndexes },
            ...report
        }, null, 2));
        assertIndexSafe(report);

        if (!apply) {
            console.log('Validation complete. No data or indexes changed. Quarantine candidates shown above require apply mode or manual reconciliation.');
            return;
        }

        const transactionStatusIndexResult = await ensureRequiredIndexes(
            collections.transactionStatuses,
            REQUIRED_INDEXES.transactionStatuses,
            'transactionstatuses'
        );
        const walletLedgerIndexResult = await ensureRequiredIndexes(
            collections.walletLedgers,
            REQUIRED_INDEXES.walletLedgers,
            'walletledgers'
        );
        await collections.shareIssuanceLocks.updateOne(
            { _id: 'global' },
            { $setOnInsert: { revision: 0 } },
            { upsert: true }
        );
        const quarantineResult = await quarantineHistoricalRecords(collections);

        const [postReport, finalTransactionStatusIndexes, finalWalletLedgerIndexes, globalShareLock] = await Promise.all([
            inspect(collections),
            readIndexes(collections.transactionStatuses),
            readIndexes(collections.walletLedgers),
            collections.shareIssuanceLocks.findOne({ _id: 'global' })
        ]);
        assertIndexSafe(postReport);
        assertQuarantineComplete(postReport);
        verifyIndexList(finalTransactionStatusIndexes, REQUIRED_INDEXES.transactionStatuses, 'transactionstatuses');
        verifyIndexList(finalWalletLedgerIndexes, REQUIRED_INDEXES.walletLedgers, 'walletledgers');
        if (!globalShareLock || !Number.isSafeInteger(globalShareLock.revision) || globalShareLock.revision < 0) {
            throw new Error('Post-migration verification failed: global share issuance lock is missing or malformed');
        }

        console.log(JSON.stringify({
            verified: true,
            indexesCreated: {
                transactionStatuses: transactionStatusIndexResult.created,
                walletLedgers: walletLedgerIndexResult.created
            },
            shareIssuanceLock: { _id: 'global', revision: globalShareLock.revision },
            ...quarantineResult,
            postconditions: postReport
        }, null, 2));
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    run().catch(error => {
        console.error(`[Batch 3 Financial Migration] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    REQUIRED_INDEXES,
    assertIndexSafe,
    assertNoIndexConflicts,
    hasExplicitDatabaseName,
    indexMatches,
    inspect,
    validateSettlementRecord,
    validateWithdrawalRecord,
    validateShareExitRecord,
    validateUserShareRecord,
    verifyIndexList
};
