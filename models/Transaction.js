const mongoose = require('mongoose')

const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    transactionId: { type: String, unique: true }, // Added for professional FT... IDs
    refId: { type: String },
    type: { type: String, enum: ['funding', 'airtime', 'data', 'tv', 'electricity', 'pin', 'withdrawal', 'referral_redeem', 'referral_bonus'] },
    service: { type: String }, // e.g., MTN, GOTV, NEPA
    status: { type: String, enum: ['pending', 'success', 'failed'] },
    amount: { type: Number },
    details: { type: Object },
    response: { type: Object },
    commission: { type: Number }
}, { timestamps: true })

const transactionModel = mongoose.model('Transaction', transactionSchema)

module.exports = transactionModel