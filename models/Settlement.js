const mongoose = require('mongoose');

const settlementSchema = new mongoose.Schema({
    provider: { type: String, required: true }, // e.g., 'VTPass', 'Monnify'
    amount: { type: Number, required: true },
    date: { type: Date, default: Date.now },
    reference: { type: String, unique: true },
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'completed' },
    reason: { type: String }, // e.g., 'Provider Funding', 'Manual Reconciliation'
    initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Settlement', settlementSchema);
