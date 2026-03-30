const mongoose = require('mongoose');

const pinSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    service: String,
    code: String,
    refId: String,  // Transaction ID
    status: { type: String, enum: ['unused', 'used', 'delivered'], default: 'unused' }
}, { timestamps: true });

const pinModel = mongoose.model('Pin', pinSchema)

module.exports = pinModel
