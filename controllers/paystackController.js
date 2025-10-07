// controllers/paystackController.js
const crypto = require('crypto');
const axios = require('axios');
const TransactionStatus = require('../models/TransactionStatus');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const { logTransaction } = require('../utils/transaction');
const { initializePayment } = require('../utils/paystack');

// Optional helper endpoint (not used by /wallet/fund flow)
// Allows channels/reference to be passed if needed.
const payment = async (req, res) => {
    try {
        const { amount, channels, reference } = req.body;
        const init = await initializePayment(
            req.user.email,
            amount,
            { userId: req.user.id, ...(reference ? { refId: reference } : {}) },
            reference,   // may be undefined; your utils handles it
            channels
        );
        res.json({ authorization_url: init.data.authorization_url, reference: init.data.reference });
    } catch (err) {
        res.status(500).json({ error: 'Paystack error: ' + err.message });
    }
};

const webhook = async (req, res) => {
    try {
        // Because app.js uses express.raw({ type: 'application/json' }),
        // req.body is a Buffer here.
        const secret = process.env.PAYSTACK_SECRET_KEY;
        const signature = req.headers['x-paystack-signature'];

        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '', 'utf8');
        const expected = crypto.createHmac('sha512', secret).update(buf).digest('hex');
        if (expected !== signature) return res.status(401).send('Invalid signature');

        const event = JSON.parse(buf.toString('utf8'));

        // We only act on successful charges (card/ussd/bank_transfer).
        if (event.event !== 'charge.success') return res.sendStatus(200);

        const refId = event?.data?.reference;
        const meta = event?.data?.metadata || {};
        const userId = meta.userId;

        // Defensive verify with Paystack
        const verify = await axios.get(`${process.env.PAYSTACK_BASE_URL}/transaction/verify/${refId}`, {
            headers: { Authorization: `Bearer ${secret}` }
        });

        const ok = verify?.data?.data?.status === 'success';
        const amountKobo = verify?.data?.data?.amount ?? 0;
        const amountNaira = amountKobo / 100;

        if (!ok) {
            await TransactionStatus.updateOne(
                { refId },
                { $set: { status: 'failed', errorMessage: 'Paystack verify returned non-success' } }
            );
            return res.sendStatus(200);
        }

        // Idempotency: only move PENDING -> SUCCESS once
        const upd = await TransactionStatus.updateOne(
            { refId, status: 'pending' },
            { $set: { status: 'success' } }
        );

        // If we actually flipped the row, credit & log once.
        if (upd.modifiedCount === 1) {
            if (userId) {
                await Wallet.updateOne({ userId }, { $inc: { balance: amountNaira } });
            }
            await logTransaction({
                userId,
                refId,
                type: 'funding',
                service: 'Paystack',
                amount: amountNaira,
                status: 'success',
                response: verify.data.data
            });
        }

        return res.sendStatus(200);
    } catch (e) {
        console.error('Paystack webhook error:', e);
        return res.sendStatus(500);
    }
};

module.exports = {
    payment,
    webhook
};
