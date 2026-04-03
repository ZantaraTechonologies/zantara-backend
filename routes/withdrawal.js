const express = require('express')
const router = express.Router()
const {
    requestWithdrawal,
    processWithdrawal,
    getAllWithdrawals,
    getMyWithdrawals
} = require('../controllers/withdrawalController')
const { verifyJWT, checkRoles } = require('../middlewares/auth')

// User routes
router.post('/', verifyJWT, requestWithdrawal)
router.get('/me', verifyJWT, getMyWithdrawals)

// Admin routes
router.get('/', verifyJWT, checkRoles('admin', 'superAdmin'), getAllWithdrawals)
router.put('/:id', verifyJWT, checkRoles('admin', 'superAdmin'), processWithdrawal)

module.exports = router