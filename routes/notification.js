const express = require('express');
const router = express.Router();
const { getMyNotifications, markAsRead, markAllAsRead } = require('../controllers/notificationController');
const { verifyJWT } = require('../middlewares/auth');

router.use(verifyJWT);
router.get('/', getMyNotifications);
router.post('/read/:id', markAsRead);
router.post('/read-all', markAllAsRead);

module.exports = router;
