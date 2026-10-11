const mongoose = require('mongoose')

const walletSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    balance: { type: Number, default: 0, min: 0 },
    frozen: { type: Number, default: 0 },
    currency: { type: String, default: 'NGN' }
}, { timestamps: true, autoIndex: false })

// Settlement assumes exactly one authoritative wallet per user. This index is
// installed only by the explicit Phase 5A migration after duplicate preflight.
walletSchema.index({ userId: 1 }, { unique: true, name: 'userId_1_unique' })

// Note: All balance mutations must go through WalletService to ensure ledger traceability.

const walletModel = mongoose.model('Wallet', walletSchema)

module.exports = walletModel
