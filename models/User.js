const mongoose = require('mongoose');
const Wallet = require('./Wallet');

const ALLOWED_ROLES = ['user', 'agent', 'admin', 'superAdmin']; // extend anytime

const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, sparse: true, unique: true }, // Optional but must be unique if provided
    phone: { type: String, unique: true, required: true }, // Primary identifier
    password: String,
    roles: {
        type: [String],
        enum: ALLOWED_ROLES,
        default: ['user'],
        index: true,
    },
    role: { type: String, enum: ALLOWED_ROLES, default: 'user' },
    accountType: { type: String, enum: ['retail', 'reseller'], default: 'retail' },
    status: { type: Boolean, default: false },
    referrerCode: String,
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    myReferralCode: String,
    commissionRate: { type: Number, min: 0, max: 0.1 },
    agentDiscountRate: { type: Number, min: 0, max: 0.5 },
    totalReferralBonus: { type: Number, default: 0 },
    referralBalance: { type: Number, default: 0 },
    resellerEarnings: { type: Number, default: 0 },
    transactionPin: { type: String, select: false }, // Hashed PIN
    isPinSet: { type: Boolean, default: false },
    kycLevel: { type: Number, default: 1 }, // Tier 1, 2, 3
    otp: { type: String, select: false },
    otpExpires: Date,
    isPhoneVerified: { type: Boolean, default: false },
    isEmailVerified: { type: Boolean, default: false },
    emailOtp: { type: String, select: false },
    emailOtpExpires: Date,
    linkedAccounts: [{
        bankName: String,
        bankCode: String,
        accountName: String,
        accountNumber: String,
        isDefault: { type: Boolean, default: false }
    }],
    virtualAccounts: [{
        bankName: String,
        accountName: String,
        accountNumber: String
    }]
}, { timestamps: true })

userSchema.post('findOneAndDelete', async function (doc) {
    if (doc) {
        await Wallet.deleteOne({ userId: doc._id })
    }
})

const userModel = mongoose.model('User', userSchema)
userModel.ALLOWED_ROLES = ALLOWED_ROLES;
module.exports = userModel