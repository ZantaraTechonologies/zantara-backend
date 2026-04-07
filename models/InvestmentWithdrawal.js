const mongoose = require('mongoose');

// Records a shareholder's request to withdraw dividend earnings to their bank account
const investmentWithdrawalSchema = new mongoose.Schema({
    userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount:        { type: Number, required: true },       // Amount requested
    feePercent:    { type: Number, required: true },       // Fee % at time of request
    feeCharged:    { type: Number, required: true },       // Fee in ₦
    netAmount:     { type: Number, required: true },       // Amount investor actually receives
    bankName:      { type: String, required: true },
    accountNumber: { type: String, required: true },
    accountName:   { type: String, required: true },
    source:        { type: String, enum: ['dividend', 'referral'], default: 'dividend' },
    refId:         { type: String, unique: true, sparse: true },
    status:        { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    adminNote:     { type: String, default: '' }
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model('InvestmentWithdrawal', investmentWithdrawalSchema);
