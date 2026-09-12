const mongoose = require('mongoose');
const LegalDocument = require('../models/LegalDocument');
const LegalAcceptance = require('../models/LegalAcceptance');
const { DOCUMENT_TYPES, ACCEPTANCE_MODES } = require('../models/LegalDocument');
const { markdownToHtml, computeHash } = require('../utils/legalHtml');

function httpError(status, code, message) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    return e;
}

// Publish-ordered current doc snapshot for public consumption.
// Exposes ONLY the authoritative render + acceptance metadata:
// documentType, title, version, sanitized contentHtml, contentHash,
// effectiveDate, acceptanceMode, requiresAcceptance, requiresReacceptance.
// sourceMarkdown, drafts, archived history and internal publication fields
// are deliberately never serialized here.
const serializeCurrent = (d) => ({
    documentType: d.documentType,
    title: d.title,
    version: d.version,
    contentHtml: d.contentHtml,
    contentHash: d.contentHash,
    effectiveDate: d.effectiveDate,
    acceptanceMode: d.acceptanceMode,
    requiresAcceptance: d.acceptanceMode !== 'none',
    requiresReacceptance: d.requiresReacceptance
});

class LegalDocumentService {

    // ── read helpers ──────────────────────────────────────────────────────

    async getCurrentDocuments() {
        const docs = await LegalDocument.find({ status: 'published', isPublic: true }).sort({ documentType: 1 });
        return docs.map(serializeCurrent);
    }

    async getCurrentByType(documentType) {
        if (!DOCUMENT_TYPES.includes(documentType)) {
            throw httpError(404, 'DOCUMENT_TYPE_UNKNOWN', `Unknown document type: ${documentType}`);
        }
        const doc = await LegalDocument.findOne({ documentType, status: 'published', isPublic: true });
        if (!doc) throw httpError(404, 'DOCUMENT_NOT_PUBLISHED', `No current published version for ${documentType}`);
        return serializeCurrent(doc);
    }

    // ── admin (internal) helpers ────────────────────────────────────────

    // Metadata-only index of every document (draft/published/archived) for the
    // SuperAdmin legal management UI. Never carries sourceMarkdown/contentHtml.
    async getAllDocuments() {
        const docs = await LegalDocument.find({})
            .sort({ documentType: 1, status: 1, version: -1 });
        return docs.map(d => ({
            id: d._id,
            documentType: d.documentType,
            title: d.title,
            version: d.version,
            status: d.status,
            acceptanceMode: d.acceptanceMode,
            requiresAcceptance: d.acceptanceMode !== 'none',
            requiresReacceptance: d.requiresReacceptance,
            isPublic: d.isPublic,
            changeSummary: d.changeSummary,
            effectiveDate: d.effectiveDate,
            publishedAt: d.publishedAt,
            archivedAt: d.archivedAt,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
            _createdBy: d.createdBy,
            _publishedBy: d.publishedBy
        }));
    }

    // Full document (including sourceMarkdown + contentHtml) for preview/edit.
    // Internal-only; consumed by SuperAdmin endpoints.
    async getDocumentById(id) {
        if (!id) throw httpError(400, 'ID_REQUIRED', 'Document id is required');
        const doc = await LegalDocument.findById(id);
        if (!doc) throw httpError(404, 'DOC_NOT_FOUND', 'Legal document not found');
        return doc;
    }

    async getRequirements({ userId = null } = {}) {
        const currentDocs = await this.getCurrentDocuments();

        // Helper: latest acceptance for a (userId, documentType).
        const latestAcceptance = async (type) => {
            if (!userId) return null;
            const r = await LegalAcceptance.findOne({ userId, documentType: type })
                .sort({ version: -1 })
                .lean();
            return r;
        };

        const missingAcceptances = [];
        let anyPendingReacceptance = false;

        const documents = await Promise.all(currentDocs.map(async (doc) => {
            const latest = await latestAcceptance(doc.documentType);
            const accepted = !!latest;
            const acceptedVersion = latest ? latest.version : null;
            let acceptanceRequired = false;
            let pendingReacceptance = false;

            if (doc.requiresAcceptance) {
                if (!latest) {
                    // Never accepted any version -> required.
                    acceptanceRequired = true;
                } else if (latest.version < doc.version && doc.requiresReacceptance) {
                    // Accepted an earlier version; material update requires re-acceptance.
                    acceptanceRequired = true;
                    pendingReacceptance = true;
                } else if (latest.version < doc.version && !doc.requiresReacceptance) {
                    // Accepted an earlier version; minor update -> prior valid acceptance stands.
                    acceptanceRequired = false;
                    pendingReacceptance = false;
                } else {
                    // Accepted the current version.
                    acceptanceRequired = false;
                }
            }

            if (acceptanceRequired) missingAcceptances.push(doc.documentType);
            if (pendingReacceptance) anyPendingReacceptance = true;

            return {
                ...doc,
                acceptanceRequired,
                pendingReacceptance,
                acceptance: accepted
                    ? { accepted, acceptedVersion, acceptedAt: latest.acceptedAt, acceptanceType: latest.acceptanceType }
                    : { accepted: false, acceptedVersion: null, acceptedAt: null, acceptanceType: null }
            };
        }));

        return {
            documents,
            pendingReacceptance: anyPendingReacceptance,
            missingAcceptances
        };
    }

