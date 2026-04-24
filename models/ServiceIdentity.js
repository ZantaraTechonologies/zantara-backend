const mongoose = require('mongoose');

const serviceIdentitySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    internalCode: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true
    },
    providerCode: {
        type: String,
        trim: true
    },
    slug: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    categoryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServiceCategory',
        required: true
    },
    typeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServiceType',
        required: true
    },
    brandId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Brand',
        required: true
    },
    fulfillmentMode: {
        type: String,
        enum: ['sync', 'async', 'manual'],
        default: 'sync'
    },
    status: {
        type: Boolean,
        default: true
    },
    metadata: {
        type: Map,
        of: String
    }
}, { timestamps: true });

serviceIdentitySchema.pre('validate', function(next) {
    if (!this.slug && this.name) {
        this.slug = this.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    }
    next();
});

module.exports = mongoose.model('ServiceIdentity', serviceIdentitySchema);
