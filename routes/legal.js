const express = require('express');
const router = express.Router();
const { verifyJWT, verifyJWTOptional, checkRoles } = require('../middlewares/auth');
const legalController = require('../controllers/legalDocumentController');

// Public
router.get('/documents', legalController.getPublicDocuments);
router.get('/documents/current', legalController.getCurrentDocuments);
router.get('/documents/:type/current', legalController.getCurrentByType);
// Optional auth: anonymous returns signup-required set; authed adds per-user status.
// verifyJWTOptional populates req.user when a valid token is present WITHOUT ever
// blocking — this route must remain reachable before acceptance is resolved.
router.get('/requirements', verifyJWTOptional, legalController.getRequirements);

// Authenticated user
router.get('/acceptance/mine', verifyJWT, legalController.getMyAcceptances);
router.post('/acceptance', verifyJWT, legalController.acceptDocument);

// SuperAdmin legal-document management (internal; never mounted on user routes)
router.get('/admin/documents', verifyJWT, checkRoles('superAdmin'), legalController.adminListDocuments);
router.get('/admin/documents/:id', verifyJWT, checkRoles('superAdmin'), legalController.adminGetDocument);
router.post('/admin/documents', verifyJWT, checkRoles('superAdmin'), legalController.adminCreateDraft);
router.put('/admin/documents/:id', verifyJWT, checkRoles('superAdmin'), legalController.adminUpdateDraft);
router.post('/admin/documents/:id/publish', verifyJWT, checkRoles('superAdmin'), legalController.adminPublishDocument);
router.post('/admin/documents/:id/archive', verifyJWT, checkRoles('superAdmin'), legalController.adminArchiveDocument);

module.exports = router;