// controllers/monnifyController.js
const paymentGatewayService = require('../services/paymentGateway.service');
const virtualAccountService = require('../services/virtualAccount.service');
const { serializeVirtualAccounts } = require('../utils/virtualAccountSerializer');

const payment = async (req, res) => {
    try {
        const { amount } = req.body;
        const init = await paymentGatewayService.initializeFunding({
            gatewayCode: 'monnify',
            user: { _id: req.user.id, email: req.user.email },
            amount,
            metadata: { userId: req.user.id },
        });
        res.json({ authorization_url: init.authorizationUrl, reference: init.reference });
    } catch (err) {
        if (err.code === 'PAYMENT_INITIALIZATION_AMBIGUOUS') {
            return res.status(202).json({
                message: err.message,
                code: err.code,
                status: 'pending',
                reference: err.reference,
            });
        }
        res.status(500).json({ error: 'Monnify error: ' + err.message });
    }
};

const generateVirtualAccounts = async (req, res) => {
    try {
        const result = await virtualAccountService.provision({
            userId: req.user.id,
            providerCode: 'monnify',
            consent: req.body?.consent === true,
            consentVersion: req.body?.consentVersion,
            consentChannel: 'provider_specific_api',
            retryRejected: req.body?.retryRejected === true
        });
        const failed = result.status === 'failed';
        return res.status(failed ? 422 : result.status === 'pending' ? 202 : 200).json({
            success: !failed,
            message: failed
                ? result.message || 'Virtual-account provisioning failed'
                : result.existing ? 'Virtual accounts already exist' : 'Virtual accounts generated successfully',
            status: result.status,
            ...(result.state ? { state: result.state } : {}),
            ...(result.code ? { code: result.code } : {}),
            accounts: serializeVirtualAccounts(result.accounts)
        });
    } catch (err) {
        console.error('[VirtualAccount] Monnify provisioning request failed', {
            code: err.code || 'MONNIFY_VIRTUAL_ACCOUNT_PROVISIONING_FAILED'
        });
        res.status(err.httpStatus || 500).json({ error: err.message, code: err.code });
    }
};

const webhook = async (req, res) => {
    try {
        const result = await paymentGatewayService.routeWebhook('monnify', req);
        return res.status(result.status || 200).send(result.message || 'OK');
    } catch (e) {
        console.error('Monnify webhook error:', e);
        return res.sendStatus(500);
    }
};

module.exports = {
    payment,
    generateVirtualAccounts,
    webhook
};

