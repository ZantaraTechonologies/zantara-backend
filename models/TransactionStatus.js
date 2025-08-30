const mongoose = require('mongoose')

const transactionStatusSchema = new mongoose.Schema({
    refId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    status: { type: String, enum: ['pending', 'failed', 'success'], default: 'pending' },
    retries: { type: Number, default: 0 },
    lastAttempt: { type: Date, default: Date.now },
    errorMessage: { type: String, default: '' }
}, { timestamps: true })

const transactionStatusModel = mongoose.model('TransactionStatus', transactionStatusSchema)

module.exports = transactionStatusModel