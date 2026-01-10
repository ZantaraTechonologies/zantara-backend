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

const webhook = async (req, res) => {
    try {
        const secret = process.env.MONNIFY_SECRET_KEY;
        const signature = req.headers['monnify-signature'];

        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '', 'utf8');
        const expected = crypto.createHmac('sha512', secret).update(buf).digest('hex');

        if (expected !== signature) return res.status(401).send('Invalid signature');

        const event = JSON.parse(buf.toString('utf8'));

        // Monnify event structure: { eventType: "SUCCESSFUL_TRANSACTION", eventData: { ... } }
        // Or sometimes just the data? Docs say: eventType field.

        if (event.eventType !== 'SUCCESSFUL_TRANSACTION') return res.sendStatus(200);

        const data = event.eventData;
        const refId = data.paymentReference;
        const amountPaid = data.amountPaid;
        const userId = data.metaData?.userId;

        // Idempotency
        const txn = await TransactionStatus.findOne({ refId });
        if (txn && txn.status === 'success') {
            return res.sendStatus(200); // Already processed
        }

        // Update or Create TransactionStatus
        await TransactionStatus.updateOne(
            { refId },
            { $set: { status: 'success', service: 'Monnify', amount: amountPaid } },
            { upsert: true }
        );

        if (userId) {
            await Wallet.updateOne({ userId }, { $inc: { balance: amountPaid } });

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
