const mongoose = require('mongoose');
const Wallet = require('./Wallet');

const ALLOWED_ROLES = ['user', 'agent', 'admin', 'superAdmin', 'shareholder']; // extend anytime

const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, sparse: true, unique: true }, // Optional but must be unique if provided
    phone: { type: String, unique: true, required: true }, // Primary identifier
    password: { type: String, select: false },
    passwordHistory: { type: [String], select: false }, // Store last 5 hashed passwords
    authVersion: { type: Number, default: 0, min: 0 },
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
    totalReferralBonus: { type: Number, default: 0 },
    referralBalance: { type: Number, default: 0 },
    firstFundingBonusProcessed: { type: Boolean, default: false },
    resellerEarnings: { type: Number, default: 0 },
    // Investment / Shareholder Fields
    isShareholder: { type: Boolean, default: false },
    sharesOwned: { type: Number, default: 0, min: 0 },
    dividendBalance: { type: Number, default: 0, min: 0 },     // Investment Wallet
    totalDividendsEarned: { type: Number, default: 0 },        // Lifetime dividend tracker
    firstSharePurchasedAt: { type: Date, default: null },      // For lock period calculation
    frozenShares: { type: Number, default: 0 },                // Shares locked in a pending exit request
    transactionPin: { type: String, select: false }, // Hashed PIN
    pinHistory: { type: [String], select: false }, // Store last 5 hashed PINs
    isPinSet: { type: Boolean, default: false },
    kycLevel: { type: Number, default: 1 }, // Tier 1, 2, 3
    otp: { type: String, select: false },
    otpExpires: Date,
    phoneVerificationChallengeId: { type: String, select: false },
    phoneVerificationOtpDigest: { type: String, select: false },
    phoneVerificationPhone: { type: String, select: false },
    phoneVerificationExpiresAt: { type: Date, select: false },
    phoneVerificationAttempts: { type: Number, select: false, min: 0 },
    phoneVerificationRequestedAt: { type: Date, select: false },
    passwordResetChallengeId: { type: String, select: false },
    passwordResetOtpDigest: { type: String, select: false },
    passwordResetExpiresAt: { type: Date, select: false },
    passwordResetAttempts: { type: Number, select: false, min: 0 },
    passwordResetRequestedAt: { type: Date, select: false },
    passwordResetConsumedAt: { type: Date, select: false },
    passwordResetTokenDigest: { type: String, select: false },
    passwordResetTokenExpiresAt: { type: Date, select: false },
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
    }],
    lastLogin: { type: Date, default: Date.now },
    pushToken: { type: String, default: null } // Expo Push Token for push notifications
}, { timestamps: true })

userSchema.post('findOneAndDelete', async function (doc) {
    if (doc) {
        await Wallet.deleteOne({ userId: doc._id })
    }
})

const userModel = mongoose.model('User', userSchema)
userModel.ALLOWED_ROLES = ALLOWED_ROLES;
module.exports = userModel