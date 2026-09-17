const express = require('express')
const router = express.Router()
const { verifyJWT } = require('../middlewares/auth')
const { payment, verifyTransaction } = require('../controllers/paystackController')

router.post('/initialize', verifyJWT, payment);
router.get('/verify/:reference', verifyJWT, verifyTransaction);

module.exports = router;
