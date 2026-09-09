const paymentGatewayService = require('../services/paymentGateway.service');
const TransactionStatus = require('../models/TransactionStatus');

const ALLOWED_CHANNELS = ['card', 'ussd', 'bank_transfer', 'virtual_account'];
const MIN_AMOUNT = 50; // ₦

function normalizeChannel(input) {
    if (!input) return null;
    if (Array.isArray(input)) {
        const found = input.find(c => ALLOWED_CHANNELS.includes(String(c)));
        return found || null;
    }
    return ALLOWED_CHANNELS.includes(String(input)) ? String(input) : null;
}

const fundWallet = async (req, res) => {
    try {
        const rawAmount = Number(req.body?.amount);
        const gatewayCode = req.body?.gatewayCode || req.body?.provider || null;
        
        if (!rawAmount || rawAmount < MIN_AMOUNT) {
            return res.status(400).json({ message: `Minimum amount is ₦${MIN_AMOUNT}` });
        }

        const channel = normalizeChannel(req.body?.channel || req.body?.channels);
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
            gateway: result.gateway,
            accountNumber: result.accountNumber,
            bankName: result.bankName,
            accountName: result.accountName
        });
    } catch (err) {
        console.error('Funding init error:', err.message);
        const status = err.code === 'PAYMENT_GATEWAY_NOT_FOUND' ? 404
            : (['PAYMENT_GATEWAY_INACTIVE', 'PAYMENT_GATEWAY_MAINTENANCE', 'PAYMENT_CHANNEL_UNSUPPORTED'].includes(err.code) ? 400 : 500);
        return res.status(status).json({
            message: err.message || 'Funding initialization failed',
            code: err.code || 'PAYMENT_INIT_ERROR'
        });
    }
};

const verifyFunding = async (req, res) => {
    try {
        const { reference } = req.query;
        if (!reference) return res.status(400).json({ status: 'not_found', message: 'Reference is required' });

        const row = await TransactionStatus.findOne({ refId: reference });
        if (!row) return res.status(404).json({ status: 'not_found' });

        if (row.userId && String(row.userId) !== String(req.user.id)) {
            return res.status(403).json({ status: 'forbidden' });
        }

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
            amount: result.amount
        });
    } catch (e) {
        console.error('Verify logic error:', e.message);
        return res.status(500).json({ status: 'error', message: e.message });
    }
};

module.exports = {
    fundWallet,
    verifyFunding
};
