const Log = require('../models/Logs')

module.exports = async function errorHandler(err, req, res, next) {
    console.error('SERVER ERROR:', err.stack || err);

    // Log the error to DB
    try {
        await Log.create({
            level: 'error',
            message: err.message || String(err),
            context: {
                route: req.originalUrl,
                method: req.method,
                user: req.user ? (req.user._id || req.user.id) : null
            },
            stackTrace: err.stack
        })
    } catch (e) {
        console.error('Error logging to DB:', e.message);
    }

    res.status(err.status || 500).json({ 
        success: false,
        error: err.message || 'An internal server error occurred.' 
    })
}