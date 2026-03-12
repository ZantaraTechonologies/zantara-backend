const mongoose = require('mongoose')

const walletSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    balance: { type: Number, default: 0 },
    frozen: { type: Number, default: 0 },
    currency: { type: String, default: 'NGN' }
}, { timestamps: true })

// Note: All balance mutations must go through WalletService to ensure ledger traceability.

const walletModel = mongoose.model('Wallet', walletSchema)

module.exports = walletModel