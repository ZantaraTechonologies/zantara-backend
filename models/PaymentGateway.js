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

// ─── INDEXES ──────────────────────────────────────────────────────────────────
//
// Enforce at most one isDefault=true across all gateway documents.
// A partial unique index on { isDefault: 1 } where isDefault==true means MongoDB
// will reject a second document with isDefault=true at the storage layer.
// This is race-safe — no two concurrent writes can both succeed with isDefault=true.
//
// Multiple gateways with isDefault=false (or missing) are allowed, because the
// partial filter expression only covers documents where isDefault === true.
//
paymentGatewaySchema.index(
    { isDefault: 1 },
    {
        unique: true,
        partialFilterExpression: { isDefault: true },
        name: 'unique_single_default_gateway'
    }
);

// ─── PRE-SAVE HOOK ────────────────────────────────────────────────────────────
//
// 1. Encrypts secretKey and webhookSecret at rest if plaintext.
// 2. Does NOT handle isDefault unset here — use PaymentGateway.setDefault(id)
//    for concurrency-safe default assignment. The partial unique index above
//    is the true enforcement layer.
//
paymentGatewaySchema.pre('save', async function (next) {
    if (this.isModified('secretKey') && this.secretKey && !isEncrypted(this.secretKey)) {
        this.secretKey = encryptSecret(this.secretKey);
    }

    if (this.isModified('webhookSecret') && this.webhookSecret && !isEncrypted(this.webhookSecret)) {
        this.webhookSecret = encryptSecret(this.webhookSecret);
    }

    if (typeof next === 'function') {
        next();
    }
});

// ─── STATIC: Concurrency-safe default gateway assignment ─────────────────────
//
// Usage:  await PaymentGateway.setDefault(gatewayId);
//
// Pattern:
//   Step 1 — Clear any existing default (atomic updateOne).
//   Step 2 — Set new gateway as default (atomic updateOne).
//
// Because the partial unique index prevents two simultaneous isDefault=true commits,
// and because we clear BEFORE setting, concurrent calls to setDefault are serialized
// at the application level by Step 1 and race-protected at DB level by the index.
//
// If Step 2 fails (e.g. invalid id), no gateway has isDefault=true, which is
// a safe state — getDefaultGateway() returns null and falls back to env or error.
//
paymentGatewaySchema.statics.setDefault = async function (gatewayId) {
    if (!gatewayId) throw new Error('gatewayId is required to set a default gateway');

    // Step 1: Atomically clear any existing default
    await this.updateMany({ isDefault: true }, { $set: { isDefault: false } });

    // Step 2: Atomically set the new default
    const result = await this.updateOne(
        { _id: gatewayId, status: 'active' },
        { $set: { isDefault: true } }
    );

    if (result.modifiedCount !== 1) {
        throw new Error(`Cannot set gateway ${gatewayId} as default: gateway not found or not active`);
    }

    return result;
};

module.exports = mongoose.model('PaymentGateway', paymentGatewaySchema);

