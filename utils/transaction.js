const Transaction = require('../models/Transaction')

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
        await Transaction.create({
            userId,
            transactionId: transactionId || refId || `TXN-${Date.now()}`,
            refId,
            type,
            service,
            amount,
            status,
            response
        })
    } catch (err) {
        console.error('Transaction logging failed:', err.message)
        // Optional: save error to your logs collection
    }
}

module.exports = { logTransaction }