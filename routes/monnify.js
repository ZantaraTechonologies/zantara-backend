const express = require('express');
const router = express.Router();
const { payment } = require('../controllers/monnifyController');
const { verifyJWT } = require('../middlewares/auth');

// POST /api/monnify/initialize
router.post('/initialize', verifyJWT, payment);

// POST /api/monnify/generate-virtual-accounts
router.post('/generate-virtual-accounts', verifyJWT, require('../controllers/monnifyController').generateVirtualAccounts);

module.exports = router;
