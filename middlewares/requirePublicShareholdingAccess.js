'use strict';

const {
    assertPublicShareholdingAvailable,
    PUBLIC_SHAREHOLDING_HOLD_CODE
} = require('../config/publicShareholding');

const requirePublicShareholdingAccess = (req, res, next) => {
    try {
        assertPublicShareholdingAvailable();
        next();
    } catch (error) {
        if (error.code !== PUBLIC_SHAREHOLDING_HOLD_CODE) return next(error);
        return res.status(error.statusCode).json({
            success: false,
            code: error.code,
            message: error.message
        });
    }
};

module.exports = requirePublicShareholdingAccess;
