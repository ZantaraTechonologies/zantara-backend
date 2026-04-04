const express = require('express');
const router = express.Router();
const systemController = require('../controllers/systemController');
const { verifyJWT, checkRoles } = require('../middlewares/auth');

// Admin-only health check
router.get('/status', verifyJWT, checkRoles('admin', 'superAdmin'), systemController.getSystemStatus);

module.exports = router;
