// controllers/walletFundingController.js
const { initializePayment } = require('../utils/paystack');
const TransactionStatus = require('../models/TransactionStatus');

const ALLOWED_CHANNELS = ['card', 'ussd', 'bank_transfer'];
const MIN_AMOUNT = 50; // ₦

function normalizeChannels(input) {
    if (!input) return ALLOWED_CHANNELS;
    const arr = Array.isArray(input) ? input : [input];
    const cleaned = arr.filter((c) => ALLOWED_CHANNELS.includes(String(c)));
    return cleaned.length ? cleaned : ALLOWED_CHANNELS;
}

const fundWallet = async (req, res) => {
    try {
        const rawAmount = Number(req.body?.amount);
        if (!rawAmount || rawAmount < MIN_AMOUNT) {
            return res.status(400).json({ message: `Minimum amount is ₦${MIN_AMOUNT}` });
        }

        const channels = normalizeChannels(req.body?.channels);
        const userId = req.user.id;

        // Unique reference; keep it stable for idempotency
        const reference = `WALLET_${userId}_${Date.now()}`;

        // Persist pending row so /verify and the webhook have a single source of truth
        await TransactionStatus.create({
            refId: reference,
            type: 'funding',
            status: 'pending',
            userId,                 // (schema can ignore unknown fields if not declared)
            amount: rawAmount,      // store for reporting (webhook uses Paystack’s verified amount)
            channels,
        });

        // Initialize Paystack with the SAME reference
        const init = await initializePayment(
            req.user.email,
            rawAmount,
            { userId, refId: reference }, // metadata
            reference,
            channels
        );

        return res.json({
            authorization_url: init?.data?.authorization_url,
            reference,
        });
    } catch (err) {
        // If init fails, mark the pending row failed so the UI doesn’t spin forever
        const userId = req.user?.id;
        const maybeRef = typeof err?.reference === 'string' ? err.reference : null;

        if (maybeRef) {
            await TransactionStatus.updateOne(
                { refId: maybeRef, status: 'pending' },
                { $set: { status: 'failed', errorMessage: 'Init failed before checkout' } }
            );
        }

        return res
            .status(500)
            .json({ message: 'Paystack init failed', detail: err?.message || String(err) });
    }
};

const verifyFunding = async (req, res) => {
    try {
        const { reference } = req.query;
        if (!reference) return res.status(400).json({ status: 'not_found' });

        const row = await TransactionStatus.findOne({ refId: reference });

        // (Optional security): only allow the owner to query their own reference.
        // If your schema stores userId above, uncomment the next two lines:
        if (row?.userId && String(row.userId) !== String(req.user.id))
            return res.status(403).json({ status: 'forbidden' });

        return res.json({ status: row?.status || 'not_found' });
    } catch (e) {
        return res.status(500).json({ status: 'error' });
    }
};

module.exports = {
    fundWallet,
    verifyFunding,
};
