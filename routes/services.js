const express = require('express')
const router = express.Router()
const { verifyJWT } = require('../middlewares/auth')
const requireLegalCompliance = require('../middlewares/requireLegalCompliance')
const { 
    purchaseAirtime,
    purchaseData,
    getIdentitiesByCategory,
    getPlans,
    payElectricityBill,
    verifyMeter,
    cablePlans,
    rechargeCable,
    purchaseExamPin,
    getPurchasedPins,
    checkTransaction
 } = require('../controllers/servicesController')

 router.get('/identities', verifyJWT, getIdentitiesByCategory)
 router.get('/plans/:network', verifyJWT, getPlans) // network is identityId or slug
 router.post('/airtime', verifyJWT, requireLegalCompliance, purchaseAirtime)
 router.post('/data', verifyJWT, requireLegalCompliance, purchaseData)
 router.post('/electricity', verifyJWT, requireLegalCompliance, payElectricityBill)
 router.post('/electricity/verify/meter', verifyJWT, verifyMeter)
 router.post('/cable/verify/smartcard', verifyJWT, verifyMeter) // using existing controller logic for now
 router.post('/exam/verify/profile', verifyJWT, verifyMeter) // using existing controller logic for now
 router.post('/transaction/status', verifyJWT, checkTransaction)
 router.post('/cable', verifyJWT, requireLegalCompliance, rechargeCable)
 router.post('/purchase-pin', verifyJWT, requireLegalCompliance, purchaseExamPin)
 router.get('/purchased-pins', verifyJWT, getPurchasedPins)

module.exports = router
