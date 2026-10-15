const express = require('express')
const walletController = require('../controllers/walletController')
const { verifyJWT } = require('../middlewares/auth')
const requireLegalCompliance = require('../middlewares/requireLegalCompliance')
const { fundWallet, verifyFunding } = require('../controllers/walletFundingController')
const { getFundingMethods } = require('../controllers/adminPaymentGatewayController')
const { provisionVirtualAccount, getVirtualAccounts, requestBankAccounts } = require('../controllers/virtualAccountController')
const requireOnboardingComplete = require('../middlewares/requireOnboardingComplete')

const router = express.Router()

router.get('/', verifyJWT, requireOnboardingComplete, walletController.getWallet)
router.post('/redeem-earnings', verifyJWT, requireOnboardingComplete, requireLegalCompliance, walletController.redeemEarnings)
router.get('/verify-recipient', verifyJWT, requireOnboardingComplete, walletController.verifyTransferRecipient)
router.post('/transfer', verifyJWT, requireOnboardingComplete, requireLegalCompliance, walletController.transferMoney)

router.get('/funding-methods', verifyJWT, requireOnboardingComplete, getFundingMethods)
router.post('/fund', verifyJWT, requireOnboardingComplete, requireLegalCompliance, fundWallet)
router.get('/verify', verifyJWT, verifyFunding)
router.get('/virtual-accounts', verifyJWT, requireOnboardingComplete, getVirtualAccounts)
router.post('/virtual-accounts/request', verifyJWT, requireOnboardingComplete, requireLegalCompliance, requestBankAccounts)
router.post('/virtual-accounts/:provider', verifyJWT, requireOnboardingComplete, requireLegalCompliance, provisionVirtualAccount)

module.exports = router
