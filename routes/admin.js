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
    getCommissionCaps,
    updateCommissionCaps,
    adminCreditWallet,
    adminDebitWallet,
    exportUsersCSV,
    getPricingIntegrityReport
} = require('../controllers/adminController')
const { getAllKyc, getKycById, reviewKyc } = require('../controllers/kycController')
const serviceController = require('../controllers/serviceController')
const providerController = require('../controllers/providerController')
const adminSettingController = require('../controllers/adminSettingController')
const adminHierarchyController = require('../controllers/adminHierarchyController')

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
router.get('/kyc/:id', verifyJWT, checkRoles('admin', 'superAdmin'), getKycById)
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
router.get('/settings', checkRoles('superAdmin'), getSettings)
router.post('/settings', checkRoles('superAdmin'), updateSetting)
router.get('/settings/commission', checkRoles('superAdmin'), getCommissionSettings)
router.put('/settings/commission', checkRoles('superAdmin'), updateCommissionSettings)
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

// Business Settings
router.get('/settings/business', adminSettingController.getBusinessSettings)
router.post('/settings/business', adminSettingController.updateBusinessSettings)

// Notification Settings
router.get('/settings/notifications', adminSettingController.getNotificationSettings)
router.post('/settings/notifications', adminSettingController.updateNotificationSettings)

// Normalized Hierarchy & Pricing Rules (Batch 3)
router.get('/hierarchy/pricing-rules', adminHierarchyController.getPricingRules)
router.post('/hierarchy/pricing-rules', adminHierarchyController.createPricingRule)
router.put('/hierarchy/pricing-rules/:id', adminHierarchyController.updatePricingRule)
router.delete('/hierarchy/pricing-rules/:id', adminHierarchyController.deletePricingRule)

router.get('/hierarchy/provider-offers', adminHierarchyController.getProviderOffers)
router.post('/hierarchy/provider-offers', adminHierarchyController.createProviderOffer)
router.put('/hierarchy/provider-offers/:id', adminHierarchyController.updateProviderOffer)
router.delete('/hierarchy/provider-offers/:id', adminHierarchyController.deleteProviderOffer)
router.get('/hierarchy/identities', adminHierarchyController.getServiceIdentities)
router.post('/hierarchy/identities', adminHierarchyController.createServiceIdentity)
router.put('/hierarchy/identities/:id', adminHierarchyController.updateServiceIdentity)
router.delete('/hierarchy/identities/:id', adminHierarchyController.deleteServiceIdentity)
router.get('/hierarchy/metadata', adminHierarchyController.getHierarchyMetadata)
router.post('/hierarchy/purge-noisy-data', adminHierarchyController.safePurgeNoisyData)

// Master Data Management (Phase A)
router.get('/hierarchy/categories', adminHierarchyController.manageCategories)
router.post('/hierarchy/categories', adminHierarchyController.manageCategories)
router.put('/hierarchy/categories/:id', adminHierarchyController.manageCategories)

router.get('/hierarchy/types', adminHierarchyController.manageServiceTypes)
router.post('/hierarchy/types', adminHierarchyController.manageServiceTypes)
router.put('/hierarchy/types/:id', adminHierarchyController.manageServiceTypes)

router.get('/hierarchy/brands', adminHierarchyController.manageBrands)
router.post('/hierarchy/brands', adminHierarchyController.manageBrands)
router.put('/hierarchy/brands/:id', adminHierarchyController.manageBrands)

// Pricing Integrity Observability (Batch 3.2)
router.get('/pricing-integrity/report', getPricingIntegrityReport)

module.exports = router;
