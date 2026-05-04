// controllers/monnifyController.js
const crypto = require('crypto');
const TransactionStatus = require('../models/TransactionStatus');
const Wallet = require('../models/Wallet');
const { logTransaction } = require('../utils/transaction');
const { initializePayment, createReservedAccount } = require('../utils/monnify');
const User = require('../models/User');

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

const generateVirtualAccounts = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        // Check if accounts already exist
        if (user.virtualAccounts && user.virtualAccounts.length > 0) {
            return res.json({ message: 'Virtual accounts already exist', accounts: user.virtualAccounts });
        }

        const result = await createReservedAccount(user);
        
        if (result.status) {
            const accounts = result.accounts.map(acc => ({
                bankName: acc.bankName,
                accountName: acc.accountName,
                accountNumber: acc.accountNumber
            }));

            user.virtualAccounts = accounts;
            await user.save();

            res.json({ message: 'Virtual accounts generated successfully', accounts });
        } else {
            res.status(400).json({ message: 'Failed to generate virtual accounts' });
        }
    } catch (err) {
        console.error('Generate Virtual Accounts Error:', err);
        res.status(500).json({ error: err.message });
    }
};

const WebhookEvent = require('../models/WebhookEvent');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');

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
            let userId = data.metaData?.userId;

            // If userId is missing (Reserved Account payment), find user by email
            if (!userId && data.customer?.email) {
                const user = await User.findOne({ email: data.customer.email.toLowerCase() });
                if (user) userId = user._id;
            }

            // Idempotency (TransactionStatus layer)
            let transaction = await TransactionStatus.findOne({ refId });
            
            if (!transaction) {
                // Create the record if it doesn't exist (typical for virtual account transfers)
                transaction = await TransactionStatus.create({
                    refId,
                    status: 'success',
                    service: 'Monnify',
                    amount: amountPaid,
                    userId
                });
                
                if (userId) {
                    await walletService.credit(userId, amountPaid, refId, 'funding');
                    
                    await notificationService.sendInApp(userId, {
                        title: 'Wallet Funded Successfully',
                        message: `Your wallet has been credited with ₦${amountPaid.toLocaleString()} via Bank Transfer.`,
                        type: 'transaction',
                        metadata: { reference: refId }
                    });

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
            } else if (transaction.status === 'pending') {
                // Update existing pending transaction
                transaction.status = 'success';
                transaction.amount = amountPaid;
                await transaction.save();

                if (userId) {
                    await walletService.credit(userId, amountPaid, refId, 'funding');
                    
                    await notificationService.sendInApp(userId, {
                        title: 'Wallet Funded Successfully',
                        message: `Your wallet has been credited with ₦${amountPaid.toLocaleString()} via Monnify.`,
                        type: 'transaction',
                        metadata: { reference: refId }
                    });

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
    generateVirtualAccounts,
    webhook
};
