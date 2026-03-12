const mongoose = require('mongoose');

const walletLedgerSchema = new mongoose.Schema({
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    reference: { type: String, required: true, index: true },
    entryType: { type: String, enum: ['credit', 'debit'], required: true },
    source: { type: String, required: true }, // e.g., 'funding', 'purchase', 'refund', 'admin'
    amount: { type: Number, required: true },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    metadata: { type: Object }
}, { timestamps: true });

module.exports = mongoose.model('WalletLedger', walletLedgerSchema);
