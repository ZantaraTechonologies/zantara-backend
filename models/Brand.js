const mongoose = require('mongoose');

const brandSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    slug: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    // Changed from typeId (single) to typeIds (array) for M:M support
    typeIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServiceType'
    }],
    logoUrl: {
        type: String
    },
    status: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

// Ensure name is unique globally in the normalized model
brandSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model('Brand', brandSchema);
