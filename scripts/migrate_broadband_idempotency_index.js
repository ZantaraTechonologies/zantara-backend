'use strict';

const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { isDeepStrictEqual } = require('node:util');
const { decryptSecretStrict, isEncrypted } = require('../utils/crypto');
const { decodeBroadbandRecoveryPayload } = require('../utils/broadbandRecoveryPayload');
const { PROVIDER_OPERATIONS, supportsProviderOperation } = require('../adapters/providerAdapterRegistry');
const { isSafeAuthTemplate } = require('../utils/providerSerializer');

const COLLECTION_NAME = 'transactions';
const INDEX_NAME = 'userId_1_idempotencyKey_1_unique_partial';
const APPLY_CONFIRMATION = 'broadband-purchase-idempotency';
const INDEX_KEY = { userId: 1, idempotencyKey: 1 };
const INDEX_OPTIONS = {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } }
};
const PROVIDER_REQUEST_ID = /^ZNT-P-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/;
const RECOVERY_MATCH = Object.freeze({
    type: 'broadband',
    idempotencyKey: { $type: 'string' },
    status: 'pending'
});
const RECOVERY_PROJECTION = Object.freeze({
    _id: 1,
    transactionId: 1,
    userId: 1,
    amount: 1,
    dispatchState: 1,
    providerOutcome: 1,
    provider: 1,
    providerId: 1,
    providerAdapterType: 1,
    providerRequestId: 1,
    providerOfferId: 1,
    providerConfigSnapshot: 1,
    providerCredentialSnapshot: 1,
    pricingSnapshot: 1,
    recoveryPayload: 1
});
const REFERENCE_COLLECTIONS = Object.freeze({
    providers: 'providers',
    offers: 'provideroffers',
    services: 'services',
    identities: 'serviceidentities'
});

const nonBlankString = value => typeof value === 'string' && value.trim().length > 0;
const SAFE_TRANSACTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

function sanitizeDuplicateDiagnostics(groups) {
    return (Array.isArray(groups) ? groups : []).map(group => ({
        count: Number.isSafeInteger(group?.count) && group.count > 0 ? group.count : 0,
        transactionIds: (Array.isArray(group?.transactionIds) ? group.transactionIds : [])
            .filter(value => typeof value === 'string' && SAFE_TRANSACTION_ID.test(value))
            .slice(0, 50)
    }));
}

function isStoredObjectId(value) {
    if (!value || value._bsontype !== 'ObjectId' || typeof value.toHexString !== 'function') return false;
    try {
        return /^[a-f0-9]{24}$/.test(value.toHexString());
    } catch (_) {
        return false;
    }
}

function safeDocumentId(record) {
    return isStoredObjectId(record?._id) ? record._id.toHexString() : null;
}

function emptyRecoveryReport() {
    const issue = () => ({ count: 0, ids: [] });
    return {
        scanned: 0,
        unsafe: 0,
        issues: {
            encryption: issue(),
            schema: issue(),
            objectId: issue(),
            reference: issue(),
            providerConfiguration: issue(),
            pricing: issue(),
            state: issue()
        }
    };
}

function addRecoveryIssue(report, issueRows, unsafeRows, kind, row, rowIndex) {
    unsafeRows.add(rowIndex);
    if (issueRows[kind].has(rowIndex)) return;
    issueRows[kind].add(rowIndex);
    report.issues[kind].count++;
    const id = safeDocumentId(row);
    if (id && report.issues[kind].ids.length < 50 && !report.issues[kind].ids.includes(id)) {
        report.issues[kind].ids.push(id);
    }
}

const objectIdMap = documents => new Map(
    documents
        .filter(document => isStoredObjectId(document?._id))
        .map(document => [document._id.toHexString(), document])
);

async function findByObjectIds(getCollection, collectionName, ids, projection) {
    const unique = new Map(ids.filter(isStoredObjectId).map(id => [id.toHexString(), id]));
    if (unique.size === 0) return [];
    return getCollection(collectionName).find(
        { _id: { $in: [...unique.values()] } },
        { projection }
    ).toArray();
}

function credentialIsUsable(value, cryptoHelpers) {
    if (!nonBlankString(value)) return false;
    return !cryptoHelpers.isEncrypted(value) || Boolean(cryptoHelpers.decryptSecretStrict(value));
}

