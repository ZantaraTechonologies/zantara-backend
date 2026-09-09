const mongoose = require('mongoose');
const { encryptSecret, isEncrypted } = require('../utils/crypto');

const paymentGatewaySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    code: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    adapterType: {
        type: String,
        enum: ['paystack', 'monnify', 'flutterwave'],
        required: true
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'maintenance'],
        default: 'inactive',
        index: true
    },
    environment: {
        type: String,
        enum: ['test', 'live'],
        default: 'test'
    },
    isDefault: {
        type: Boolean,
        default: false,
        index: true
    },
    priority: {
        type: Number,
        default: 1
    },
    publicKey: {
        type: String,
        trim: true,
        default: ''
    },
    secretKey: {
        type: String,
        trim: true,
        default: ''
    },
    webhookSecret: {
        type: String,
        trim: true,
        default: ''
    },
    baseUrl: {
        type: String,
        trim: true,
        default: ''
    },
    supportedChannels: [{
        type: String,
        enum: ['card', 'bank_transfer', 'ussd', 'virtual_account']
    }],
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    lastHealthCheck: {
        status: {
            type: String,
            enum: ['online', 'offline', 'unknown'],
            default: 'unknown'
        },
        checkedAt: { type: Date },
        message: { type: String, default: '' }
    }
}, { timestamps: true });

// Pre-save hook:
// 1. Safely encrypt secretKey and webhookSecret at rest if modified and not already encrypted.
// 2. If isDefault is true, unset isDefault from any other gateway so only one is default.
paymentGatewaySchema.pre('save', async function (next) {
    if (this.isModified('secretKey') && this.secretKey && !isEncrypted(this.secretKey)) {
        this.secretKey = encryptSecret(this.secretKey);
    }

    if (this.isModified('webhookSecret') && this.webhookSecret && !isEncrypted(this.webhookSecret)) {
        this.webhookSecret = encryptSecret(this.webhookSecret);
    }

    if (this.isModified('isDefault') && this.isDefault) {
        await this.constructor.updateMany(
            { _id: { $ne: this._id }, isDefault: true },
            { $set: { isDefault: false } }
        );
    }

    if (typeof next === 'function') {
        next();
    }
});

module.exports = mongoose.model('PaymentGateway', paymentGatewaySchema);
