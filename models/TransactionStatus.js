const mongoose = require('mongoose');

const transactionStatusSchema = new mongoose.Schema({
    refId: { type: String, required: true, unique: true }, // your app's reference
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // ← add this
    type: { type: String, enum: ['funding', 'purchase', 'payout'], required: true }, // you already use 'funding'
    status: { type: String, enum: ['pending', 'failed', 'success'], default: 'pending', index: true },

    // Optional but useful observability fields:
    amountKobo: { type: Number },                       // store integer minor units to avoid FP issues
    channels: [{ type: String, enum: ['card', 'ussd', 'bank_transfer'] }],
    provider: { type: String, default: 'paystack' },  // in case you add others later
    providerRef: { type: String },                       // if you ever need to store Paystack’s own ref
    errorMessage: { type: String, default: '' },

    retries: { type: Number, default: 0 },
    lastAttempt: { type: Date, default: Date.now },
}, { timestamps: true });

// Helpful indexes for dashboards/cleanup:
transactionStatusSchema.index({ createdAt: -1 });

module.exports = mongoose.model('TransactionStatus', transactionStatusSchema);