function providerRecoveryConfigurationIsUsable(
    row,
    provider,
    cryptoHelpers,
    supportsOperation,
    operation = PROVIDER_OPERATIONS.PURCHASE_BROADBAND
) {
    if (!provider || row.providerAdapterType !== 'universal'
        || provider.adapterType !== row.providerAdapterType
        || !nonBlankString(row.provider)
        || row.provider.trim().toLowerCase() !== String(provider.name || '').trim().toLowerCase()) {
        return false;
    }

    const snapshotComplete = nonBlankString(row.providerConfigSnapshot?.baseUrl)
        && nonBlankString(row.providerCredentialSnapshot?.apiKey);
    const config = snapshotComplete
        ? row.providerConfigSnapshot
        : { baseUrl: provider.baseUrl, metadata: provider.metadata };
    const credentials = snapshotComplete
        ? row.providerCredentialSnapshot
        : { apiKey: provider.apiKey, secretKey: provider.secretKey };
    const metadata = config?.metadata instanceof Map
        ? Object.fromEntries(config.metadata)
        : (config?.metadata || {});

    if (!nonBlankString(config?.baseUrl)
        || !credentialIsUsable(credentials?.apiKey, cryptoHelpers)
        || (credentials?.secretKey && !credentialIsUsable(credentials.secretKey, cryptoHelpers))
        || (metadata.authHeaderValue !== undefined && !isSafeAuthTemplate(metadata.authHeaderValue))) {
        return false;
    }
    const providerIdentity = { adapterType: row.providerAdapterType, metadata };
    if (!supportsOperation(providerIdentity, operation)) return false;
    if (operation !== PROVIDER_OPERATIONS.QUERY_TRANSACTION) return true;

    const configured = value => value !== undefined && value !== null && value !== '';
    const queryMap = metadata.queryFieldMap ?? metadata.fieldMap;
    return queryMap && typeof queryMap === 'object'
        && configured(queryMap.request_id)
        && ['Success', 'Pending', 'Failure'].every(suffix => (
            configured(metadata[`query${suffix}Path`] ?? metadata[`${suffix.toLowerCase()}Path`])
            && configured(metadata[`query${suffix}Value`] ?? metadata[`${suffix.toLowerCase()}Value`])
        ));
}

