const axios = require('axios');
const crypto = require('crypto');
const TransactionStatus = require('../models/TransactionStatus');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const { logTransaction } = require('../utils/transaction');
const { initializePayment } = require('../utils/paystack');
const investmentService = require('../services/investment.service');

// Optional helper endpoint (not used by /wallet/fund flow)
// Allows channels/reference to be passed if needed.
const payment = async (req, res) => {
    try {
        const { amount, channels, reference, metadata, isDirectTransfer } = req.body;
        const secret = process.env.PAYSTACK_SECRET_KEY;
        const amountKobo = Math.round(amount * 100);

        if (isDirectTransfer) {
            // Use Charge API to get direct bank transfer details
            const response = await axios.post(`${process.env.PAYSTACK_BASE_URL}/charge`, {
                email: req.user.email,
                amount: amountKobo,
                metadata: { userId: req.user.id, ...(metadata || {}), ...(reference ? { refId: reference } : {}) },
                bank_transfer: { account_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
            }, {
                headers: { Authorization: `Bearer ${secret}` }
            });

            if (response.data.status && response.data.data.status === 'send_address') {
                const data = response.data.data;
                
                // Create status record
                await TransactionStatus.create({
                    refId: data.reference,
                    userId: req.user.id,
                    type: metadata?.type || 'funding',
                    amountKobo: amountKobo,
                    channels: ['bank_transfer'],
                    status: 'pending'
                });

                return res.json({
                    success: true,
                    reference: data.reference,
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
            { userId: req.user.id, ...(metadata || {}), ...(reference ? { refId: reference } : {}) },
            reference,
            channels
        );

        await TransactionStatus.create({
            refId: init.data.reference,
            userId: req.user.id,
            type: metadata?.type || 'funding',
            amountKobo: amountKobo,
            channels: channels || ['card', 'bank_transfer'],
            status: 'pending'
        });

        res.json({ 
            authorization_url: init.data.authorization_url, 
            reference: init.data.reference,
        });
    } catch (err) {
        console.error('Paystack Error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Paystack error: ' + (err.response?.data?.message || err.message) });
    }
};

const verifyTransaction = async (req, res) => {
    try {
        const { reference } = req.params;
        const status = await TransactionStatus.findOne({ refId: reference, userId: req.user.id });
        
        if (!status) return res.status(404).json({ message: 'Transaction not found' });
        
        res.json({
            success: true,
            status: status.status, // 'pending', 'success', 'failed'
            type: status.type
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const WebhookEvent = require('../models/WebhookEvent');
const walletService = require('../services/wallet.service');

const webhook = async (req, res) => {
    try {
        const secret = process.env.PAYSTACK_SECRET_KEY;
        const signature = req.headers['x-paystack-signature'];

        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '', 'utf8');
        const expected = crypto.createHmac('sha512', secret).update(buf).digest('hex');
        
        if (expected !== signature) {
            console.error('Paystack webhook signature mismatch');
            return res.status(401).send('Invalid signature');
        }

        const eventData = JSON.parse(buf.toString('utf8'));
        const eventId = eventData.data?.id || `PS_${eventData.data?.reference}_${Date.now()}`;

        // 1. Idempotency Check (WebhookEvent layer)
        const existingEvent = await WebhookEvent.findOne({ eventId });
        if (existingEvent) {
            console.log(`Paystack event ${eventId} already processed.`);
            return res.sendStatus(200);
        }

        // 2. Store Event Intent
        const webhookEvent = await WebhookEvent.create({
            provider: 'paystack',
            eventType: eventData.event,
            eventId: eventId,
            payload: eventData,
            status: 'pending'
        });

        // 3. Process Logic
        if (eventData.event === 'charge.success') {
            const refId = eventData.data.reference;
            const meta = eventData.data.metadata || {};
            const userId = meta.userId;
            const amountNaira = eventData.data.amount / 100;

            // Secondary verify with Paystack (Fintech Safety best practice)
            const verify = await axios.get(`${process.env.PAYSTACK_BASE_URL}/transaction/verify/${refId}`, {
                headers: { Authorization: `Bearer ${secret}` }
            });

            if (verify?.data?.data?.status === 'success') {
                // Idempotency: only move PENDING -> SUCCESS once
                const upd = await TransactionStatus.updateOne(
                    { refId, status: 'pending' },
                    { $set: { status: 'success' } }
                );

                if (upd.modifiedCount === 1) {
                    if (userId) {
                        // 4. Ledger-backed Credit or Fulfillment
                        if (meta.type === 'investment_buy') {
                             await investmentService.fulfillSharePurchase(userId, meta.qty, refId, false);
                        } else {
                             await walletService.credit(userId, amountNaira, refId, 'funding');
                        }
                    }
                    
                    await logTransaction({
                        userId,
                        refId,
                        type: meta.type || 'funding',
                        service: 'Paystack',
                        amount: amountNaira,
                        status: 'success',
                        response: verify.data.data
                    });
                }
            } else {
                webhookEvent.status = 'failed';
                webhookEvent.errorMessage = 'Paystack manual verify failed';
                await webhookEvent.save();
                return res.sendStatus(200); 
            }
        }

        // 4. Mark Event as Processed
        webhookEvent.status = 'processed';
        await webhookEvent.save();

        return res.sendStatus(200);
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
