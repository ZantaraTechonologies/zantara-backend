// controllers/flutterwaveController.js
const paymentGatewayService = require('../services/paymentGateway.service');

const payment = async (req, res) => {
    try {
        const { amount } = req.body;
        const init = await paymentGatewayService.initializeFunding({
            gatewayCode: 'flutterwave',
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
        res.status(500).json({ error: 'Flutterwave error: ' + err.message });
    }
};

const webhook = async (req, res) => {
    try {
        const result = await paymentGatewayService.routeWebhook('flutterwave', req);
        return res.status(result.status || 200).send(result.message || 'OK');
    } catch (e) {
        console.error('Flutterwave webhook error:', e);
        return res.sendStatus(500);
    }
};

module.exports = {
    payment,
    webhook
};

