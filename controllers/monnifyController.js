// controllers/monnifyController.js
const crypto = require('crypto');
const TransactionStatus = require('../models/TransactionStatus');
const Wallet = require('../models/Wallet');
const { logTransaction } = require('../utils/transaction');
const { initializePayment } = require('../utils/monnify');

const payment = async (req, res) => {
    try {
        const { amount } = req.body;
        // Generate a unique reference or use one provided (but usually backend generates)
        const reference = `MNFY_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        const init = await initializePayment(
            req.user.email,
            amount,
            { userId: req.user.id },
            reference
        );
        res.json({ authorization_url: init.data.authorization_url, reference: init.data.reference });
    } catch (err) {
        res.status(500).json({ error: 'Monnify error: ' + err.message });
    }
};

const WebhookEvent = require('../models/WebhookEvent');
const walletService = require('../services/wallet.service');

const webhook = async (req, res) => {
    try {
        const secret = process.env.MONNIFY_SECRET_KEY;
        const signature = req.headers['monnify-signature'];

        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '', 'utf8');
        const expected = crypto.createHmac('sha512', secret).update(buf).digest('hex');

        if (expected !== signature) {
            console.error('Monnify webhook signature mismatch');
            return res.status(401).send('Invalid signature');
        }

        const eventData = JSON.parse(buf.toString('utf8'));
        const eventId = eventData.eventData?.transactionReference || `MNFY_${Date.now()}`;

        // 1. Idempotency Check
        const existingEvent = await WebhookEvent.findOne({ eventId });
        if (existingEvent) {
            console.log(`Monnify event ${eventId} already processed.`);
            return res.sendStatus(200);
        }

        // 2. Store Event Intent
        const webhookEvent = await WebhookEvent.create({
            provider: 'monnify',
            eventType: eventData.eventType,
            eventId: eventId,
            payload: eventData,
            status: 'pending'
        });

        // 3. Process Logic
        if (eventData.eventType === 'SUCCESSFUL_TRANSACTION') {
            const data = eventData.eventData;
            const refId = data.paymentReference;
            const amountPaid = data.amountPaid;
            const userId = data.metaData?.userId;

            // Idempotency (TransactionStatus layer)
            const upd = await TransactionStatus.updateOne(
                { refId, status: 'pending' },
                { $set: { status: 'success', service: 'Monnify', amount: amountPaid } }
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
                    service: 'Monnify',
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
        console.error('Monnify webhook error:', e);
        return res.sendStatus(500);
    }
};

module.exports = {
    payment,
    webhook
};
