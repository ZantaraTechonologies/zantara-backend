const express = require('express')
const router = express.Router()
const { verifyJWT, checkRoles } = require('../middlewares/auth')
const {
    getFilteredTransactions,
    getAllUsers,
    getUserById,
    updateUserRole,
    getSettings,
    updateSetting,
    getCommissionSettings,
    updateCommissionSettings,
    updateUserCommissionRate,
    getAgentSettings,
    updateAgentSettings,
    updateUserAgentDiscount,
    getCommissionCaps,
    updateCommissionCaps
} = require('../controllers/adminController')
const { getAllKyc, reviewKyc } = require('../controllers/kycController')

// Admin middleware: Must be logged in and have 'admin' or 'superAdmin' role
router.use(verifyJWT, checkRoles('admin', 'superAdmin'));

router.get('/transactions', getFilteredTransactions)
router.get('/users', getAllUsers)
router.get('/users/:id', getUserById)
router.get('/transactions/:id', (req, res, next) => {
    require('../controllers/transactionController').getUserTransaction(req, res, next);
})

// KYC Admin Routes
router.get('/kyc/queue', verifyJWT, checkRoles('admin', 'superAdmin'), getAllKyc)
router.post('/kyc/approve/:id', verifyJWT, checkRoles('admin', 'superAdmin'), (req, res, next) => {
    req.body.status = 'approved';
    reviewKyc(req, res, next);
})
router.post('/kyc/reject/:id', verifyJWT, checkRoles('admin', 'superAdmin'), (req, res, next) => {
    req.body.status = 'rejected';
    reviewKyc(req, res, next);
})
router.put('/users/:id', updateUserRole)
router.put('/users/:id/commission-rate', updateUserCommissionRate)
router.put('/users/:id/agent-discount', updateUserAgentDiscount)
router.get('/settings', getSettings)
router.post('/settings', updateSetting)
router.get('/settings/commission', getCommissionSettings)
router.put('/settings/commission', updateCommissionSettings)
router.get('/settings/agent', getAgentSettings)
router.put('/settings/agent', updateAgentSettings)
router.get('/settings/commission-caps', getCommissionCaps)
router.put('/settings/commission-caps', updateCommissionCaps)

module.exports = router;
