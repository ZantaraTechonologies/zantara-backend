const mongoose = require('mongoose');

const shareExitQuotaSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    allowance: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    used: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    shareholderCount: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    percentage: { type: Number, required: true, min: 0, max: 100, validate: Number.isFinite },
    revision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger }
}, { versionKey: false, autoIndex: false });

module.exports = mongoose.model('ShareExitQuota', shareExitQuotaSchema);
