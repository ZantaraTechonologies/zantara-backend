const mongoose = require('mongoose');

const broadcastSchema = new mongoose.Schema({
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: { type: String, enum: ['info', 'warning', 'success', 'critical'], default: 'info' },
    target: { type: String, enum: ['all', 'user', 'agent'], default: 'all' },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date } // Optional: when the broadcast should stop showing
}, { timestamps: true });

const Broadcast = mongoose.model('Broadcast', broadcastSchema);

module.exports = Broadcast;
