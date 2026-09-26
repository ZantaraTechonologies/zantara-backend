const TransactionStatus = require('../models/TransactionStatus');
const paymentGatewayService = require('../services/paymentGateway.service');

// Optional helper for robust metadata parsing
const parseMetadata = (metadata) => {
    if (!metadata) return {};
    if (typeof metadata === 'string') {
        try { return JSON.parse(metadata); } catch (e) { return {}; }
    }
    return metadata;
};

// Optional helper endpoint (not used by /wallet/fund flow).
const payment = async (req, res) => {
    let txType = 'funding';
    try {
        const { amount, channels, metadata: rawMetadata, isDirectTransfer } = req.body;
        const metadata = parseMetadata(rawMetadata);
        txType = metadata.type || 'funding';
        const channel = isDirectTransfer
            ? 'bank_transfer'
            : (Array.isArray(channels) && channels.length === 1 ? channels[0] : undefined);
        const init = await paymentGatewayService.initializeFunding({
            gatewayCode: 'paystack',
            channel,
            channels: Array.isArray(channels) ? channels : undefined,
            user: { _id: req.user.id, email: req.user.email, name: req.user.name },
            amount,
            metadata,
            isDirectTransfer: Boolean(isDirectTransfer),
        });

        if (isDirectTransfer) {
            return res.json({
                success: true,
                reference: init.reference,
                account_number: init.accountNumber,
                bank_name: init.bankName || 'Bank',
                account_name: init.accountName || 'Zantara Technologies',
                amount: init.amount,
            });
        }

        res.json({ 
            authorization_url: init.authorizationUrl,
            reference: init.reference,
        });
    } catch (err) {
        console.error('Paystack Error:', err.response?.data || err.message);

        if (err.code === 'PAYMENT_INITIALIZATION_AMBIGUOUS') {
            return res.status(202).json({
                message: err.message,
                code: err.code,
                status: 'pending',
                reference: err.reference,
            });
        }

        // Controlled application errors (e.g. fail-closed investment
        // initialization) return a safe client message without exposing
        // internal settings/database details to the customer.
        if (txType === 'investment_buy') {
            return res.status(400).json({
                error: 'Share purchase is temporarily unavailable. Please try again later.',
                code: 'INVALID_INVESTMENT_CONFIGURATION'
            });
        }

        res.status(500).json({ error: 'Paystack error: ' + (err.response?.data?.message || err.message) });
    }
};

const verifyTransaction = async (req, res) => {
    try {
        const { reference } = req.params;

        const transaction = await TransactionStatus.findOne({
            refId: reference,
            userId: req.user.id
        });
        if (!transaction) {
            return res.status(404).json({ success: false, status: 'not_found' });
        }

        const result = await paymentGatewayService.verifyFunding(reference);
        res.json({
            success: result.status === 'success',
            status: result.status,
            type: result.type
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const webhook = async (req, res) => {
    try {
        const result = await paymentGatewayService.routeWebhook('paystack', req);
        return res.status(result.status || 200).send(result.message || 'OK');
    } catch (e) {
        console.error('Paystack webhook error:', e);
        return res.sendStatus(500);
    }
};

module.exports = {
    payment,
    verifyTransaction,
    webhook
};

