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
    updateCommissionCaps,
    adminCreditWallet,
    adminDebitWallet,
    exportUsersCSV
} = require('../controllers/adminController')
const { getAllKyc, reviewKyc } = require('../controllers/kycController')
const serviceController = require('../controllers/serviceController')
const providerController = require('../controllers/providerController')

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
router.put('/users/:id', checkRoles('superAdmin'), updateUserRole)
router.put('/users/:id/commission-rate', checkRoles('superAdmin'), updateUserCommissionRate)
router.put('/users/:id/agent-discount', checkRoles('superAdmin'), updateUserAgentDiscount)
router.get('/settings', checkRoles('superAdmin'), getSettings)
router.post('/settings', checkRoles('superAdmin'), updateSetting)
router.get('/settings/commission', checkRoles('superAdmin'), getCommissionSettings)
router.put('/settings/commission', checkRoles('superAdmin'), updateCommissionSettings)
router.get('/settings/agent', checkRoles('superAdmin'), getAgentSettings)
router.put('/settings/agent', checkRoles('superAdmin'), updateAgentSettings)
router.get('/settings/commission-caps', checkRoles('superAdmin'), getCommissionCaps)
router.put('/settings/commission-caps', checkRoles('superAdmin'), updateCommissionCaps)

// Wallet Management
router.post('/users/:userId/credit', checkRoles('superAdmin'), adminCreditWallet)
router.post('/users/:userId/debit', checkRoles('superAdmin'), adminDebitWallet)
router.get('/users/export/csv', exportUsersCSV)

// Service Management
router.get('/services', serviceController.getAdminServices)
router.post('/services', serviceController.createService)
router.put('/services/:id', serviceController.updateService)
router.delete('/services/:id', serviceController.deleteService)
router.post('/services/sync-costs', serviceController.bulkSyncCosts)
router.post('/services/import', serviceController.bulkImportServices)

// Provider Management
router.get('/providers', providerController.getAllProviders)
router.post('/providers', providerController.createProvider)
router.put('/providers/:id', providerController.updateProvider)
router.delete('/providers/:id', providerController.deleteProvider)
router.get('/providers/:id/balance', providerController.getProviderBalance)

module.exports = router;