async function inspectHistoricalRecovery(collection, {
    getCollection,
    cryptoHelpers = { decryptSecretStrict, isEncrypted },
    supportsOperation = supportsProviderOperation
} = {}) {
    const rows = await collection.find(
        RECOVERY_MATCH,
        { projection: RECOVERY_PROJECTION }
    ).toArray();
    const report = emptyRecoveryReport();
    report.scanned = rows.length;
    if (rows.length === 0) return report;
    if (typeof getCollection !== 'function') {
        throw new Error('Reference collections are required for historical recovery preflight');
    }

    const unsafeRows = new Set();
    const issueRows = Object.fromEntries(Object.keys(report.issues).map(key => [key, new Set()]));
    const decodedPayloads = new Map();

    rows.forEach((row, rowIndex) => {
        const isPreDispatch = row.dispatchState === 'not_dispatched';
        const isPostDispatch = row.dispatchState === 'dispatching' || row.dispatchState === 'dispatched';
        if (!isPreDispatch && !isPostDispatch) {
            addRecoveryIssue(report, issueRows, unsafeRows, 'state', row, rowIndex);
        }
        if (isPreDispatch
            && row.providerOutcome !== undefined
            && row.providerOutcome !== null
            && row.providerOutcome !== 'unknown') {
            addRecoveryIssue(report, issueRows, unsafeRows, 'state', row, rowIndex);
        }

        if (isPreDispatch) {
            const decoded = decodeBroadbandRecoveryPayload(
                row.recoveryPayload,
                cryptoHelpers.decryptSecretStrict
            );
            if (!decoded.ok) {
                addRecoveryIssue(report, issueRows, unsafeRows, decoded.reason === 'encryption' ? 'encryption' : 'schema', row, rowIndex);
            } else {
                decodedPayloads.set(rowIndex, decoded.payload);
            }
        }

        const objectIds = [
            row._id,
            row.userId,
            row.providerId,
            row.providerOfferId,
            row.pricingSnapshot?.serviceId,
            row.pricingSnapshot?.providerId,
            row.pricingSnapshot?.providerOfferId
        ];
        if (objectIds.some(value => !isStoredObjectId(value))) {
            addRecoveryIssue(report, issueRows, unsafeRows, 'objectId', row, rowIndex);
        }
        if (!PROVIDER_REQUEST_ID.test(row.providerRequestId || '')) {
            addRecoveryIssue(report, issueRows, unsafeRows, 'reference', row, rowIndex);
        }
        if (isPreDispatch && (!Number.isFinite(row.amount) || row.amount <= 0
            || !Number.isFinite(row.pricingSnapshot?.salePrice)
            || row.pricingSnapshot.salePrice <= 0
            || row.amount !== row.pricingSnapshot.salePrice)) {
            addRecoveryIssue(report, issueRows, unsafeRows, 'pricing', row, rowIndex);
        }
    });

    const [providers, offers, services] = await Promise.all([
        findByObjectIds(getCollection, REFERENCE_COLLECTIONS.providers, rows.map(row => row.providerId), {
            _id: 1, name: 1, adapterType: 1, baseUrl: 1, apiKey: 1, secretKey: 1, metadata: 1
        }),
        findByObjectIds(getCollection, REFERENCE_COLLECTIONS.offers, rows.map(row => row.providerOfferId), {
            _id: 1, serviceId: 1, providerId: 1, providerCode: 1, providerServiceCode: 1, costMode: 1
        }),
        findByObjectIds(getCollection, REFERENCE_COLLECTIONS.services, rows.map(row => row.pricingSnapshot?.serviceId), {
            _id: 1, identityId: 1, category: 1
        })
    ]);
    const providerById = objectIdMap(providers);
    const offerById = objectIdMap(offers);
    const serviceById = objectIdMap(services);
    const identities = await findByObjectIds(
        getCollection,
        REFERENCE_COLLECTIONS.identities,
        services.map(service => service.identityId),
        { _id: 1, purchaseMode: 1 }
    );
    const identityById = objectIdMap(identities);

    rows.forEach((row, rowIndex) => {
        if (!isStoredObjectId(row.providerId)
            || !isStoredObjectId(row.providerOfferId)
            || !isStoredObjectId(row.pricingSnapshot?.serviceId)) return;

        const provider = providerById.get(row.providerId.toHexString());
        const offer = offerById.get(row.providerOfferId.toHexString());
        const service = serviceById.get(row.pricingSnapshot.serviceId.toHexString());
        const identity = isStoredObjectId(service?.identityId)
            ? identityById.get(service.identityId.toHexString())
            : null;
        if (!provider || !offer || !service || !identity) {
            addRecoveryIssue(report, issueRows, unsafeRows, 'reference', row, rowIndex);
            return;
        }

        const referencesMatch = String(offer.serviceId) === String(service._id)
            && String(offer.providerId) === String(provider._id)
            && String(row.pricingSnapshot.providerId) === String(provider._id)
            && String(row.pricingSnapshot.providerOfferId) === String(offer._id)
            && service.category === 'broadband'
            && ['plan', 'amount'].includes(identity.purchaseMode);
        if (!referencesMatch) {
            addRecoveryIssue(report, issueRows, unsafeRows, 'reference', row, rowIndex);
        }

        const isPreDispatch = row.dispatchState === 'not_dispatched';
        const payload = decodedPayloads.get(rowIndex);
        if (isPreDispatch && payload && (payload.serviceID !== offer.providerServiceCode
            || payload.variation_code !== offer.providerCode
            || (identity.purchaseMode === 'plan' && offer.costMode !== 'fixed')
            || (identity.purchaseMode === 'amount' && offer.costMode !== 'dynamic'))) {
            addRecoveryIssue(report, issueRows, unsafeRows, 'schema', row, rowIndex);
        }
        const requiredOperation = isPreDispatch
            ? PROVIDER_OPERATIONS.PURCHASE_BROADBAND
            : PROVIDER_OPERATIONS.QUERY_TRANSACTION;
        if (!providerRecoveryConfigurationIsUsable(
            row,
            provider,
            cryptoHelpers,
            supportsOperation,
            requiredOperation
        )) {
            addRecoveryIssue(report, issueRows, unsafeRows, 'providerConfiguration', row, rowIndex);
        }
    });

    report.unsafe = unsafeRows.size;
    return report;
}

