const express = require('express')
const router = express.Router()
const { verifyJWT, checkRoles } = require('../middlewares/auth')
const {
    getFilteredTransactions,
    getAllUsers,
    updateUserRole,
    getSettings,
    updateSetting,
    getCommissionSettings,
    updateCommissionSettings,
    updateUserCommissionRate
} = require('../controllers/adminController')

// Admin middleware: Must be logged in and have 'admin' or 'superAdmin' role
router.use(verifyJWT, checkRoles('admin', 'superAdmin'));

router.get('/transactions', getFilteredTransactions)
router.get('/users', getAllUsers)
router.put('/users/:id', updateUserRole)
router.put('/users/:id/commission-rate', updateUserCommissionRate)
router.get('/settings', getSettings)
router.post('/settings', updateSetting)
router.get('/settings/commission', getCommissionSettings)
router.put('/settings/commission', updateCommissionSettings)

module.exports = router;
