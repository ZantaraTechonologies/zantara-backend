const express = require('express');
const router = express.Router();
const { payment, generateVirtualAccounts } = require('../controllers/monnifyController');
const { verifyJWT } = require('../middlewares/auth');
const requireLegalCompliance = require('../middlewares/requireLegalCompliance');

// POST /api/monnify/initialize
router.post('/initialize', verifyJWT, requireLegalCompliance, payment);

// POST /api/monnify/generate-virtual-accounts
router.post('/generate-virtual-accounts', verifyJWT, requireLegalCompliance, generateVirtualAccounts);

module.exports = router;
