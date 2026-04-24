const mongoose = require('mongoose');

const serviceTypeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    slug: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },
    categoryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServiceCategory',
        required: true
    },
    workflowType: {
        type: String,
        enum: ['topup', 'choice_selection', 'validation', 'document_generation'],
        default: 'topup'
    },
    status: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

// Ensure slug is unique within a category
serviceTypeSchema.index({ slug: 1, categoryId: 1 }, { unique: true });

serviceTypeSchema.index({ name: 1, categoryId: 1 }, { unique: true });

module.exports = mongoose.model('ServiceType', serviceTypeSchema);
