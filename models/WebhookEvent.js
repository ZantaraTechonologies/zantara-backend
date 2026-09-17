const mongoose = require('mongoose');

const webhookEventSchema = new mongoose.Schema({
    provider: { type: String, required: true, index: true }, // e.g., 'paystack', 'monnify', 'flutterwave'
    eventType: { type: String, required: true },
    eventId: { type: String, required: true },
    payload: { type: Object, required: true },
    // pending: authenticated and actively processing; retryable: a later delivery
    // may claim it; processed/failed: terminal and safe to deduplicate.
    status: { type: String, enum: ['pending', 'retryable', 'processed', 'failed'], default: 'pending', index: true },
    attemptCount: { type: Number, default: 1 },
    lastAttemptAt: { type: Date, default: Date.now },
    processingExpiresAt: { type: Date, default: null },
    linkedTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    errorMessage: { type: String }
}, { timestamps: true });

// Provider event identifiers belong to independent namespaces.
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true, name: 'provider_1_eventId_1' });

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
