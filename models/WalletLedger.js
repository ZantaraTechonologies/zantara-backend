const mongoose = require('mongoose');

const walletLedgerSchema = new mongoose.Schema({
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    reference: { type: String, required: true, index: true },
    settlementKey: { type: String },
    entryType: { type: String, enum: ['credit', 'debit'], required: true },
    source: { type: String, required: true }, // e.g., 'funding', 'purchase', 'refund', 'admin'
    amount: { type: Number, required: true },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    commissionVersion: { type: String },
    metadata: { type: Object }
}, { timestamps: true, autoIndex: false });

// Built explicitly by the approved deployment migration. autoIndex is disabled
// for this model so application startup cannot create a production unique index.
walletLedgerSchema.index(
    { settlementKey: 1 },
    {
        unique: true,
        partialFilterExpression: { settlementKey: { $type: 'string' } },
        name: 'settlementKey_1_unique_partial'
    }
);

module.exports = mongoose.model('WalletLedger', walletLedgerSchema);
