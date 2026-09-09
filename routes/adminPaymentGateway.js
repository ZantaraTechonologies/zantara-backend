'use strict';

const express = require('express');
const router = express.Router();
const { verifyJWT, checkRoles } = require('../middlewares/auth');
const {
    getAllGateways,
    getGatewayById,
    createGateway,
    updateGateway,
    updateGatewayStatus,
    setDefaultGateway,
    testGatewayConnection,
    deleteGateway,
    getReconciliationTransactions
} = require('../controllers/adminPaymentGatewayController');

// All endpoints require verified admin token
// Read endpoints accessible to 'admin' and 'superAdmin'
router.get('/', verifyJWT, checkRoles('admin', 'superAdmin'), getAllGateways);
router.get('/reconciliation', verifyJWT, checkRoles('admin', 'superAdmin'), getReconciliationTransactions);
router.get('/:id', verifyJWT, checkRoles('admin', 'superAdmin'), getGatewayById);

// Mutation endpoints strictly SUPERADMIN ONLY
router.post('/', verifyJWT, checkRoles('superAdmin'), createGateway);
router.put('/:id', verifyJWT, checkRoles('superAdmin'), updateGateway);
router.patch('/:id/status', verifyJWT, checkRoles('superAdmin'), updateGatewayStatus);
router.post('/:id/set-default', verifyJWT, checkRoles('superAdmin'), setDefaultGateway);
router.post('/:id/test-connection', verifyJWT, checkRoles('superAdmin'), testGatewayConnection);
router.delete('/:id', verifyJWT, checkRoles('superAdmin'), deleteGateway);

module.exports = router;
