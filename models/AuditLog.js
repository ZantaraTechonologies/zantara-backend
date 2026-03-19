const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    operatorName: { type: String },
    action: { type: String, required: true, index: true }, // e.g., 'USER_BLOCK', 'WITHDRAWAL_APPROVE'
    target: { type: String }, // e.g., 'User ID: 123'
    details: { type: mongoose.Schema.Types.Mixed },
    ipAddress: { type: String },
    userAgent: { type: String },
    result: { type: String, enum: ['success', 'failure'], default: 'success' }
}, { timestamps: true });

module.exports = mongoose.model('AuditLog', auditLogSchema);
