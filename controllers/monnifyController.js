// controllers/monnifyController.js
const crypto = require('crypto');
const TransactionStatus = require('../models/TransactionStatus');
const Wallet = require('../models/Wallet');
const { logTransaction } = require('../utils/transaction');
const { initializePayment, createReservedAccount, getReservedAccount } = require('../utils/monnify');
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
        
        if (result.status && result.accounts) {
            const accounts = result.accounts.map(acc => ({
                bankName: acc.bankName,
                accountName: acc.accountName,
                accountNumber: acc.accountNumber
            }));

            user.virtualAccounts = accounts;
            await user.save();

            res.json({ message: 'Virtual accounts generated successfully', accounts });
        } else if (result.status && !result.accounts) {
            console.error('Monnify returned success but no accounts:', result);
            res.status(500).json({ message: 'Monnify returned no accounts. Please try again later.' });
        } else {
            res.status(400).json({ message: 'Failed to generate virtual accounts' });
        }
    } catch (err) {
        console.error('Generate Virtual Accounts Error:', err);
        
        // Handle "duplicate reference" by syncing existing accounts
        if (err.message.includes('same reference')) {
            try {
                console.log(`Reference already exists. Syncing accounts for user: ${req.user.id}`);
                const accountReference = `VIRTUAL_${req.user.id}`;
                const syncResult = await getReservedAccount(accountReference);
                
                if (syncResult.status && syncResult.accounts) {
                    const accounts = syncResult.accounts.map(acc => ({
                        bankName: acc.bankName,
                        accountName: acc.accountName,
                        accountNumber: acc.accountNumber
                    }));

                    const user = await User.findById(req.user.id);
                    user.virtualAccounts = accounts;
                    await user.save();

                    return res.json({ 
                        message: 'Virtual accounts synced successfully', 
                        accounts,
                        synced: true 
                    });
                }
            } catch (syncErr) {
                console.error('Sync failed:', syncErr);
            }
        }

        res.status(500).json({ error: err.message });
    }
};

const paymentGatewayService = require('../services/paymentGateway.service');

const webhook = async (req, res) => {
    try {
        const result = await paymentGatewayService.routeWebhook('monnify', req);
        return res.status(result.status || 200).send(result.message || 'OK');
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

