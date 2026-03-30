const mongoose = require('mongoose')

const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    transactionId: { type: String, unique: true }, // Added for professional FT... IDs
    refId: { type: String },
    type: { type: String, enum: ['funding', 'airtime', 'data', 'tv', 'cable', 'electricity', 'pin', 'withdrawal', 'referral_redeem', 'referral_bonus', 'settlement', 'expense'] },
    service: { type: String }, // e.g., MTN, GOTV, NEPA
    status: { type: String, enum: ['pending', 'success', 'failed', 'reversed'] },
    amount: { type: Number },
    costPrice: { type: Number, default: 0 },
    salePrice: { type: Number, default: 0 },
    profit: { type: Number, default: 0 },
    provider: { type: String },
    providerRef: { type: String },
    isLoss: { type: Boolean, default: false },
    details: { type: Object },
    response: { type: Object },
    commission: { type: Number },
    agentPrice: { type: Number },
    userRole: { type: String },
    netProfitAfterCommission: { type: Number, default: 0 },
    commissionVersion: { type: String, default: 'v1' }
}, { timestamps: true })

const transactionModel = mongoose.model('Transaction', transactionSchema)

module.exports = transactionModel