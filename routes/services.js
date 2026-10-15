const express = require('express')
const router = express.Router()
const { verifyJWT } = require('../middlewares/auth')
const requireLegalCompliance = require('../middlewares/requireLegalCompliance')
const requireOnboardingComplete = require('../middlewares/requireOnboardingComplete')
const { pinLimiter, broadbandVerificationLimiter } = require('../middlewares/limiter')
const { verifyBroadband, replayBroadbandPurchase, purchaseBroadband } = require('../controllers/broadbandController')
const { 
    purchaseAirtime,
    purchaseData,
    getIdentitiesByCategory,
    getPlans,
    getPlansByIdentityId,
     payElectricityBill,
     verifyMeter,
     verifySmartcard,
     verifyExamProfile,
    cablePlans,
    rechargeCable,
    purchaseExamPin,
    getPurchasedPins,
    checkTransaction
 } = require('../controllers/servicesController')

 router.get('/identities', verifyJWT, requireOnboardingComplete, getIdentitiesByCategory)
 router.get('/identities/:serviceIdentityId/plans', verifyJWT, requireOnboardingComplete, getPlansByIdentityId)
 router.get('/plans/:network', verifyJWT, requireOnboardingComplete, getPlans) // network is identityId or slug
 router.post('/broadband/verify', verifyJWT, requireOnboardingComplete, broadbandVerificationLimiter, verifyBroadband)
 router.post('/broadband', verifyJWT, replayBroadbandPurchase, requireOnboardingComplete, requireLegalCompliance, pinLimiter, purchaseBroadband)
 router.post('/airtime', verifyJWT, requireOnboardingComplete, requireLegalCompliance, purchaseAirtime)
 router.post('/data', verifyJWT, requireOnboardingComplete, requireLegalCompliance, purchaseData)
 router.post('/electricity', verifyJWT, requireOnboardingComplete, requireLegalCompliance, payElectricityBill)
 router.post('/electricity/verify/meter', verifyJWT, requireOnboardingComplete, verifyMeter)
 router.post('/cable/verify/smartcard', verifyJWT, requireOnboardingComplete, verifySmartcard)
 router.post('/exam/verify/profile', verifyJWT, requireOnboardingComplete, verifyExamProfile)
 router.post('/transaction/status', verifyJWT, checkTransaction)
 router.post('/cable', verifyJWT, requireOnboardingComplete, requireLegalCompliance, rechargeCable)
 router.post('/purchase-pin', verifyJWT, requireOnboardingComplete, requireLegalCompliance, purchaseExamPin)
 router.get('/purchased-pins', verifyJWT, requireOnboardingComplete, getPurchasedPins)

module.exports = router
