const express = require('express')
const walletController = require('../controllers/walletController')
const { verifyJWT } = require('../middlewares/auth')
const requireLegalCompliance = require('../middlewares/requireLegalCompliance')
const { fundWallet, verifyFunding } = require('../controllers/walletFundingController')
const { getFundingMethods } = require('../controllers/adminPaymentGatewayController')
const { webhook } = require('../controllers/paystackController')

const router = express.Router()

router.get('/', verifyJWT, walletController.getWallet)
router.post('/debit', verifyJWT, requireLegalCompliance, walletController.debitWallet)
router.post('/credit', verifyJWT, requireLegalCompliance, walletController.creditWallet)
router.get('/freeze', verifyJWT, walletController.freezeWallet)
router.get('/unfreeze', verifyJWT, walletController.unfreezeWallet)
router.post('/redeem-earnings', verifyJWT, requireLegalCompliance, walletController.redeemEarnings)
router.get('/verify-recipient', verifyJWT, walletController.verifyTransferRecipient)
router.post('/transfer', verifyJWT, requireLegalCompliance, walletController.transferMoney)

// Important: Paystack webhook must see raw body for signature
router.post('/paystack/webhook', require('express').raw({ type: '*/*' }), webhook)

router.get('/funding-methods', verifyJWT, getFundingMethods)
router.post('/fund', verifyJWT, requireLegalCompliance, fundWallet)
router.get('/verify', verifyJWT, verifyFunding)

module.exports = router