    // ── acceptance (append-only) ──────────────────────────────────────────

    async recordAcceptance({ userId, documentType, version, contentHash, channel = 'web', ipAddress, userAgent }) {
        if (!userId) throw httpError(401, 'UNAUTHENTICATED', 'Authentication is required');
        if (!DOCUMENT_TYPES.includes(documentType)) {
            throw httpError(404, 'DOCUMENT_TYPE_UNKNOWN', `Unknown document type: ${documentType}`);
        }
        if (!LegalAcceptance.ACCEPTANCE_CHANNELS.includes(channel)) {
            throw httpError(400, 'INVALID_CHANNEL', `Invalid channel: ${channel}`);
        }

        const current = await LegalDocument.findOne({ documentType, status: 'published', isPublic: true });
        if (!current) throw httpError(404, 'DOCUMENT_NOT_PUBLISHED', 'No current published version to accept');
        if (current.acceptanceMode === 'none') {
            throw httpError(400, 'ACCEPTANCE_NOT_REQUIRED', 'This document is informational only and does not require acceptance');
        }

        const incomingVersion = Number(version);
        if (Number.isNaN(incomingVersion) || incomingVersion !== current.version) {
            throw httpError(409, 'STALE_VERSION', 'The supplied version is not the current published version');
        }

        const expectedHash = computeHash(current.contentHtml); // recompute from canonical content
        // Client supplies the canonical contentHash at submission time (must match what we'd recompute).
        if (!contentHash || contentHash !== expectedHash) {
            throw httpError(409, 'CONTENT_HASH_MISMATCH', 'The supplied content hash does not match the current published document');
        }

        // Derive acceptanceType from document, NOT from client body.
        const acceptanceType = current.acceptanceMode;

        try {
            const record = await LegalAcceptance.create({
                userId,
                documentId: current._id,
                documentType,
                version: current.version,
                channel,
                acceptanceType,
                contentHash,
                ipAddress,
                userAgent
            });
            return record;
        } catch (error) {
            if (error.code === 11000) {
                // Already accepted this version (idempotent) -> return the existing record.
                return LegalAcceptance.findOne({ userId, documentType, version: current.version });
            }
            throw error;
        }
    }

    // ── signup enforcement (server-side) ─────────────────────────────────
    //
    // Validates the client-submitted legal acceptance payload against the
    // then-current published versions, and normalizes it into the rows that
    // must be written atomically with the new user. The client may submit
    // only {documentType, version, contentHash, channel}; documentId and
    // acceptanceType are ALWAYS derived here from the current published doc,
    // never trusted from the client.
    async validateSignupAcceptances(items = []) {
        if (!Array.isArray(items) || items.length === 0) {
            throw httpError(400, 'LEGAL_ACCEPTANCE_REQUIRED',
                'Registration requires acceptance of the current Terms of Service and Privacy Policy');
        }

        const current = {};
        for (const t of DOCUMENT_TYPES) {
            const doc = await LegalDocument.findOne({ documentType: t, status: 'published', isPublic: true }).lean();
            if (doc) current[t] = doc;
        }

        // Required set = published docs that are not informational ('none').
        // Terms=agreement, Privacy=acknowledgement, Refund/Complaints=none.
        const required = DOCUMENT_TYPES.filter(t => current[t] && current[t].acceptanceMode !== 'none');
        const missing = required.filter(t => !items.some(i => i && i.documentType === t));
        if (missing.length) {
            const e = httpError(400, 'LEGAL_ACCEPTANCE_REQUIRED',
                'Registration requires acceptance of the current Terms of Service and Privacy Policy');
            e.details = { missing };
            throw e;
        }

        const rows = [];
        for (const item of items) {
            if (!item || !DOCUMENT_TYPES.includes(item.documentType)) {
                throw httpError(400, 'INVALID_DOCUMENT_TYPE',
                    `Unknown document type: ${item && item.documentType}`);
            }
            const cur = current[item.documentType];
            if (!cur) throw httpError(400, 'DOCUMENT_NOT_PUBLISHED',
                `No current published version for ${item.documentType}`);
            if (cur.acceptanceMode === 'none') continue; // informational -> no acceptance row

            const incomingVersion = Number(item.version);
            if (Number.isNaN(incomingVersion) || incomingVersion !== cur.version) {
                throw httpError(409, 'STALE_VERSION', 'The supplied version is not the current published version');
            }
            const expectedHash = computeHash(cur.contentHtml);
            if (!item.contentHash || item.contentHash !== expectedHash) {
                throw httpError(409, 'CONTENT_HASH_MISMATCH',
                    'The supplied content hash does not match the current published document');
            }

            rows.push({
                documentId: cur._id,
                documentType: cur.documentType,
                version: cur.version,
                channel: LegalAcceptance.ACCEPTANCE_CHANNELS.includes(item.channel) ? item.channel : 'web',
                acceptanceType: cur.acceptanceMode,
                contentHash: expectedHash
            });
        }
        return rows;
    }

