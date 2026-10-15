const express = require('express')
const { verifyJWT, checkRoles } = require('../middlewares/auth')
const requireOnboardingComplete = require('../middlewares/requireOnboardingComplete')
const { 
    getUserTransactions,
    getUserTransaction, 
    getFilteredTransactions, 
    getAllUsers, 
    getAllTransactions 
} = require('../controllers/transactionController')

const router = express.Router()

router.get('/', verifyJWT, requireOnboardingComplete, getUserTransactions)
router.get('/:id', verifyJWT, requireOnboardingComplete, getUserTransaction)
router.get('/admin/users', verifyJWT, checkRoles('admin'), getAllUsers)
router.get('/admin/transactions/all', verifyJWT, checkRoles('admin', 'superAdmin'), getAllTransactions)
router.get('/admin/transactions', verifyJWT, checkRoles('admin', 'superAdmin'), getFilteredTransactions)

module.exports = router