function hasExplicitDatabaseName(uri) {
    if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//i.test(uri)) return false;
    const withoutQuery = uri.split('?')[0];
    const authorityStart = withoutQuery.indexOf('://') + 3;
    const pathStart = withoutQuery.indexOf('/', authorityStart);
    return pathStart >= 0 && withoutQuery.slice(pathStart + 1).trim().length > 0;
}

async function readIndexes(collection) {
    try {
        return await collection.indexes();
    } catch (error) {
        if (error?.code === 26 || error?.codeName === 'NamespaceNotFound') return [];
        throw error;
    }
}

function assertNoIndexConflict(indexes) {
    const sameName = indexes.find(index => index.name === INDEX_NAME);
    const sameKeys = indexes.filter(index => isDeepStrictEqual(index.key || {}, INDEX_KEY));
    const candidates = [...new Set([sameName, ...sameKeys].filter(Boolean))];
    for (const candidate of candidates) {
        const actualOptions = {
            unique: Boolean(candidate.unique),
            ...(candidate.partialFilterExpression
                ? { partialFilterExpression: candidate.partialFilterExpression }
                : {})
        };
        if (candidate.name !== INDEX_NAME || !isDeepStrictEqual(candidate.key, INDEX_KEY)
            || !isDeepStrictEqual(actualOptions, INDEX_OPTIONS)) {
            throw new Error(`Conflicting index '${candidate.name}' exists for ${INDEX_NAME}`);
        }
    }
}

async function inspectData(collection, options = {}) {
    const [blank, untrimmed, oversized, invalidFingerprint, missingUser, unrecoverable, duplicates, historicalRecovery] = await Promise.all([
        collection.countDocuments({ idempotencyKey: { $type: 'string', $regex: /^\s*$/ } }),
        collection.countDocuments({
            idempotencyKey: { $type: 'string' },
            $expr: { $ne: ['$idempotencyKey', { $trim: { input: '$idempotencyKey' } }] }
        }),
        collection.countDocuments({ idempotencyKey: { $type: 'string', $regex: /^.{101,}$/ } }),
        collection.countDocuments({
            type: 'broadband',
            idempotencyKey: { $type: 'string' },
            $or: [
                { requestFingerprint: { $exists: false } },
                { requestFingerprint: { $not: { $type: 'string' } } },
                { requestFingerprint: { $not: /^[a-f0-9]{64}$/ } }
            ]
        }),
        collection.countDocuments({
            type: 'broadband',
            idempotencyKey: { $type: 'string' },
            $or: [
                { userId: { $exists: false } },
                { userId: null },
                { userId: { $exists: true, $ne: null, $not: { $type: 'objectId' } } }
            ]
        }),
        collection.countDocuments({
            type: 'broadband',
            idempotencyKey: { $type: 'string' },
            status: 'pending',
            dispatchState: 'not_dispatched',
            $or: [
                { recoveryPayload: { $not: { $type: 'string' } } },
                { providerId: { $not: { $type: 'objectId' } } },
                { providerAdapterType: { $not: { $type: 'string' } } },
                { providerOfferId: { $not: { $type: 'objectId' } } },
                { 'pricingSnapshot.serviceId': { $not: { $type: 'objectId' } } },
                { providerRequestId: { $not: { $type: 'string' } } }
            ]
        }),
        collection.aggregate([
            { $match: { idempotencyKey: { $type: 'string' } } },
            {
                $group: {
                    _id: { userId: '$userId', idempotencyKey: '$idempotencyKey' },
                    count: { $sum: 1 },
                    transactionIds: { $push: '$transactionId' }
                }
            },
            { $match: { count: { $gt: 1 } } },
            { $project: { _id: 0, count: 1, transactionIds: { $slice: ['$transactionIds', 50] } } },
            { $limit: 50 }
        ]).toArray(),
        inspectHistoricalRecovery(collection, options)
    ]);
    return {
        blank,
        untrimmed,
        oversized,
        invalidFingerprint,
        missingUser,
        unrecoverable,
        duplicates: sanitizeDuplicateDiagnostics(duplicates),
        historicalRecovery
    };
}