    // ── draft/publish lifecycle ───────────────────────────────────────────

    async createDraft({ documentType, title, sourceMarkdown = '', changeSummary = '', acceptanceMode = 'none', requiresReacceptance = false, createdBy }) {
        if (!DOCUMENT_TYPES.includes(documentType)) {
            throw httpError(400, 'INVALID_DOCUMENT_TYPE', `Unknown document type: ${documentType}`);
        }
        if (!title) throw httpError(400, 'TITLE_REQUIRED', 'Document title is required');
        if (!createdBy) throw httpError(400, 'CREATED_BY_REQUIRED', 'createdBy actor is required');
        if (!ACCEPTANCE_MODES.includes(acceptanceMode)) {
            throw httpError(400, 'INVALID_ACCEPTANCE_MODE', `Invalid acceptanceMode: ${acceptanceMode}`);
        }

        const contentHtml = markdownToHtml(sourceMarkdown);

        const doc = await LegalDocument.create({
            documentType,
            title,
            version: null,
            sourceMarkdown,
            contentHtml,
            status: 'draft',
            acceptanceMode,
            requiresReacceptance,
            isPublic: true,
            changeSummary,
            createdBy
        });
        return doc;
    }

    async updateDraft(id, patch) {
        if (!id) throw httpError(400, 'ID_REQUIRED', 'Document id is required');

        const doc = await LegalDocument.findById(id);
        if (!doc) throw httpError(404, 'DOC_NOT_FOUND', 'Legal document not found');
        if (doc.status !== 'draft') throw httpError(409, 'IMMUTABLE', 'Only drafts can be edited');

        const { title, sourceMarkdown, changeSummary, acceptanceMode, requiresReacceptance, isPublic } = patch || {};

        if (title !== undefined) doc.title = title;
        if (sourceMarkdown !== undefined) {
            doc.sourceMarkdown = sourceMarkdown;
            doc.contentHtml = markdownToHtml(sourceMarkdown);
        }
        if (changeSummary !== undefined) doc.changeSummary = changeSummary;
        if (acceptanceMode !== undefined) {
            if (!ACCEPTANCE_MODES.includes(acceptanceMode)) {
                throw httpError(400, 'INVALID_ACCEPTANCE_MODE', `Invalid acceptanceMode: ${acceptanceMode}`);
            }
            doc.acceptanceMode = acceptanceMode;
        }
        if (requiresReacceptance !== undefined) doc.requiresReacceptance = !!requiresReacceptance;
        if (isPublic !== undefined) doc.isPublic = !!isPublic;

        await doc.save();
        return doc;
    }

    // Publish draft -> archived prior (atomic transaction).
    async publish(id, { publishedBy } = {}) {
        const session = await mongoose.startSession();
        let doc;
        try {
            session.startTransaction();
            doc = await LegalDocument.findById(id).session(session);
            if (!doc) throw httpError(404, 'DOC_NOT_FOUND', 'Legal document not found');
            if (doc.status !== 'draft') throw httpError(409, 'NOT_A_DRAFT', 'Only drafts can be published');

            const prior = await LegalDocument.findOne({
                documentType: doc.documentType,
                status: 'published'
            }).session(session);

            const lastVersionDoc = await LegalDocument.findOne({
                documentType: doc.documentType,
                status: { $in: ['published', 'archived'] }
            }).sort({ version: -1 }).session(session);

            if (prior) {
                prior.status = 'archived';
                prior.archivedAt = new Date();
                await prior.save({ session });
            }

            doc.version = (lastVersionDoc && lastVersionDoc.version) ? lastVersionDoc.version + 1 : 1;
            doc.contentHash = computeHash(doc.contentHtml);
            doc.status = 'published';
            doc.publishedAt = new Date();
            doc.effectiveDate = new Date();
            doc.publishedBy = publishedBy || doc.createdBy;
            await doc.save({ session });

            await session.commitTransaction();
            return doc;
        } catch (error) {
            try { await session.abortTransaction(); } catch (_) {}
            if (error && error.code === 11000) {
                throw httpError(409, 'DUPLICATE_PUBLISHED', 'A published version of this document type already exists');
            }
            throw error;
        } finally {
            session.endSession();
        }
    }

    // Standalone archive is forbidden for mandatory (requiresAcceptance) documents.
    // They must be replaced via publish().
    async archive(id) {
        if (!id) throw httpError(400, 'ID_REQUIRED', 'Document id is required');
        const doc = await LegalDocument.findById(id);
        if (!doc) throw httpError(404, 'DOC_NOT_FOUND', 'Legal document not found');
        if (doc.status !== 'published') throw httpError(409, 'NOT_PUBLISHED', 'Only published documents can be archived');
        if (doc.acceptanceMode !== 'none') {
            throw httpError(409, 'MANDATORY_DOCUMENT', 'A mandatory document cannot be archived in isolation; publish a replacement version via publish() instead');
        }
        doc.status = 'archived';
        doc.archivedAt = new Date();
        await doc.save();
        return doc;
    }
}

module.exports = new LegalDocumentService();