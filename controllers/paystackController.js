const axios = require('axios');
const crypto = require('crypto');
const TransactionStatus = require('../models/TransactionStatus');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const { logTransaction } = require('../utils/transaction');
const { initializePayment } = require('../utils/paystack');
const investmentService = require('../services/investment.service');

// Optional helper for robust metadata parsing
const parseMetadata = (metadata) => {
    if (!metadata) return {};
    if (typeof metadata === 'string') {
        try { return JSON.parse(metadata); } catch (e) { return {}; }
    }
    return metadata;
};

// Optional helper endpoint (not used by /wallet/fund flow)
// Allows channels/reference to be passed if needed.
const payment = async (req, res) => {
    try {
        const { amount, channels, reference, metadata, isDirectTransfer } = req.body;
        const secret = process.env.PAYSTACK_SECRET_KEY;
        const amountKobo = Math.round(amount * 100);
        
        // Always generate a reference if not provided
        const finalReference = reference || `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${Date.now()}`;

        if (isDirectTransfer) {
            // Use Charge API to get direct bank transfer details
            const response = await axios.post(`${process.env.PAYSTACK_BASE_URL}/charge`, {
                email: req.user.email,
                amount: amountKobo,
                reference: finalReference, // REQUIRED to prevent "Charge attempted" error
                metadata: { 
                    userId: req.user.id, 
                    ...(metadata || {}), 
                    refId: finalReference 
                },
                bank_transfer: { account_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
            }, {
                headers: { Authorization: `Bearer ${secret}` }
            });

            if (response.data.status) {
                const data = response.data.data;
                
                // If it's bank transfer, it should be in 'send_address' or similar state
                // Or sometimes it's immediately success/pending
                
                // Create status record
                await TransactionStatus.create({
                    refId: finalReference,
                    userId: req.user.id,
                    type: metadata?.type || 'funding',
                    amountKobo: amountKobo,
                    channels: ['bank_transfer'],
                    status: 'pending'
                });

                return res.json({
                    success: true,
                    reference: finalReference,
                    account_number: data.account_number,
                    bank_name: data.bank?.name || 'Bank',
                    account_name: data.account_name || 'Zantara Technologies',
                    amount: amountKobo / 100
                });
            }
            throw new Error(response.data.message || 'Failed to initialize direct transfer');
        }

        // Standard Initialize for all other channels (Card, USSD, etc)
        const init = await initializePayment(
            req.user.email,
            amount,
            { userId: req.user.id, ...(metadata || {}), refId: finalReference },
            finalReference,
            channels
        );

        await TransactionStatus.create({
            refId: finalReference,
            userId: req.user.id,
            type: metadata?.type || 'funding',
            amountKobo: amountKobo,
            channels: channels || ['card', 'bank_transfer'],
            status: 'pending'
        });

        res.json({ 
            authorization_url: init.data.authorization_url, 
            reference: finalReference,
        });
    } catch (err) {
        console.error('Paystack Error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Paystack error: ' + (err.response?.data?.message || err.message) });
    }
};

const paymentGatewayService = require('../services/paymentGateway.service');

const verifyTransaction = async (req, res) => {
    try {
        const { reference } = req.params;
        const result = await paymentGatewayService.verifyFunding(reference);
        res.json({
            success: result.status === 'success',
            status: result.status,
            type: result.type
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const webhook = async (req, res) => {
    try {
        const result = await paymentGatewayService.routeWebhook('paystack', req);
        return res.status(result.status || 200).send(result.message || 'OK');
    } catch (e) {
        console.error('Paystack webhook error:', e);
        return res.sendStatus(500);
    }
};

module.exports = {
    payment,
    verifyTransaction,
    webhook
};

