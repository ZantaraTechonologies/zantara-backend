const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: { type: String, enum: ['transaction', 'support', 'system', 'kyc'], default: 'system' },
    isRead: { type: Boolean, default: false },
    metadata: { type: Object } // e.g., { transactionId: '...' }
}, { timestamps: true });

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
