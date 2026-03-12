const express = require('express');
const router = express.Router();
const { submitKyc, getMyKyc, getAllKyc, reviewKyc } = require('../controllers/kycController');
const { verifyJWT, checkRoles } = require('../middlewares/auth');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/kyc/');
    },
    filename: (req, file, cb) => {
        cb(null, `${req.user.id}-${Date.now()}${path.extname(file.originalname)}`);
    }
});

const upload = multer({ storage });

// User Routes
router.use(verifyJWT);
router.post('/submit', upload.single('document'), submitKyc);
router.get('/my-status', getMyKyc);

// Admin Routes
router.get('/all', checkRoles('admin', 'superAdmin'), getAllKyc);
router.post('/review/:id', checkRoles('admin', 'superAdmin'), reviewKyc);

module.exports = router;
