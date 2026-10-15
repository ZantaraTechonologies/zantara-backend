const express = require('express')
const router = express.Router()
const { verifyJWT } = require('../middlewares/auth')
const requireLegalCompliance = require('../middlewares/requireLegalCompliance')
const { payment, verifyTransaction } = require('../controllers/paystackController')
const requireOnboardingComplete = require('../middlewares/requireOnboardingComplete')

router.post('/initialize', verifyJWT, requireOnboardingComplete, requireLegalCompliance, payment);
router.get('/verify/:reference', verifyJWT, verifyTransaction);

module.exports = router;
