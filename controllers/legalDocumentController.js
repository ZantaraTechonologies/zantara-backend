const LegalAcceptance = require('../models/LegalAcceptance');
const legalService = require('../services/legalDocument.service');
const auditController = require('./auditController');

const handleError = (res, e) => {
    const status = (e && typeof e.status === 'number') ? e.status : 500;
    res.status(status).json({
        success: false,
        message: (e && e.message) || 'Server error',
        ...(e && e.code ? { code: e.code } : {})
    });
};

const adminActor = (req) => ({
    adminId: req.user?._id || req.user?.id,
    operatorName: req.user?.name || req.user?.email || 'SuperAdmin'
});

exports.getPublicDocuments = async (req, res) => {
    try {
        const data = await legalService.getCurrentDocuments();
        res.json({ success: true, data });
    } catch (e) {
        handleError(res, e);
    }
};

exports.getCurrentDocuments = exports.getPublicDocuments;

exports.getCurrentByType = async (req, res) => {
    try {
        const data = await legalService.getCurrentByType(req.params.type);
        res.json({ success: true, data });
    } catch (e) {
        handleError(res, e);
    }
};

exports.getRequirements = async (req, res) => {
    try {
        const userId = req.user && req.user.id ? req.user.id : null;
        const data = await legalService.getRequirements({ userId });
        res.json({ success: true, data });
    } catch (e) {
        handleError(res, e);
    }
};

exports.getMyAcceptances = async (req, res) => {
    try {
        const userId = String(req.user.id);
        const records = await LegalAcceptance.find({ userId })
            .sort({ acceptedAt: -1 })
            .select('-ipAddress -userAgent');
        res.json({ success: true, data: records });
    } catch (e) {
        handleError(res, e);
    }
};

exports.acceptDocument = async (req, res) => {
    try {
        const userId = String(req.user.id);
        const { documentType, version, contentHash, channel } = req.body || {};
        const record = await legalService.recordAcceptance({
            userId,
            documentType,
            version,
            contentHash,
            channel: channel || 'web',
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });
        const requirements = await legalService.getRequirements({ userId });
        res.json({ success: true, data: { record, requirements } });
    } catch (e) {
        handleError(res, e);
    }
};

// ── SuperAdmin legal-document management ────────────────────────────────
exports.adminListDocuments = async (req, res) => {
    try {
        const data = await legalService.getAllDocuments();
        res.json({ success: true, data });
    } catch (e) {
        handleError(res, e);
    }
};

// Full document (incl sourceMarkdown + contentHtml) for preview/edit. Internal only.
exports.adminGetDocument = async (req, res) => {
    try {
        const data = await legalService.getDocumentById(req.params.id);
        res.json({ success: true, data });
    } catch (e) {
        handleError(res, e);
    }
};

exports.adminCreateDraft = async (req, res) => {
    try {
        const { documentType, title, sourceMarkdown, changeSummary, acceptanceMode, requiresReacceptance } = req.body || {};
        const data = await legalService.createDraft({
            documentType,
            title,
            sourceMarkdown: sourceMarkdown || '',
            changeSummary: changeSummary || '',
            acceptanceMode,
            requiresReacceptance: !!requiresReacceptance,
            createdBy: req.user?._id || req.user?.id
        });
        const { adminId, operatorName } = adminActor(req);
        await auditController.logAction(
            adminId, operatorName, 'LEGAL_DOCUMENT_CREATED',
            `Legal draft created: ${data.documentType} (${data.title})`,
            { documentId: data._id, documentType: data.documentType, title: data.title, status: data.status }, 'success', req
        );
        res.json({ success: true, data });
    } catch (e) {
        handleError(res, e);
    }
};

exports.adminUpdateDraft = async (req, res) => {
    try {
        const data = await legalService.updateDraft(req.params.id, req.body || {});
        const { adminId, operatorName } = adminActor(req);
        await auditController.logAction(
            adminId, operatorName, 'LEGAL_DOCUMENT_UPDATED',
            `Legal draft updated: ${data.documentType} (${data.title})`,
            { documentId: data._id, documentType: data.documentType, title: data.title, status: data.status }, 'success', req
        );
        res.json({ success: true, data });
    } catch (e) {
        handleError(res, e);
    }
};

exports.adminPublishDocument = async (req, res) => {
    try {
        const data = await legalService.publish(req.params.id, { publishedBy: req.user?._id || req.user?.id });
        const { adminId, operatorName } = adminActor(req);
        await auditController.logAction(
            adminId, operatorName, 'LEGAL_DOCUMENT_PUBLISHED',
            `Legal doc published: ${data.documentType} v${data.version}`,
            {
                documentId: data._id, documentType: data.documentType, version: data.version, title: data.title,
                acceptanceMode: data.acceptanceMode, requiresReacceptance: data.requiresReacceptance
            }, 'success', req
        );
        res.json({ success: true, data });
    } catch (e) {
        handleError(res, e);
    }
};

exports.adminArchiveDocument = async (req, res) => {
    try {
        const data = await legalService.archive(req.params.id);
        const { adminId, operatorName } = adminActor(req);
        await auditController.logAction(
            adminId, operatorName, 'LEGAL_DOCUMENT_ARCHIVED',
            `Legal doc archived: ${data.documentType} v${data.version}`,
            { documentId: data._id, documentType: data.documentType, version: data.version, title: data.title }, 'success', req
        );
        res.json({ success: true, data });
    } catch (e) {
        handleError(res, e);
    }
};