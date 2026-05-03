const express = require('express');
const router = express.Router();
const { submitKyc, getMyKyc, getAllKyc, reviewKyc } = require('../controllers/kycController');
const { verifyJWT, checkRoles } = require('../middlewares/auth');
const { kycLimiter } = require('../middlewares/limiter');
const multer = require('multer');
const { storage } = require('../utils/cloudinary');
const upload = multer({ storage });

// User Routes
router.use(verifyJWT);
router.post('/submit', kycLimiter, upload.single('document'), submitKyc);
router.get('/my-status', getMyKyc);

// Admin Routes
router.get('/all', checkRoles('admin', 'superAdmin'), getAllKyc);
router.post('/review/:id', checkRoles('admin', 'superAdmin'), reviewKyc);

module.exports = router;
