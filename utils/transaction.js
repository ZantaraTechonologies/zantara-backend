const Transaction = require('../models/Transaction')
const { generateTransactionId } = require('./generateID')
const { createWithIdentifierRetry } = require('./identifierRetry')

/**
 * Log a transaction into the database.
 * 
 * @param {Object} data - Details about the transaction
 * @param {ObjectId} data.userId - The user performing the transaction
 * @param {String} data.refId - A unique reference ID for the transaction
 * @param {String} data.type - Type of transaction (e.g., wallet_funding, airtime)
 * @param {String} data.service - Service provider or product type
 * @param {Number} data.amount - Amount involved
 * @param {String} [data.status='success'] - Transaction status
 * @param {Object} [data.response] - Full API response (optional)
 */
async function logTransaction({
    userId,
    refId,
    type,
    service,
    amount,
    status = 'success',
    response = {},
    transactionId
}) {
    try {
        const create = resolvedTransactionId => Transaction.create({
            userId,
            transactionId: resolvedTransactionId,
            refId,
            type,
            service,
            amount,
            status,
            response
        });
        if (transactionId) {
            await create(transactionId);
        } else {
            await createWithIdentifierRetry({
                label: 'Transaction log',
                fields: ['transactionId'],
                generate: () => ({ transactionId: generateTransactionId() }),
                create: identifiers => create(identifiers.transactionId)
            });
        }
    } catch (err) {
        console.error('Transaction logging failed:', err.message)
        // Optional: save error to your logs collection
    }
}

module.exports = { logTransaction }
