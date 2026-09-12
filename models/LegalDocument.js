const mongoose = require('mongoose');

const DOCUMENT_TYPES = ['terms', 'privacy', 'refund_complaints'];
const DOCUMENT_STATUS = ['draft', 'published', 'archived'];
const ACCEPTANCE_MODES = ['agreement', 'acknowledgement', 'none'];

const legalDocumentSchema = new mongoose.Schema({
    documentType: { type: String, enum: DOCUMENT_TYPES, required: true, index: true },
    title: { type: String, required: true },
    // Version is assigned AT PUBLISH TIME. Drafts carry no version.
    version: { type: Number, default: null },
    sourceMarkdown: { type: String, default: '' },
    contentHtml: { type: String, required: true },
    contentHash: {
        type: String,
        default: null,
        required: function () { return this.status === 'published'; }
    },
    // How the document is accepted:
    //   agreement      -> active signature-style agreement
    //   acknowledgement-> informed acknowledgement
    //   none           -> informational only, no acceptance required
    acceptanceMode: { type: String, enum: ACCEPTANCE_MODES, default: 'none' },
    // Whether EXISTING users who accepted an earlier version must
    // accept the (newer) current version again.
    requiresReacceptance: { type: Boolean, default: false },
    status: { type: String, enum: DOCUMENT_STATUS, default: 'draft', index: true },
    effectiveDate: { type: Date, default: Date.now },
    publishedAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    isPublic: { type: Boolean, default: true },
    changeSummary: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

// Derived flag: a document requires acceptance unless it is informational.
legalDocumentSchema.virtual('requiresAcceptance').get(function () {
    return this.acceptanceMode !== 'none';
});

// DB-level guarantee: only ONE published (current) version per documentType.
legalDocumentSchema.index(
    { documentType: 1, status: 1 },
    { unique: true, partialFilterExpression: { status: 'published' } }
);
legalDocumentSchema.index({ documentType: 1, version: -1 });

const legalDocumentModel = mongoose.model('LegalDocument', legalDocumentSchema);
legalDocumentModel.DOCUMENT_TYPES = DOCUMENT_TYPES;
legalDocumentModel.DOCUMENT_STATUS = DOCUMENT_STATUS;
legalDocumentModel.ACCEPTANCE_MODES = ACCEPTANCE_MODES;
module.exports = legalDocumentModel;