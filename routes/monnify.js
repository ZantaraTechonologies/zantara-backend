const express = require('express');
const router = express.Router();
const { payment, generateVirtualAccounts } = require('../controllers/monnifyController');
const { verifyJWT } = require('../middlewares/auth');
const requireLegalCompliance = require('../middlewares/requireLegalCompliance');
const requireOnboardingComplete = require('../middlewares/requireOnboardingComplete');

// POST /api/monnify/initialize
router.post('/initialize', verifyJWT, requireOnboardingComplete, requireLegalCompliance, payment);

// POST /api/monnify/generate-virtual-accounts
router.post('/generate-virtual-accounts', verifyJWT, requireOnboardingComplete, requireLegalCompliance, generateVirtualAccounts);

module.exports = router;
