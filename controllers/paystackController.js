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
    let txType = 'funding';
    try {
        const { amount, channels, reference, metadata, isDirectTransfer } = req.body;
        const secret = process.env.PAYSTACK_SECRET_KEY;
        const amountKobo = Math.round(amount * 100);
        
        // Always generate a reference if not provided
        const finalReference = reference || `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${Date.now()}`;

        // Authoritative share price snapshot: read the CURRENT server-side price
        // when an investment-buy payment is being initialized. The fullfillment
        // callback MUST use this snapshot instead of re-reading the price later,
        // which eliminates the TOCTOU race that caused wrong share counts when
        // the price moved between init and callback.
        //
        // FAIL-CLOSED: for a NEW investment_buy payment the authoritative share
        // price MUST be obtained and validated BEFORE the TransactionStatus is
        // created and BEFORE the gateway is initialized. If the price cannot be
        // loaded, is missing, non-finite or <= 0, initialization is aborted so
        // no payment record is created and no money can be taken.
        txType = (metadata && metadata.type) || 'funding';
        let sharePriceSnapshot = null;
        if (txType === 'investment_buy') {
            const settings = await investmentService.getInvestmentSettings();
            const sp = Number(settings && settings.sharePrice);
            if (!Number.isFinite(sp) || sp <= 0) {
                const err = new Error('Share purchase is temporarily unavailable. Please try again later.');
                err.code = 'INVALID_INVESTMENT_CONFIGURATION';
                throw err;
            }
            sharePriceSnapshot = sp;
        }

        const makeTxStatus = (channels) => ({
            refId: finalReference,
            userId: req.user.id,
            type: txType,
            amountKobo: amountKobo,
            channels,
            status: 'pending',
            ...(sharePriceSnapshot != null ? { sharePrice: sharePriceSnapshot } : {})
        });

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
                
                // Create status record
                await TransactionStatus.create(makeTxStatus(['bank_transfer']));

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

        await TransactionStatus.create(makeTxStatus(channels || ['card', 'bank_transfer']));

        res.json({ 
            authorization_url: init.data.authorization_url, 
            reference: finalReference,
        });
    } catch (err) {
        console.error('Paystack Error:', err.response?.data || err.message);

        // Controlled application errors (e.g. fail-closed investment
        // initialization) return a safe client message without exposing
        // internal settings/database details to the customer.
        if (txType === 'investment_buy') {
            return res.status(400).json({
                error: 'Share purchase is temporarily unavailable. Please try again later.',
                code: 'INVALID_INVESTMENT_CONFIGURATION'
            });
        }

        res.status(500).json({ error: 'Paystack error: ' + (err.response?.data?.message || err.message) });
    }
};

const paymentGatewayService = require('../services/paymentGateway.service');

const verifyTransaction = async (req, res) => {
    try {
        const { reference } = req.params;

        const transaction = await TransactionStatus.findOne({
            refId: reference,
            userId: req.user.id
        });
        if (!transaction) {
            return res.status(404).json({ success: false, status: 'not_found' });
        }

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

