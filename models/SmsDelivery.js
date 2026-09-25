const mongoose = require('mongoose');

const smsDeliverySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    eventKey: { type: String, required: true },
    reference: { type: String, required: true },
    batchIndex: { type: Number, required: true },
    brandName: { type: String, default: null },
    attempts: { type: Number, default: 1, min: 1 },
    status: {
        type: String,
        enum: ['dispatching', 'delivered', 'failed'],
        default: 'dispatching',
    },
}, { timestamps: true });

smsDeliverySchema.index({ userId: 1, eventKey: 1 }, { unique: true });
smsDeliverySchema.index({ status: 1, updatedAt: 1, attempts: 1 });

module.exports = mongoose.model('SmsDelivery', smsDeliverySchema);