function assertDataSafe(report) {
    if (!dataIsSafe(report)) {
        throw new Error('Historical Broadband idempotency keys are not safe for unique index creation');
    }
}

function dataIsSafe(report) {
    return !(report.blank || report.untrimmed || report.oversized || report.invalidFingerprint
        || report.missingUser || report.unrecoverable || report.duplicates.length
        || report.historicalRecovery?.unsafe);
}

async function run(options = {}) {
    const env = options.env || process.env;
    const argv = options.argv || process.argv;
    const mongooseInstance = options.mongooseInstance || mongoose;
    const logger = options.logger || console;
    const mongoUri = env.MONGO_URI;
    if (!mongoUri) throw new Error('MONGO_URI is required');
    if (!hasExplicitDatabaseName(mongoUri)) {
        throw new Error('MONGO_URI must explicitly include the approved target database name');
    }
    const apply = argv.includes('--apply');
    if (apply && env.BROADBAND_IDEMPOTENCY_MIGRATION_CONFIRM !== APPLY_CONFIRMATION) {
        throw new Error(`Refusing --apply without BROADBAND_IDEMPOTENCY_MIGRATION_CONFIRM=${APPLY_CONFIRMATION}`);
    }
    const expectedDatabase = String(env.BROADBAND_IDEMPOTENCY_EXPECTED_DB || '').trim();
    if (apply && !expectedDatabase) {
        throw new Error('Refusing --apply without BROADBAND_IDEMPOTENCY_EXPECTED_DB');
    }

    await mongooseInstance.connect(mongoUri, { autoIndex: false, autoCreate: false });
    try {
        const connectedDatabase = String(mongooseInstance.connection.name || '');
        if (apply && connectedDatabase !== expectedDatabase) {
            throw new Error('Connected database does not match BROADBAND_IDEMPOTENCY_EXPECTED_DB');
        }
        const collection = mongooseInstance.connection.collection(COLLECTION_NAME);
        const [indexes, report] = await Promise.all([
            readIndexes(collection),
            inspectData(collection, {
                getCollection: name => mongooseInstance.connection.collection(name),
                cryptoHelpers: options.cryptoHelpers,
                supportsOperation: options.supportsOperation
            })
        ]);
        assertNoIndexConflict(indexes);
        const ready = dataIsSafe(report);
        logger.log(JSON.stringify({
            mode: apply ? 'apply' : 'validation-only',
            ready,
            targetDatabase: connectedDatabase,
            collection: COLLECTION_NAME,
            index: INDEX_NAME,
            data: report
        }, null, 2));
        if (!ready) logger.log('Validation result: NOT READY. No data or indexes were changed.');
        assertDataSafe(report);

        if (!apply) {
            logger.log('Validation passed. No data or indexes were changed.');
            return;
        }
        if (!indexes.some(index => index.name === INDEX_NAME)) {
            await collection.createIndex(INDEX_KEY, { ...INDEX_OPTIONS, name: INDEX_NAME });
        }
        const finalIndexes = await readIndexes(collection);
        assertNoIndexConflict(finalIndexes);
        if (!finalIndexes.some(index => index.name === INDEX_NAME)) throw new Error(`Required index '${INDEX_NAME}' is missing`);
        logger.log('Broadband idempotency index created and verified. No transaction data was modified.');
    } finally {
        await mongooseInstance.disconnect();
    }
}

if (require.main === module) {
    dotenv.config();
    run().catch(error => {
        console.error(`[Broadband Idempotency Migration] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    INDEX_NAME,
    APPLY_CONFIRMATION,
    INDEX_KEY,
    INDEX_OPTIONS,
    PROVIDER_REQUEST_ID,
    RECOVERY_MATCH,
    hasExplicitDatabaseName,
    assertNoIndexConflict,
    isStoredObjectId,
    safeDocumentId,
    providerRecoveryConfigurationIsUsable,
    sanitizeDuplicateDiagnostics,
    inspectHistoricalRecovery,
    inspectData,
    dataIsSafe,
    assertDataSafe,
    run
};
