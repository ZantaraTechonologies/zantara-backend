const mongoose = require('mongoose')

const ALLOWED_ROLES = ['user', 'admin', 'superAdmin']; // extend anytime

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
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    accountType: { type: String, enum: ['retail', 'reseller'], default: 'retail' },
    status: { type: Boolean, default: false },
    referrerCode: String,
    myReferralCode: String,
    totalReferralBonus: { type: Number, default: 0 },
    referralBalance: { type: Number, default: 0 },
    resellerEarnings: { type: Number, default: 0 },
    transactionPin: { type: String, select: false }, // Hashed PIN
    isPinSet: { type: Boolean, default: false },
    kycLevel: { type: Number, default: 1 }, // Tier 1, 2, 3
    otp: { type: String, select: false },
    otpExpires: Date,
    isPhoneVerified: { type: Boolean, default: false },
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

module.exports = userModel