const express = require('express')
const walletController = require('../controllers/walletController')
const { verifyJWT } = require('../middlewares/auth')
const { fundWallet, verifyFunding } = require('../controllers/walletFundingController')
const { webhook } = require('../controllers/paystackWebhookController')

const router = express.Router()

router.get('/', verifyJWT, walletController.getWallet)
router.post('/debit', verifyJWT, walletController.debitWallet)
router.post('/credit', verifyJWT, walletController.creditWallet)
router.get('/freeze', verifyJWT, walletController.freezeWallet)
router.get('/unfreeze', verifyJWT, walletController.unfreezeWallet)

// Important: Paystack webhook must see raw body for signature
router.post('/paystack/webhook', require('express').raw({ type: '*/*' }), webhook)

router.post('/wallet/fund', verifyJWT, fundWallet)
router.get('/wallet/verify', verifyJWT, verifyFunding)

module.exports = router