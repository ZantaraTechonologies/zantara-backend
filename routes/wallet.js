const express = require('express')
const walletController = require('../controllers/walletController')
const { verifyJWT } = require('../middlewares/auth')
const requireLegalCompliance = require('../middlewares/requireLegalCompliance')
const { fundWallet, verifyFunding } = require('../controllers/walletFundingController')
const { getFundingMethods } = require('../controllers/adminPaymentGatewayController')

const router = express.Router()

router.get('/', verifyJWT, walletController.getWallet)
router.post('/redeem-earnings', verifyJWT, requireLegalCompliance, walletController.redeemEarnings)
router.get('/verify-recipient', verifyJWT, walletController.verifyTransferRecipient)
router.post('/transfer', verifyJWT, requireLegalCompliance, walletController.transferMoney)

router.get('/funding-methods', verifyJWT, getFundingMethods)
router.post('/fund', verifyJWT, requireLegalCompliance, fundWallet)
router.get('/verify', verifyJWT, verifyFunding)

module.exports = router
