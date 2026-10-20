const mongoose = require('mongoose');
const { encryptSecret, isEncrypted } = require('../utils/crypto');
const {
    MONNIFY_BASE_URLS,
    configurationVersion,
    isCanonicalMonnify,
    isCustomerFundingEligible,
    resolveCustomerFundingEnvironment
} = require('../utils/paymentGatewayEligibility');

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
        required: true,
        lowercase: true,
        trim: true
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
        default: 1,
        min: 1
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
    // Previous trusted verification configurations are retained so permanent
    // accounts remain verifiable after an approved credential rotation.
    webhookVerificationSnapshots: {
        type: [mongoose.Schema.Types.Mixed],
        select: false,
        default: undefined
    },
    virtualAccountMutationVersion: {
        type: Number,
        default: 0,
        min: 0,
        select: false
    },
    virtualAccountClaimVersion: {
        type: Number,
        default: 0,
        min: 0,
        select: false
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

function rejectPaymentGatewayHardDelete(next) {
    const error = new Error('Payment gateway records cannot be hard-deleted. Deactivate the gateway instead.');
    error.code = 'PAYMENT_GATEWAY_HARD_DELETE_DISABLED';
    error.statusCode = 409;
    next(error);
}

paymentGatewaySchema.pre('deleteOne', { document: true, query: true }, rejectPaymentGatewayHardDelete);
paymentGatewaySchema.pre('deleteMany', rejectPaymentGatewayHardDelete);
paymentGatewaySchema.pre('findOneAndDelete', rejectPaymentGatewayHardDelete);
paymentGatewaySchema.pre('findOneAndRemove', rejectPaymentGatewayHardDelete);
paymentGatewaySchema.pre('bulkWrite', function(next, operations) {
    const includesDelete = operations.some(operation => operation?.deleteOne || operation?.deleteMany);
    if (includesDelete) return rejectPaymentGatewayHardDelete(next);
    next();
});

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
// Both writes execute in one transaction. Callers may supply a transaction session
// when default assignment must be atomic with another write such as an audit record.
//
paymentGatewaySchema.statics.setDefault = async function (gatewayId, options = {}) {
    if (!gatewayId) throw new Error('gatewayId is required to set a default gateway');
    const suppliedSession = options.session;
    if (
        suppliedSession &&
        (
            typeof suppliedSession.inTransaction !== 'function' ||
            !suppliedSession.inTransaction()
        )
    ) {
        throw new Error('A supplied default-assignment session must already be in a transaction');
    }
    const session = suppliedSession || await mongoose.startSession();
    let transactionFinished = false;

    const assignDefault = async () => {
        let query = this.findOne({ _id: gatewayId });
        if (typeof query?.select === 'function') {
            query = query.select('+virtualAccountMutationVersion');
        }
        if (typeof query?.session === 'function') query = query.session(session);
        const gateway = await query;
        if (!isCustomerFundingEligible(gateway)) {
            throw new Error(
                `Cannot set gateway ${gatewayId} as default: gateway is not eligible for customer funding`
            );
        }

        const targetFilter = {
            _id: gatewayId,
            status: 'active',
            environment: gateway.environment,
            'metadata.administrativeSandboxOnly': { $ne: true }
        };
        const runtimeEnvironment = resolveCustomerFundingEnvironment();
        if (runtimeEnvironment) targetFilter.environment = runtimeEnvironment;

        if (isCanonicalMonnify(gateway)) {
            const version = configurationVersion(gateway);
            Object.assign(targetFilter, {
                code: 'monnify',
                adapterType: 'monnify',
                baseUrl: MONNIFY_BASE_URLS[gateway.environment],
                'metadata.customerFundingEligibility.status': 'eligible',
                'metadata.customerFundingEligibility.gatewayId': String(gateway._id),
                'metadata.customerFundingEligibility.environment': gateway.environment,
                'metadata.customerFundingEligibility.configurationVersion': version,
                ...(version === 0
                    ? {
                        $or: [
                            { virtualAccountMutationVersion: 0 },
                            { virtualAccountMutationVersion: { $exists: false } }
                        ]
                    }
                    : { virtualAccountMutationVersion: version })
            });
        }

        await this.updateMany(
            { isDefault: true },
            { $set: { isDefault: false } },
            { session }
        );
        const result = await this.updateOne(
            targetFilter,
            { $set: { isDefault: true } },
            { session }
        );

        if (Number(result.modifiedCount ?? result.nModified ?? result.matchedCount ?? 0) !== 1) {
            throw new Error(
                `Cannot set gateway ${gatewayId} as default: gateway changed or is no longer eligible`
            );
        }
        return result;
    };

    if (suppliedSession) return assignDefault();

    try {
        session.startTransaction();
        const result = await assignDefault();
        await session.commitTransaction();
        transactionFinished = true;
        return result;
    } catch (error) {
        if (!transactionFinished) {
            try { await session.abortTransaction(); } catch (_) {}
            transactionFinished = true;
        }
        throw error;
    } finally {
        if (!transactionFinished) {
            try { await session.abortTransaction(); } catch (_) {}
        }
        await session.endSession();
    }
};

module.exports = mongoose.model('PaymentGateway', paymentGatewaySchema);
