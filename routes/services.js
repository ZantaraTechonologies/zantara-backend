const express = require('express')
const router = express.Router()
const { verifyJWT } = require('../middlewares/auth')
const requireLegalCompliance = require('../middlewares/requireLegalCompliance')
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

 router.get('/identities', verifyJWT, getIdentitiesByCategory)
 router.get('/identities/:serviceIdentityId/plans', verifyJWT, getPlansByIdentityId)
 router.get('/plans/:network', verifyJWT, getPlans) // network is identityId or slug
 router.post('/broadband/verify', verifyJWT, broadbandVerificationLimiter, verifyBroadband)
 router.post('/broadband', verifyJWT, replayBroadbandPurchase, requireLegalCompliance, pinLimiter, purchaseBroadband)
 router.post('/airtime', verifyJWT, requireLegalCompliance, purchaseAirtime)
 router.post('/data', verifyJWT, requireLegalCompliance, purchaseData)
 router.post('/electricity', verifyJWT, requireLegalCompliance, payElectricityBill)
 router.post('/electricity/verify/meter', verifyJWT, verifyMeter)
 router.post('/cable/verify/smartcard', verifyJWT, verifySmartcard)
 router.post('/exam/verify/profile', verifyJWT, verifyExamProfile)
 router.post('/transaction/status', verifyJWT, checkTransaction)
 router.post('/cable', verifyJWT, requireLegalCompliance, rechargeCable)
 router.post('/purchase-pin', verifyJWT, requireLegalCompliance, purchaseExamPin)
 router.get('/purchased-pins', verifyJWT, getPurchasedPins)

module.exports = router
