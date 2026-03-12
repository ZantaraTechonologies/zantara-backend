const mongoose = require('mongoose');

const kycSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tier: { type: Number, enum: [1, 2, 3], default: 1 },
    documentType: { type: String, enum: ['NIN', 'BVN', 'Passport', 'License', 'Other'] },
    documentNumber: String,
    documentImage: String, // URL/Path to uploaded image
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    rejectionReason: String,
    verifiedAt: Date,
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

const Kyc = mongoose.model('Kyc', kycSchema);

module.exports = Kyc;
