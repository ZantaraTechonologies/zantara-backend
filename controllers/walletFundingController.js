const paymentGatewayService = require('../services/paymentGateway.service');
const TransactionStatus = require('../models/TransactionStatus');

const ALLOWED_CHANNELS = ['card', 'ussd', 'bank_transfer', 'virtual_account'];
const MIN_AMOUNT = 50; // ₦

const publicInitializationError = (err) => {
    const configured = err.code === 'PAYMENT_CONFIGURATION_ERROR';
    const unavailable = configured || [
        'PAYMENT_GATEWAY_NOT_FOUND',
        'PAYMENT_GATEWAY_INACTIVE',
        'PAYMENT_GATEWAY_MAINTENANCE',
        'PAYMENT_GATEWAY_ADAPTER_UNSUPPORTED'
    ].includes(err.code);
    return {
        status: configured ? 503 : unavailable ? 400 : err.code === 'PAYMENT_CHANNEL_UNSUPPORTED' ? 400 : 502,
        body: {
            message: unavailable
                ? 'Online payment is temporarily unavailable. Please try again later.'
                : err.code === 'PAYMENT_CHANNEL_UNSUPPORTED'
                    ? 'The requested payment method is unavailable.'
                    : 'Unable to start payment securely. Please try again later.',
            code: configured || unavailable
                ? 'PAYMENT_GATEWAY_UNAVAILABLE'
                : err.code === 'PAYMENT_CHANNEL_UNSUPPORTED'
                    ? err.code
                    : 'PAYMENT_INITIALIZATION_FAILED'
        }
    };
};

function normalizeChannel(input) {
    if (!input) return null;
    if (Array.isArray(input)) {
        const normalized = input.map(String);
        if (normalized.length === 0 || normalized.some(c => !ALLOWED_CHANNELS.includes(c))) return null;
        return normalized[0];
    }
    return ALLOWED_CHANNELS.includes(String(input)) ? String(input) : null;
}

const fundWallet = async (req, res) => {
    try {
        const rawAmount = Number(req.body?.amount);
        const gatewayCode = req.body?.gatewayCode || req.body?.provider || null;
        
        const rawKobo = rawAmount * 100;
        if (!Number.isFinite(rawAmount) || rawAmount < MIN_AMOUNT || !Number.isSafeInteger(Math.round(rawKobo)) || Math.abs(rawKobo - Math.round(rawKobo)) > 1e-7) {
            return res.status(400).json({ message: `Minimum amount is ₦${MIN_AMOUNT}` });
        }

        const requestedChannel = req.body?.channel || req.body?.channels;
        const channel = normalizeChannel(requestedChannel);
        if (requestedChannel && !channel) {
            return res.status(400).json({
                message: 'Unsupported payment channel',
                code: 'PAYMENT_CHANNEL_UNSUPPORTED'
            });
        }
        const user = req.user;
        const callbackUrl = req.body?.callback_url;

        const result = await paymentGatewayService.initializeFunding({
            gatewayCode,
            channel,
            user,
            amount: rawAmount,
            callbackUrl,
            metadata: {
                type: 'funding'
            }
        });

        return res.json({
            authorization_url: result.authorizationUrl,
            reference: result.reference,
            provider: result.provider,
            checkoutProvider: result.checkoutProvider,
            gateway: result.gateway,
            callbackUrl: result.callbackUrl,
            returnHost: result.callbackUrl && typeof result.callbackUrl === 'string' ? (() => {
                try { return new URL(result.callbackUrl).hostname; } catch (e) { return undefined; }
            })() : undefined,
            accountNumber: result.accountNumber,
            bankName: result.bankName,
            accountName: result.accountName
        });
    } catch (err) {
        console.error('Funding init error:', err.message);
        if (err.code === 'PAYMENT_INITIALIZATION_AMBIGUOUS') {
            return res.status(202).json({
                message: 'Payment initialization is still being confirmed. Do not start another payment for this attempt.',
                code: err.code,
                status: 'pending',
                reference: err.reference,
                provider: err.provider,
                checkoutProvider: err.checkoutProvider
            });
        }
        const response = publicInitializationError(err);
        return res.status(response.status).json(response.body);
    }
};

const verifyFunding = async (req, res) => {
    try {
        const { reference } = req.query;
        if (!reference) return res.status(400).json({ status: 'not_found', message: 'Reference is required' });

        const row = await TransactionStatus.findOne({
            refId: reference,
            userId: req.user.id
        });
        if (!row) return res.status(404).json({ status: 'not_found' });

        // If already explicitly completed or failed, return immediately
        if (row.status === 'success' || row.status === 'failed') {
            return res.json({ status: row.status, type: row.type, reference });
        }

        // Delegate to unified PaymentGatewayService
        const result = await paymentGatewayService.verifyFunding(reference);
        return res.json({
            status: result.status,
            type: row.type,
            reference,
            amount: result.amount,
            ...(result.deferred !== undefined ? { deferred: result.deferred } : {}),
            ...(result.message ? { message: result.message } : {})
        });
    } catch (e) {
        console.error('Verify logic error:', e.message);
        if (e.code === 'PUBLIC_SHAREHOLDING_HOLD') {
            return res.status(503).json({ status: 'unavailable', code: e.code, message: e.message });
        }
        return res.status(500).json({
            status: 'error',
            code: 'PAYMENT_VERIFICATION_UNAVAILABLE',
            message: 'Payment verification is temporarily unavailable. Please try again later.'
        });
    }
};

module.exports = {
    fundWallet,
    verifyFunding
};
