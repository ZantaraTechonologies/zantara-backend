const express = require('express');
const router = express.Router();
const { getAuditLogs } = require('../controllers/auditController');
const { verifyJWT, checkRoles } = require('../middlewares/auth');

router.get('/', verifyJWT, checkRoles('admin', 'superAdmin'), getAuditLogs);

module.exports = router;
