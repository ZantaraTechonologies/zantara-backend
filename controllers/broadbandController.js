const broadbandService = require('../services/broadband.service');
const { sendResponse } = require('../utils/response');
const { resolveCustomerError } = require('../utils/broadbandCustomerError');

const customerError = (error, fallback) => resolveCustomerError(error, {
    fallbackMessage: fallback,
    fallbackStatusCode: 500
});

const sendPurchaseResult = (res, result) => {
    if (result.status === 'pending') {
        return sendResponse(res, {
            status: 202,
            success: false,
            message: result.message,
            data: result.data
        });
    }
    if (!result.success) {
        return sendResponse(res, {
            status: 400,
            success: false,
            message: result.message || 'Broadband purchase failed',
            data: result.data
        });
    }
    return sendResponse(res, { message: 'Broadband purchase successful', data: result.data });
};

const replayBroadbandPurchase = async (req, res, next) => {
    try {
        const result = await broadbandService.replay(
            req.user,
            req.headers?.['idempotency-key'],
            req.body || {}
        );
        return result ? sendPurchaseResult(res, result) : next();
    } catch (error) {
        const safe = customerError(error, 'Broadband purchase recovery failed');
        return sendResponse(res, {
            status: safe.statusCode,
            success: false,
            message: safe.message,
            error: safe.code
        });
    }
};

const verifyBroadband = async (req, res) => {
    try {
        const data = await broadbandService.verify(req.user, req.body || {});
        return sendResponse(res, { message: data.message, data });
    } catch (error) {
        const safe = customerError(error, 'Broadband verification failed');
        return sendResponse(res, {
            status: safe.statusCode,
            success: false,
            message: safe.message,
            error: safe.code
        });
    }
};

const purchaseBroadband = async (req, res) => {
    try {
        const result = await broadbandService.purchase(req.user, {
            ...(req.body || {}),
            idempotencyKey: req.headers?.['idempotency-key']
        });
        return sendPurchaseResult(res, result);
    } catch (error) {
        const safe = customerError(error, 'Broadband purchase failed');
        return sendResponse(res, {
            status: safe.statusCode,
            success: false,
            message: safe.message,
            error: safe.code
        });
    }
};

module.exports = { verifyBroadband, replayBroadbandPurchase, purchaseBroadband };
