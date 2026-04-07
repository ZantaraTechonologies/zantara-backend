const mongoose = require('mongoose');

// Records a shareholder's request to sell shares back to Zantara (principal withdrawal)
// Subject to lock period and monthly exit quota checks before admin approval
const shareExitRequestSchema = new mongoose.Schema({
    userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sharesRequested:  { type: Number, required: true },            // Number of shares to sell back
    sharePrice:       { type: Number, required: true },            // Price per share at time of request
    grossAmount:      { type: Number, required: true },            // sharesRequested × sharePrice
    exitFeePercent:   { type: Number, required: true },            // Fee % at time of request
    exitFeeCharged:   { type: Number, required: true },            // Fee in ₦
    netAmount:        { type: Number, required: true },            // Amount returned to main wallet after fee
    refId:            { type: String, unique: true, sparse: true },
    status:           { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    adminNote:        { type: String, default: '' },
    // Lock period audit
    firstPurchasedAt: { type: Date, required: true },              // Snapshot of when shares were first purchased
    lockPeriodMonths: { type: Number, required: true },            // Lock period at time of request
    lockExpiresAt:    { type: Date, required: true }               // firstPurchasedAt + lockPeriodMonths
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model('ShareExitRequest', shareExitRequestSchema);
