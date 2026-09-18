const mongoose = require('mongoose');

// Records a shareholder's request to sell shares back to Zantara (principal withdrawal)
// Subject to lock period and monthly exit quota checks before admin approval
const shareExitRequestSchema = new mongoose.Schema({
    userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sharesRequested:  { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
    sharePrice:       { type: Number, required: true, min: 0.01, validate: Number.isFinite },
    grossAmount:      { type: Number, required: true, min: 0.01, validate: Number.isFinite },
    exitFeePercent:   { type: Number, required: true, min: 0, max: 99.99, validate: Number.isFinite },
    exitFeeCharged:   { type: Number, required: true, min: 0, validate: Number.isFinite },
    netAmount:        { type: Number, required: true, min: 0.01, validate: Number.isFinite },
    reservationVersion: { type: Number, enum: [1], required: true },
    reservedShares: { type: Number, min: 1, validate: Number.isSafeInteger, required: true },
    refId:            { type: String, unique: true, sparse: true },
    status:           { type: String, enum: ['pending', 'processing', 'manual_review', 'approved', 'rejected'], default: 'pending' },
    adminNote:        { type: String, default: '' },
    // Lock period audit
    firstPurchasedAt: { type: Date, required: true },              // Snapshot of when shares were first purchased
    lockPeriodMonths: { type: Number, required: true },            // Lock period at time of request
    lockExpiresAt:    { type: Date, required: true }               // firstPurchasedAt + lockPeriodMonths
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model('ShareExitRequest', shareExitRequestSchema);
