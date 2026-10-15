const express = require('express')
const router = express.Router()
const {
    requestWithdrawal,
    processWithdrawal,
    getAllWithdrawals,
    getWithdrawalById,
    getMyWithdrawals
} = require('../controllers/withdrawalController')
const { verifyJWT, checkRoles } = require('../middlewares/auth')
const requireLegalCompliance = require('../middlewares/requireLegalCompliance')
const requireOnboardingComplete = require('../middlewares/requireOnboardingComplete')

// User routes
router.post('/', verifyJWT, requireOnboardingComplete, requireLegalCompliance, requestWithdrawal)
router.get('/me', verifyJWT, requireOnboardingComplete, getMyWithdrawals)

// Admin routes
router.get('/', verifyJWT, checkRoles('admin', 'superAdmin'), getAllWithdrawals)
router.get('/:id', verifyJWT, checkRoles('admin', 'superAdmin'), getWithdrawalById)
router.post('/:id/process', verifyJWT, checkRoles('admin', 'superAdmin'), processWithdrawal)

module.exports = router
