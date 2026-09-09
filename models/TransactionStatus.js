const mongoose = require('mongoose');

const transactionStatusSchema = new mongoose.Schema({
    refId: { type: String, required: true, unique: true }, // your app's reference
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // ← add this
    type: { type: String, enum: ['funding', 'purchase', 'payout', 'investment_buy'], required: true }, // you already use 'funding'
    status: { 
        type: String, 
        enum: ['pending', 'processing', 'failed', 'success', 'reconciliation_required'], 
        default: 'pending', 
        index: true 
    },

    // Observability & Reconciliation fields:
    amountKobo: { type: Number },                       // store integer minor units to avoid FP issues
    confirmedAmountKobo: { type: Number },              // external provider confirmed amount
    confirmedCurrency: { type: String },                // external provider confirmed currency
    confirmedProviderRef: { type: String },             // external provider transaction identifier
    reconciliationReason: { type: String },             // security / anomaly justification
    channels: [{ type: String, enum: ['card', 'ussd', 'bank_transfer'] }],
    provider: { type: String, default: 'paystack' },    // gateway code e.g. 'paystack', 'monnify'
    service: { type: String, default: '' },             // human-readable gateway name e.g. 'Paystack'
    providerRef: { type: String },                      // if you ever need to store Paystack’s own ref
    errorMessage: { type: String, default: '' },

    retries: { type: Number, default: 0 },
    lastAttempt: { type: Date, default: Date.now },
}, { timestamps: true });

// Helpful indexes for dashboards/cleanup:
transactionStatusSchema.index({ createdAt: -1 });

module.exports = mongoose.model('TransactionStatus', transactionStatusSchema);