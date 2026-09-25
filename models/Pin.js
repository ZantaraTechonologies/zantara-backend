const mongoose = require('mongoose');
const { encryptSecret } = require('../utils/crypto');

const pinSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    service: String,
    code: { type: String, set: encryptSecret },
    serial: { type: String, default: null, set: encryptSecret },
    refId: String,  // Transaction ID
    status: { type: String, enum: ['unused', 'used', 'delivered'], default: 'unused' }
}, { timestamps: true });

const pinModel = mongoose.model('Pin', pinSchema)

module.exports = pinModel
