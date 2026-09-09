// controllers/flutterwaveController.js
const TransactionStatus = require('../models/TransactionStatus');
const Wallet = require('../models/Wallet');
const { logTransaction } = require('../utils/transaction');
const { initializePayment } = require('../utils/flutterwave');

const payment = async (req, res) => {
    try {
        const { amount } = req.body;
        const reference = `FLW_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        const init = await initializePayment(
            req.user.email,
            amount,
            { userId: req.user.id },
            reference
        );
        res.json({ authorization_url: init.data.authorization_url, reference: init.data.reference });
    } catch (err) {
        res.status(500).json({ error: 'Flutterwave error: ' + err.message });
    }
};

const paymentGatewayService = require('../services/paymentGateway.service');

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

