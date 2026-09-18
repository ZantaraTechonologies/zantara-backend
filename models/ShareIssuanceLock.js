const mongoose = require('mongoose');

const shareIssuanceLockSchema = new mongoose.Schema({
    _id: { type: String, default: 'global' },
    revision: { type: Number, default: 0 }
}, { versionKey: false, autoIndex: false });

module.exports = mongoose.model('ShareIssuanceLock', shareIssuanceLockSchema);
