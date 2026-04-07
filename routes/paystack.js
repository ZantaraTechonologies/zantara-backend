const express = require('express')
const router = express.Router()
const { verifyJWT } = require('../middlewares/auth')
const { payment, webhook, verifyTransaction } = require('../controllers/paystackController')
const { rawBodySaver } = require('../middlewares/paystack')

router.post('/initialize', verifyJWT, payment);
router.get('/verify/:reference', verifyJWT, verifyTransaction);

router.post('/webhook', express.json({ verify: rawBodySaver }), webhook);

module.exports = router;
