const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: { type: String, enum: ['transaction', 'support', 'system', 'kyc', 'security', 'investment', 'referral'], default: 'system' },
    isRead: { type: Boolean, default: false },
    metadata: { type: Object }, // e.g., { transactionId: '...' }
    eventKey: { type: String } // Intrinsic notification event identity for cross-channel dedup (e.g., 'funding_success:ZNT-...')
}, { timestamps: true });

// Sparse unique index: only documents that SET eventKey participate. Existing
// notifications without an eventKey remain valid and index-free (backward
// compatible, non-destructive). A duplicate event dispatch then becomes a
// safe 11000 no-op instead of a second customer-facing delivery.
notificationSchema.index({ userId: 1, eventKey: 1 }, { unique: true, sparse: true });

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
