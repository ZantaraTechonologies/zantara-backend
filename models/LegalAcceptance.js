const mongoose = require('mongoose');

const ACCEPTANCE_CHANNELS = ['web', 'android', 'ios', 'admin_assisted'];
// Derived server-side from LegalDocument.acceptanceMode.
// Clients NEVER supply acceptanceType.
const ACCEPTANCE_TYPES = ['agreement', 'acknowledgement'];

const legalAcceptanceSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalDocument', required: true },
    documentType: { type: String, required: true, index: true },
    version: { type: Number, required: true }, // snapshot of the accepted version
    acceptedAt: { type: Date, default: Date.now },
    channel: { type: String, enum: ACCEPTANCE_CHANNELS, default: 'web' },
    acceptanceType: { type: String, enum: ACCEPTANCE_TYPES, required: true },
    contentHash: { type: String, required: true }, // snapshot of the exact accepted content
    ipAddress: { type: String, select: false },
    userAgent: { type: String, select: false }
}, { timestamps: true });

// Append-only: one acceptance per user per document version (idempotent insert).
legalAcceptanceSchema.index({ userId: 1, documentType: 1, version: 1 }, { unique: true });
legalAcceptanceSchema.index({ userId: 1, documentType: 1 });
legalAcceptanceSchema.index({ documentType: 1, version: 1, acceptedAt: 1 });

const legalAcceptanceModel = mongoose.model('LegalAcceptance', legalAcceptanceSchema);
legalAcceptanceModel.ACCEPTANCE_CHANNELS = ACCEPTANCE_CHANNELS;
legalAcceptanceModel.ACCEPTANCE_TYPES = ACCEPTANCE_TYPES;
module.exports = legalAcceptanceModel;