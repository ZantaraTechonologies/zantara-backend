const express = require('express');
const router = express.Router();
const { payment } = require('../controllers/flutterwaveController');
const { verifyJWT } = require('../middlewares/auth');

// POST /api/flutterwave/initialize
router.post('/initialize', verifyJWT, payment);

module.exports = router;
