const { initializePayment: initializePaystack } = require('../utils/paystack');
const { initializePayment: initializeMonnify } = require('../utils/monnify');
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
        const provider = req.body?.provider || 'paystack'; // default to paystack
        
        console.log(`Funding Requested: Amount=${rawAmount}, Provider=${provider}`);
        
        if (!rawAmount || rawAmount < MIN_AMOUNT) {
            return res.status(400).json({ message: `Minimum amount is ₦${MIN_AMOUNT}` });
        }

        const channels = normalizeChannels(req.body?.channels);
        const userId = req.user.id;
        const callback_url = req.body.callback_url;

        // Unique reference
        const reference = provider === 'paystack' ? generateReference() : `MNFY_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        // Persist pending row
        await TransactionStatus.create({
            refId: reference,
            type: 'funding',
            status: 'pending',
            userId,
            amount: rawAmount,
            channels,
            service: provider.charAt(0).toUpperCase() + provider.slice(1)
        });

        let init;
        if (provider === 'monnify') {
            init = await initializeMonnify(
                req.user.email,
                rawAmount,
                { userId, refId: reference },
                reference
            );
        } else {
            // Default to Paystack
            init = await initializePaystack(
                req.user.email,
                rawAmount,
                { userId, refId: reference, callback_url },
                reference,
                channels
            );
        }

        return res.json({
            authorization_url: init?.data?.authorization_url || init?.authorization_url,
            reference,
            provider
        });
    } catch (err) {
        console.error('Funding init error:', err);
        return res
            .status(500)
            .json({ message: 'Funding initialization failed', detail: err?.message || String(err) });
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
