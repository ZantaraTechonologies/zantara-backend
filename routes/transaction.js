const express = require('express')
const { verifyJWT, checkRoles } = require('../middlewares/auth')
const { 
    getUserTransactions,
    getUserTransaction, 
    getFilteredTransactions, 
    getAllUsers, 
    getAllTransactions 
} = require('../controllers/transactionController')

const router = express.Router()

router.get('/', verifyJWT, getUserTransactions)
router.get('/:id', verifyJWT, getUserTransaction)
router.get('/admin/users', verifyJWT, checkRoles('admin'), getAllUsers)
router.get('/admin/transactions/all', verifyJWT, checkRoles('admin'), getAllTransactions)
router.get('/admin/transactions', verifyJWT, checkRoles('admin'), getFilteredTransactions)

module.exports = router
