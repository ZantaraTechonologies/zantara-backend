const express = require('express');
const router = express.Router();
const { payment } = require('../controllers/flutterwaveController');
const { verifyJWT } = require('../middlewares/auth');
const requireLegalCompliance = require('../middlewares/requireLegalCompliance');

// POST /api/flutterwave/initialize — initiates customer wallet-funding payment
// (guarded financial action: legal acceptance required before funding initiation).
router.post('/initialize', verifyJWT, requireLegalCompliance, payment);

module.exports = router;
