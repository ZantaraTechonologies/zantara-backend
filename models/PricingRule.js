const mongoose = require('mongoose');

const pricingRuleSchema = new mongoose.Schema({
    targetType: {
        type: String,
        enum: ['global', 'category', 'service_type', 'identity', 'service'],
        required: true
    },
    targetId: {
        type: mongoose.Schema.Types.ObjectId,
        required: false // Null if targetType is 'global'
    },
    userRole: {
        type: String,
        enum: ['user', 'agent', 'admin', 'superAdmin', 'shareholder', 'retail', 'reseller', 'all'],
        default: 'all'
    },
    markupType: {
        type: String,
        enum: ['fixed', 'percent'],
        required: true
    },
    markupValue: {
        type: Number,
        required: true
    },
    priority: {
        type: Number,
        default: 0
    },
    roundingMode: {
        type: String,
        enum: ['none', 'ceil', 'floor', 'round'],
        default: 'round'
    },
    status: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

// Ensure unique rule for a specific target and role combination
pricingRuleSchema.index({ targetType: 1, targetId: 1, userRole: 1 }, { unique: true });

module.exports = mongoose.model('PricingRule', pricingRuleSchema);
