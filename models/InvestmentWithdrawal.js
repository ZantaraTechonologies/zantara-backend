const mongoose = require('mongoose');

// Records a shareholder's request to withdraw dividend earnings to their bank account
const investmentWithdrawalSchema = new mongoose.Schema({
    userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount:        { type: Number, required: true, min: 0.01, validate: Number.isFinite },
    feePercent:    { type: Number, required: true, min: 0, max: 99.99, validate: Number.isFinite },
    feeCharged:    { type: Number, required: true, min: 0, validate: Number.isFinite },
    netAmount:     { type: Number, required: true, min: 0.01, validate: Number.isFinite },
    bankName:      { type: String, required: true },
    accountNumber: { type: String, required: true },
    accountName:   { type: String, required: true },
    source:        { type: String, enum: ['dividend', 'referral'], default: 'dividend' },
    reservationVersion: { type: Number, enum: [1], required: true },
    reservedAmountKobo: { type: Number, min: 1, validate: Number.isSafeInteger, required: true },
    reservedSource: { type: String, enum: ['dividend', 'referral'], required: true },
    refId:         { type: String, unique: true, sparse: true },
    status:        { type: String, enum: ['pending', 'processing', 'manual_review', 'approved', 'rejected'], default: 'pending' },
    adminNote:     { type: String, default: '' }
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model('InvestmentWithdrawal', investmentWithdrawalSchema);
