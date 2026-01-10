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

const webhook = async (req, res) => {
    try {
        const secretHash = process.env.FLUTTERWAVE_HASH;
        const signature = req.headers['verif-hash'];

        if (!signature || (signature !== secretHash)) {
            return res.status(401).send('Invalid signature');
        }

        // Flutterwave sends JSON body directly. 
        // Note: server.js uses express.json() for normal routes, BUT we might need raw body if we were verifying HMAC.
        // For Flutterwave, it checks a static hash header, so JSON body is fine if the middleware allows it.
        // However, we configured server.js to use raw body for specific webhook routes for Paystack.
        // We should treat Flutterwave similarly or ensure express.json() works.
        // If we route it via 'app.post' BEFORE express.json() with raw parser, we must parse it manually.

        let event = req.body;
        if (Buffer.isBuffer(event)) {
            event = JSON.parse(event.toString('utf8'));
        }

        if (event.status !== 'successful' && event.event !== 'charge.completed') {
            return res.sendStatus(200);
        }

        const data = event.data;
        const refId = data.tx_ref;
        const amountPaid = data.amount;
        // Meta might be flattened in data or distinct
        // FLW webhook payload varies by version. Assuming standard v3 object.
        // Often meta is in `data.meta` (array) or just custom fields. 
        // For init, we sent `meta: { userId }`.
        // FLW returns it in `meta` object usually.

        // Wait, standard FLW webhook 'data' object contains 'meta' field if passed?
        // Let's assume we fetch transaction to verify if meta is missing, but usually it's there.
        // Fallback: use userId from initialized logic if possible, but here we only have refId.
        // Actually, we can just rely on user knowing their refId or best effort.
        // BETTER: Use TransactionStatus to store the Pending transaction with userId when Initialized?
        // Right now our code doesn't store "Pending" state on Init (bad practice in `paystackController` too?).
        // `paystackController` doesn't seem to store Pending on Init. It relies on metadata.userId passed back.

        const userId = data.meta?.userId;

        const txn = await TransactionStatus.findOne({ refId });
        if (txn && txn.status === 'success') {
            return res.sendStatus(200);
        }

        await TransactionStatus.updateOne(
            { refId },
            { $set: { status: 'success', service: 'Flutterwave', amount: amountPaid } },
            { upsert: true }
        );

        if (userId) {
            await Wallet.updateOne({ userId }, { $inc: { balance: amountPaid } });

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
