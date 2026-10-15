const express = require('express');
const router = express.Router();
const { payment } = require('../controllers/flutterwaveController');
const { verifyJWT } = require('../middlewares/auth');
const requireLegalCompliance = require('../middlewares/requireLegalCompliance');
const requireOnboardingComplete = require('../middlewares/requireOnboardingComplete');

// POST /api/flutterwave/initialize — initiates customer wallet-funding payment
// (guarded financial action: legal acceptance required before funding initiation).
router.post('/initialize', verifyJWT, requireOnboardingComplete, requireLegalCompliance, payment);

module.exports = router;
