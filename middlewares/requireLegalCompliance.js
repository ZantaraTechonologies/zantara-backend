// requireLegalCompliance — Guard for protected financial/service actions.
//
// Placed AFTER verifyJWT. Uses legalDocument.service.getRequirements() (the
// single source of truth; frontends must never recompute reacceptance rules).
//
// Invariants enforced:
//   LEGAL-01: Mandatory legal documents are 'terms' and 'privacy'.
//   LEGAL-02 / LEGAL-03: If either mandatory document has no currently published
//             authoritative version, protected financial actions fail closed with
//             HTTP 503 LEGAL_SERVICE_UNAVAILABLE.
//   LEGAL-04: If mandatory documents are published but the user has not accepted
//             or needs re-acceptance, blocks with HTTP 428 LEGAL_ACCEPTANCE_REQUIRED.
//   LEGAL-05: If mandatory documents are published and current valid acceptance exists,
//             next() is called.
//   LEGAL-06: Database or service failures fail closed (never call next()).
//
// This middleware must ONLY be mounted on protected financial/service actions.
// It must NEVER be applied to login/logout, legal reads, requirements checks,
// acceptance submission, password/account recovery, support access,
// payment webhooks, or payment polling/verification routes.
const legalService = require('../services/legalDocument.service');

const requireLegalCompliance = async (req, res, next) => {
    try {
        const userId = req.user && req.user.id ? String(req.user.id) : null;
        if (!userId) return res.status(401).json({ message: 'Not authenticated' });

        const { missingAcceptances, documents, missingMandatoryDocuments } = await legalService.getRequirements({ userId });

        // LEGAL-02 / LEGAL-03: Fail closed with HTTP 503 if mandatory system legal configuration is absent
        if (Array.isArray(missingMandatoryDocuments) && missingMandatoryDocuments.length > 0) {
            return res.status(503).json({
                success: false,
                code: 'LEGAL_SERVICE_UNAVAILABLE',
                message: 'This action is temporarily unavailable. Please try again later.'
            });
        }

        // LEGAL-04: User lacks current required acceptance -> HTTP 428
        if (missingAcceptances.length > 0) {
            const required = documents.filter(d => missingAcceptances.includes(d.documentType));
            return res.status(428).json({
                success: false,
                code: 'LEGAL_ACCEPTANCE_REQUIRED',
                message: 'Current legal acceptance is required before this action can continue.',
                data: { requirements: required }
            });
        }

        next();
    } catch (e) {
        next(e);
    }
};

module.exports = requireLegalCompliance;