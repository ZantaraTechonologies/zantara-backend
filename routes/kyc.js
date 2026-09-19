const express = require('express');
const router = express.Router();
const { submitKyc, getMyKyc, getAllKyc, reviewKyc } = require('../controllers/kycController');
const { verifyJWT, checkRoles } = require('../middlewares/auth');
const { kycLimiter } = require('../middlewares/limiter');
const multer = require('multer');
const cloudinaryUtils = require('../utils/cloudinary');
const Kyc = require('../models/Kyc');
const { storage } = cloudinaryUtils;

const allowedDocumentMimeTypes = new Set([
    'image/jpeg',
    'image/png',
    'application/pdf'
]);

const createStorageError = () => {
    const error = new Error('Document upload failed');
    error.code = 'UPLOAD_STORAGE_ERROR';
    error.status = 502;
    return error;
};

const safeStorage = {
    _handleFile(req, file, callback) {
        try {
            storage._handleFile(req, file, (err, info) => {
                if (err) return callback(createStorageError());
                if (!info || typeof info !== 'object') return callback(createStorageError());
                return callback(null, {
                    ...info,
                    file_id: info.file_id || info.public_id
                });
            });
        } catch (err) {
            callback(createStorageError());
        }
    },
    _removeFile(req, file, callback) {
        const publicId = file.public_id || file.file_id;
        if (!publicId) return callback(createStorageError());

        Promise.resolve(cloudinaryUtils.destroyKycAsset({
            publicId,
            resourceType: file.resource_type || cloudinaryUtils.KYC_RESOURCE_TYPE,
            deliveryType: file.type || cloudinaryUtils.KYC_DELIVERY_TYPE
        })).then(() => callback()).catch(() => callback(createStorageError()));
    }
};

const upload = multer({
    storage: safeStorage,
    limits: {
        files: 1,
        fields: 4,
        parts: 5,
        fileSize: 10 * 1024 * 1024,
        fieldNameSize: 100,
        fieldSize: 64 * 1024,
        fieldNestingDepth: 1,
        fieldArrayIndexLimit: 0
    },
    fileFilter: (req, file, cb) => {
        if (allowedDocumentMimeTypes.has(file.mimetype)) return cb(null, true);

        const fileTypeError = new Error('Unsupported document type');
        fileTypeError.code = 'INVALID_FILE_TYPE';
        fileTypeError.status = 415;
        return cb(fileTypeError);
    }
});

const uploadDocument = upload.single('document');
const rejectKnownPendingKyc = async (req, res, next) => {
    try {
        const existingPending = await Kyc.exists({ userId: req.user.id, status: 'pending' });
        if (existingPending) {
            return res.status(400).json({
                success: false,
                message: 'You already have a verification request under review'
            });
        }
        return next();
    } catch (err) {
        const lookupError = new Error('Unable to verify KYC status');
        lookupError.status = 500;
        return next(lookupError);
    }
};

const parseKycUpload = (req, res, next) => {
    uploadDocument(req, res, (err) => {
        if (
            !err ||
            err instanceof multer.MulterError ||
            err.code === 'INVALID_FILE_TYPE' ||
            err.code === 'UPLOAD_STORAGE_ERROR'
        ) {
            return next(err);
        }

        const multipartError = new Error('Invalid multipart request');
        multipartError.code = 'INVALID_MULTIPART';
        multipartError.status = 400;
        return next(multipartError);
    });
};

// User Routes
router.use(verifyJWT);
router.post('/submit', kycLimiter, rejectKnownPendingKyc, parseKycUpload, submitKyc);
router.get('/my-status', getMyKyc);

// Admin Routes
router.get('/all', checkRoles('admin', 'superAdmin'), getAllKyc);
router.post('/review/:id', checkRoles('admin', 'superAdmin'), reviewKyc);

module.exports = router;
