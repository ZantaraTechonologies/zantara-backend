// controllers/walletFundingController.js
const { initializePayment } = require('../utils/paystack');
const TransactionStatus = require('../models/TransactionStatus');

const { generateReference } = require('../utils/generateID');
const axios = require('axios');
const Wallet = require('../models/Wallet');
const { logTransaction } = require('../utils/transaction');

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
        const callback_url = req.body.callback_url; // Support custom callback

        // Unique reference; keep it stable for idempotency
        const reference = generateReference();

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
            { userId, refId: reference, callback_url }, // metadata
            reference,
            channels
        );

        return res.json({
            authorization_url: init?.data?.authorization_url,
            reference,
        });
    } catch (err) {
        // If init fails, mark the pending row failed so the UI doesn’t spin forever
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

const walletService = require('../services/wallet.service');

const verifyFunding = async (req, res) => {
    try {
        const { reference } = req.query;
        if (!reference) return res.status(400).json({ status: 'not_found' });

        let row = await TransactionStatus.findOne({ refId: reference });

        if (row?.userId && String(row.userId) !== String(req.user.id))
            return res.status(403).json({ status: 'forbidden' });

        if (!row) return res.status(404).json({ status: 'not_found' });

        // If explicitly success or failed, return immediately
        if (row.status === 'success' || row.status === 'failed') {
            return res.json({ status: row.status });
        }

        // --- Active Verification Logic (Fallback for Webhook) ---
        if (row.status === 'pending') {
            try {
                const secret = process.env.PAYSTACK_SECRET_KEY;
                const verify = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
                    headers: { Authorization: `Bearer ${secret}` }
                });

                const data = verify?.data?.data;
                const paystackStatus = data?.status; // 'success', 'failed', 'abandoned'

                if (paystackStatus === 'success') {
                    const amountNaira = (data.amount || 0) / 100;

                    // Atomic Update: Only credit if we change from pending to success (Idempotency)
                    const upd = await TransactionStatus.updateOne(
                        { refId: reference, status: 'pending' },
                        { $set: { status: 'success' } }
                    );

                    if (upd.modifiedCount === 1) {
                        // 4. Ledger-backed Credit via Service
                        await walletService.credit(row.userId, amountNaira, reference, 'funding');

                        // Log Transaction
                        await logTransaction({
                            userId: row.userId,
                            refId: reference,
                            type: 'funding',
                            service: 'Paystack',
                            amount: amountNaira,
                            status: 'success',
                            response: data
                        });

                        return res.json({ status: 'success' });
                    } else {
                        // Already processed by webhook
                        return res.json({ status: 'success' });
                    }
                } else if (['failed', 'abandoned'].includes(paystackStatus)) {
                    await TransactionStatus.updateOne(
                        { refId: reference },
                        { $set: { status: 'failed', errorMessage: data?.gateway_response || 'Payment failed' } }
                    );
                    return res.json({ status: 'failed' });
                }
            } catch (verifyErr) {
                console.error('Verify API error:', verifyErr.message);
            }
        }

        return res.json({ status: row.status });
    } catch (e) {
        console.error('Verify logic error:', e);
        return res.status(500).json({ status: 'error' });
    }
};

module.exports = {
    fundWallet,
    verifyFunding,
};
