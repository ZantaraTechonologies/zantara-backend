'use strict';

const express = require('express');
const router = express.Router();
const { verifyJWT, checkRoles } = require('../middlewares/auth');
const { adminReauthenticationLimiter } = require('../middlewares/limiter');
const {
    getAllGateways,
    getGatewayById,
    getAdapterCapabilities,
    createGateway,
    updateGateway,
    updateGatewayStatus,
    setDefaultGateway,
    testGatewayConnection,
    replaceMonnifyMerchant,
    testMonnifyHostedCheckout,
    enableMonnifyCustomerFunding,
    recoverMonnifyGatewayTest,
    deleteGateway,
    getReconciliationTransactions,
    resolveReconciliationTransaction
} = require('../controllers/adminPaymentGatewayController');

// All endpoints require verified admin token
// Read endpoints accessible to 'admin' and 'superAdmin'
router.get('/', verifyJWT, checkRoles('admin', 'superAdmin'), getAllGateways);
router.get('/reconciliation', verifyJWT, checkRoles('admin', 'superAdmin'), getReconciliationTransactions);

// Writable reconciliation: SUPERADMIN ONLY. Settles a 'processing' (crash-window)
// payment to success with exactly-once credit. Registered before /:id to avoid
// placeholder capture.
router.post('/reconciliation/resolve', verifyJWT, checkRoles('superAdmin'), resolveReconciliationTransaction);

// Capabilities endpoint: safe metadata only, no credentials
// MUST be mounted before /:id to avoid param collision
router.get('/capabilities', verifyJWT, checkRoles('admin', 'superAdmin'), getAdapterCapabilities);

router.get('/:id', verifyJWT, checkRoles('admin', 'superAdmin'), getGatewayById);

// Mutation endpoints strictly SUPERADMIN ONLY
router.post('/', verifyJWT, checkRoles('superAdmin'), createGateway);
router.put('/:id', verifyJWT, checkRoles('superAdmin'), updateGateway);
router.patch('/:id/status', verifyJWT, checkRoles('superAdmin'), updateGatewayStatus);
router.post('/:id/set-default', verifyJWT, checkRoles('superAdmin'), setDefaultGateway);
router.post('/:id/test-connection', verifyJWT, checkRoles('superAdmin'), testGatewayConnection);
router.post('/:id/replace-monnify-merchant', verifyJWT, checkRoles('superAdmin'), adminReauthenticationLimiter, replaceMonnifyMerchant);
router.post('/:id/test-monnify-checkout', verifyJWT, checkRoles('superAdmin'), adminReauthenticationLimiter, testMonnifyHostedCheckout);
router.post('/:id/enable-monnify-customer-funding', verifyJWT, checkRoles('superAdmin'), adminReauthenticationLimiter, enableMonnifyCustomerFunding);
router.post('/:id/recover-monnify-gateway-test', verifyJWT, checkRoles('superAdmin'), adminReauthenticationLimiter, recoverMonnifyGatewayTest);
// Compatibility endpoint: always returns the durable no-hard-delete policy.
router.delete('/:id', verifyJWT, checkRoles('superAdmin'), deleteGateway);

module.exports = router;
