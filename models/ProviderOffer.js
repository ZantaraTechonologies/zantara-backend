const mongoose = require('mongoose');

const providerOfferSchema = new mongoose.Schema({
    serviceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Service',
        required: true
    },
    providerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Provider',
        required: true
    },
    providerCode: {
        type: String,
        required: true,
        trim: true
    },
    providerRetailPrice: {
        type: Number,
        default: 0
    },
    costPrice: {
        type: Number,
        required: true,
        default: 0
    },
    costMode: {
        type: String,
        enum: ['fixed', 'dynamic'],
        default: 'fixed'
    },
    currency: {
        type: String,
        default: 'NGN'
    },
    priority: {
        type: Number,
        default: 0
    },
    status: {
        type: Boolean,
        default: true
    },
    metadata: {
        type: Map,
        of: String
    },
    lastSyncedAt: {
        type: Date
    }
}, { timestamps: true });

// A service can have multiple provider offers, but usually unique per provider
providerOfferSchema.index({ serviceId: 1, providerId: 1 }, { unique: true });
providerOfferSchema.index({ serviceId: 1, priority: -1 });

module.exports = mongoose.model('ProviderOffer', providerOfferSchema);
