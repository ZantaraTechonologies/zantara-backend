const express = require('express')
const router = express.Router()
const { verifyJWT } = require('../middlewares/auth')
const requireLegalCompliance = require('../middlewares/requireLegalCompliance')
const { payment, verifyTransaction } = require('../controllers/paystackController')

router.post('/initialize', verifyJWT, requireLegalCompliance, payment);
router.get('/verify/:reference', verifyJWT, verifyTransaction);

module.exports = router;
