const express = require('express')
const router = express.Router()
const { verifyJWT } = require('../middlewares/auth')
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
 router.post('/airtime', verifyJWT, purchaseAirtime)
 router.post('/data', verifyJWT, purchaseData)
 router.post('/electricity', verifyJWT, payElectricityBill)
 router.post('/electricity/verify/meter', verifyJWT, verifyMeter)
 router.post('/cable/verify/smartcard', verifyJWT, verifyMeter) // using existing controller logic for now
 router.post('/exam/verify/profile', verifyJWT, verifyMeter) // using existing controller logic for now
 router.post('/transaction/status', verifyJWT, checkTransaction)
 router.post('/cable', verifyJWT, rechargeCable)
 router.post('/purchase-pin', verifyJWT, purchaseExamPin)
 router.get('/purchased-pins', verifyJWT, getPurchasedPins)

module.exports = router
