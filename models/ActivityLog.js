const mongoose = require('mongoose')

const activityLogSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    action: { type: String, required: true }, // e.g., 'LOGIN', 'PASSWORD_CHANGE'
    ipAddress: String,
    device: String,
    details: Object,
    status: { type: String, enum: ['success', 'failed'], default: 'success' }
}, { timestamps: true })

const ActivityLog = mongoose.model('ActivityLog', activityLogSchema)

module.exports = ActivityLog
