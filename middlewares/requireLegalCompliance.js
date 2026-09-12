// requireLegalCompliance — Phase 2 guard for protected financial/service actions.
//
// Placed AFTER verifyJWT. Uses legalDocument.service.getRequirements() (the
// single source of truth; frontends must never recompute reacceptance rules).
// Blocks the action with HTTP 428 + LEGAL_ACCEPTANCE_REQUIRED until the user
// has accepted the current non-informational legal documents.
//
// This middleware must ONLY be mounted on protected financial/service actions.
// It must NEVER be applied to login/logout, legal reads, requirements checks,
// acceptance submission, password/account recovery, support access or
// privacy/account-closure routes.
const legalService = require('../services/legalDocument.service');

const requireLegalCompliance = async (req, res, next) => {
    try {
        const userId = req.user && req.user.id ? String(req.user.id) : null;
        if (!userId) return res.status(401).json({ message: 'Not authenticated' });

        const { missingAcceptances, documents } = await legalService.getRequirements({ userId });
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