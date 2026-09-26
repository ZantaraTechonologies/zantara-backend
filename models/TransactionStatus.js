const mongoose = require('mongoose');

const transactionStatusSchema = new mongoose.Schema({
    refId: { type: String, required: true, unique: true }, // your app's reference
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // ← add this
    type: { type: String, enum: ['funding', 'purchase', 'payout', 'investment_buy'], required: true }, // you already use 'funding'
    status: { 
        type: String, 
        enum: ['pending', 'processing', 'settlement_pending', 'failed', 'success', 'reconciliation_required'],
        default: 'pending', 
        index: true 
    },

    // Observability & Reconciliation fields:
    amountKobo: { type: Number },                       // store integer minor units to avoid FP issues
    expectedCurrency: { type: String, uppercase: true },
    confirmedAmountKobo: { type: Number },              // external provider confirmed amount
    confirmedCurrency: { type: String },                // external provider confirmed currency
    confirmedProvider: { type: String },
    confirmedReference: { type: String },
    confirmedProviderRef: { type: String },             // external provider transaction identifier
    sharePrice: { type: Number },                       // investment_buy: authoritative server-side share price (₦) snapshotted at init; fulfillment MUST bind to this, never a re-read
    reconciliationReason: { type: String },             // security / anomaly justification
    channels: [{ type: String, enum: ['card', 'ussd', 'bank_transfer', 'virtual_account'] }],
    provider: { type: String, default: 'paystack' },    // gateway code e.g. 'paystack', 'monnify'
    service: { type: String, default: '' },             // human-readable gateway name e.g. 'Paystack'
    gatewayConfigSnapshot: { type: mongoose.Schema.Types.Mixed, select: false },
    initializationOutcome: {
        type: String,
        enum: ['pending', 'ambiguous', 'definitive_failure'],
        default: 'pending'
    },
    providerRef: { type: String },                      // if you ever need to store Paystack’s own ref
    errorMessage: { type: String, default: '' },

    retries: { type: Number, default: 0 },
    lastAttempt: { type: Date, default: Date.now },
    settlementClaimToken: { type: String },
    settlementLeaseExpiresAt: { type: Date },
}, { timestamps: true, autoIndex: false });

// Helpful indexes for dashboards/cleanup:
transactionStatusSchema.index({ createdAt: -1 });
transactionStatusSchema.index({ status: 1, settlementLeaseExpiresAt: 1 });
transactionStatusSchema.index(
    { confirmedProvider: 1, confirmedProviderRef: 1 },
    {
        unique: true,
        partialFilterExpression: {
            confirmedProvider: { $type: 'string' },
            confirmedProviderRef: { $type: 'string' }
        },
        name: 'confirmedProvider_1_confirmedProviderRef_1_unique_partial'
    }
);

module.exports = mongoose.model('TransactionStatus', transactionStatusSchema);
