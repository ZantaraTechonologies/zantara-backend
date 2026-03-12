/**
 * Standardized API Response Helper
 */
const sendResponse = (res, { status = 200, success = true, message = '', data = null, error = null }) => {
    return res.status(status).json({
        success,
        message,
        data,
        error: error ? (typeof error === 'string' ? error : error.message || error) : null,
        timestamp: new Date().toISOString()
    });
};

module.exports = { sendResponse };
