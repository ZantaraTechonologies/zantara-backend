const express = require('express');
const router = express.Router();
const { sendBroadcast, getAdminBroadcasts, deleteBroadcast, toggleBroadcastStatus } = require('../controllers/notificationController');
const { verifyJWT, checkRoles } = require('../middlewares/auth');

// Protected admin routes
router.use(verifyJWT, checkRoles('admin', 'superAdmin'));

router.get('/broadcasts', getAdminBroadcasts);
router.post('/broadcast', sendBroadcast);
router.delete('/broadcast/:id', deleteBroadcast);
router.post('/broadcast/:id/toggle', toggleBroadcastStatus);

module.exports = router;
