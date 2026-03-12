const mongoose = require('mongoose');

const webhookEventSchema = new mongoose.Schema({
    provider: { type: String, required: true, index: true }, // e.g., 'paystack', 'monnify', 'flutterwave'
    eventType: { type: String, required: true },
    eventId: { type: String, required: true, unique: true, index: true }, // Unique ID from provider
    payload: { type: Object, required: true },
    status: { type: String, enum: ['pending', 'processed', 'failed'], default: 'pending', index: true },
    linkedTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    errorMessage: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
