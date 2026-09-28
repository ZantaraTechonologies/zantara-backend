const mongoose = require('mongoose');
const { isSafeIdentifierPattern } = require('../utils/broadbandInputPolicy');

const identifierPolicySchema = new mongoose.Schema({
    label: {
        type: String,
        required: true,
        trim: true,
        maxlength: 80
    },
    kind: {
        type: String,
        enum: ['text', 'phone', 'numeric', 'email'],
        default: 'text'
    },
    placeholder: {
        type: String,
        trim: true,
        maxlength: 120
    },
    pattern: {
        type: String,
        trim: true,
        maxlength: 256,
        validate: {
            validator(value) {
                return !value || isSafeIdentifierPattern(value);
            },
            message: 'Identifier pattern contains unsupported or unsafe regular expression syntax'
        }
    },
    minLength: {
        type: Number,
        min: 1,
        max: 256
    },
    maxLength: {
        type: Number,
        min: 1,
        max: 256,
        validate: {
            validator(value) {
                return value == null || this.minLength == null || value >= this.minLength;
            },
            message: 'Identifier maxLength must be greater than or equal to minLength'
        }
    },
    normalization: {
        type: String,
        enum: ['none', 'trim', 'lowercase', 'uppercase', 'digits_only'],
        default: 'trim'
    }
}, { _id: false });

const verificationPolicySchema = new mongoose.Schema({
    mode: {
        type: String,
        enum: ['none', 'optional', 'required'],
        required: true
    },
    evidenceRequired: {
        type: Boolean,
        default: false,
        validate: {
            validator(value) {
                return !value || this.mode === 'required';
            },
            message: 'Verification evidence can only be required when verification mode is required'
        }
    },
    ttlSeconds: {
        type: Number,
        min: 30,
        max: 1800,
        default: 300
    }
}, { _id: false });

const amountPolicySchema = new mongoose.Schema({
    min: {
        type: Number,
        required: true,
        min: 0.01
    },
    max: {
        type: Number,
        required: true,
        min: 0,
        validate: {
            validator(value) {
                return this.min == null || value >= this.min;
            },
            message: 'Amount max must be greater than or equal to min'
        }
    },
    step: {
        type: Number,
        min: 0.01,
        default: 1
    },
    currency: {
        type: String,
        trim: true,
        uppercase: true,
        enum: ['NGN'],
        default: 'NGN'
    }
}, { _id: false });

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
    suggestedRetailPrice: {
        type: Number
    },
    purchaseMode: {
        type: String,
        enum: ['plan', 'amount']
    },
    identifierPolicy: {
        type: identifierPolicySchema,
        required() {
            return Boolean(this.purchaseMode);
        }
    },
    verificationPolicy: {
        type: verificationPolicySchema,
        required() {
            return Boolean(this.purchaseMode);
        }
    },
    amountPolicy: {
        type: amountPolicySchema,
        required() {
            return this.purchaseMode === 'amount';
        }
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
