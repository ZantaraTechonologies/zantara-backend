const Log = require('../models/Logs')
const { sanitizeRequestText, sanitizeUrl } = require('../utils/logSanitizer')

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

    res.status(err.status || 500).json({ 
        success: false,
        error: safeMessage || 'An internal server error occurred.'
    })
}