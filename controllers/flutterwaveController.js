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

const WebhookEvent = require('../models/WebhookEvent');
const walletService = require('../services/wallet.service');

const webhook = async (req, res) => {
    try {
        const secretHash = process.env.FLUTTERWAVE_HASH;
        const signature = req.headers['verif-hash'];

        if (!signature || (signature !== secretHash)) {
            console.error('Flutterwave webhook signature mismatch');
            return res.status(401).send('Invalid signature');
        }

        let eventData = req.body;
        if (Buffer.isBuffer(eventData)) {
            eventData = JSON.parse(eventData.toString('utf8'));
        }

        const eventId = eventData.data?.id || `FLW_${eventData.data?.tx_ref}_${Date.now()}`;

        // 1. Idempotency Check
        const existingEvent = await WebhookEvent.findOne({ eventId });
        if (existingEvent) {
            console.log(`Flutterwave event ${eventId} already processed.`);
            return res.sendStatus(200);
        }

        // 2. Store Event Intent
        const webhookEvent = await WebhookEvent.create({
            provider: 'flutterwave',
            eventType: eventData.event || 'charge.completed',
            eventId: eventId,
            payload: eventData,
            status: 'pending'
        });

        // 3. Process Logic
        if (eventData.status === 'successful' || eventData.event === 'charge.completed') {
            const data = eventData.data;
            const refId = data.tx_ref;
            const amountPaid = data.amount;
            const userId = data.meta?.userId;

            const upd = await TransactionStatus.updateOne(
                { refId, status: 'pending' },
                { $set: { status: 'success', service: 'Flutterwave', amount: amountPaid } }
            );

            if (upd.modifiedCount === 1 || (await TransactionStatus.findOne({ refId, status: 'success' }))) {
                if (userId) {
                    // 4. Ledger-backed Credit
                    await walletService.credit(userId, amountPaid, refId, 'funding');
                }

                await logTransaction({
                    userId,
                    refId,
                    type: 'funding',
                    service: 'Flutterwave',
                    amount: amountPaid,
                    status: 'success',
                    response: data
                });
            }
        }

        // 5. Mark Event as Processed
        webhookEvent.status = 'processed';
        await webhookEvent.save();

        return res.sendStatus(200);
    } catch (e) {
        console.error('Flutterwave webhook error:', e);
        return res.sendStatus(500);
    }
};

module.exports = {
    payment,
    webhook
};
