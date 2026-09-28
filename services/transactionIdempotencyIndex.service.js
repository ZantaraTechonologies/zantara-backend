const { isDeepStrictEqual } = require('node:util');
const Transaction = require('../models/Transaction');

const INDEX_NAME = 'userId_1_idempotencyKey_1_unique_partial';
const INDEX_KEY = { userId: 1, idempotencyKey: 1 };
const INDEX_FILTER = { idempotencyKey: { $type: 'string' } };

const CACHE_TTL_MS = 5 * 60 * 1000;
let verifiedAt = 0;

async function assertInstalled() {
    if (verifiedAt && Date.now() - verifiedAt < CACHE_TTL_MS) return true;
    let indexes;
    try {
        indexes = await Transaction.collection.indexes();
    } catch (_) {
        indexes = [];
    }
    const index = indexes.find(candidate => candidate.name === INDEX_NAME);
    if (!index || !index.unique || !isDeepStrictEqual(index.key, INDEX_KEY)
        || !isDeepStrictEqual(index.partialFilterExpression, INDEX_FILTER)) {
        verifiedAt = 0;
        const error = new Error('Broadband purchase is unavailable until the idempotency index migration is applied');
        error.code = 'BROADBAND_IDEMPOTENCY_INDEX_MISSING';
        error.statusCode = 503;
        throw error;
    }
    verifiedAt = Date.now();
    return true;
}

function resetForTests() {
    verifiedAt = 0;
}

module.exports = { CACHE_TTL_MS, assertInstalled, resetForTests };
