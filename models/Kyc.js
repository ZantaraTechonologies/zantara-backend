const mongoose = require('mongoose');

const kycSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tier: { type: Number, enum: [1, 2, 3], default: 1 },
    documentType: { type: String }, // Flexible for various ID/Bill types
    documentNumber: String,
    address: String, // For Tier 3 verification
    documentImage: { type: String, select: false }, // Legacy public URL; never expose from new reads.
    documentPublicId: { type: String, select: false },
    documentResourceType: { type: String, select: false },
    documentDeliveryType: { type: String, select: false },
    documentFormat: { type: String, select: false },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    rejectionReason: String,
    verifiedAt: Date,
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, autoIndex: false });

// Installed explicitly by the KYC pending-index migration.
kycSchema.index(
    { userId: 1, status: 1 },
    {
        unique: true,
        partialFilterExpression: { status: 'pending' },
        name: 'uniq_pending_kyc_per_user'
    }
);

const Kyc = mongoose.model('Kyc', kycSchema);

module.exports = Kyc;
