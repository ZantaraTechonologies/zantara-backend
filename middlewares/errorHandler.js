const Log = require('../models/Logs')
const { sanitizeRequestText, sanitizeUrl } = require('../utils/logSanitizer')
const multer = require('multer')

module.exports = async function errorHandler(err, req, res, next) {
    const safeMessage = sanitizeRequestText(err.message || String(err), req);
    const safeStack = sanitizeRequestText(err.stack || err, req);
    console.error('SERVER ERROR:', safeStack);

    // Log the error to DB
    try {
        await Log.create({
            level: 'error',
            message: safeMessage,
            context: {
                route: sanitizeUrl(req.originalUrl),
                method: req.method,
                user: req.user ? (req.user._id || req.user.id) : null
            },
            stackTrace: safeStack
        })
    } catch (e) {
        console.error('Error logging to DB:', sanitizeRequestText(e.message, req));
    }

    let status = err.status || 500
    let publicMessage = safeMessage || 'An internal server error occurred.'

    if (err instanceof multer.MulterError) {
        status = ['LIMIT_FILE_SIZE', 'LIMIT_FIELD_KEY', 'LIMIT_FIELD_VALUE'].includes(err.code) ? 413 : 400
        publicMessage = status === 413
            ? 'Multipart request exceeds the allowed size'
            : 'Invalid multipart request'
    } else if (err.code === 'INVALID_FILE_TYPE') {
        status = 415
        publicMessage = 'Unsupported document type'
    } else if (err.code === 'INVALID_MULTIPART') {
        status = 400
        publicMessage = 'Invalid multipart request'
    } else if (err.code === 'UPLOAD_STORAGE_ERROR') {
        status = 502
        publicMessage = 'Document upload failed'
    }

    res.status(status).json({
        success: false,
        error: publicMessage
    })
}
