// controllers/monnifyController.js
const User = require('../models/User');
const paymentGatewayService = require('../services/paymentGateway.service');

const getConfiguredMonnifyAdapter = async ({ allowInactive = false } = {}) => {
    const gateway = await paymentGatewayService.getGateway('monnify');
    if (!gateway) throw new Error('Monnify gateway is not configured');
    if (!allowInactive && gateway.status !== 'active') throw new Error('Monnify gateway is not active');
    return { gateway, adapter: paymentGatewayService.getAdapterInstance(gateway) };
};

const payment = async (req, res) => {
    try {
        const { amount } = req.body;
        const init = await paymentGatewayService.initializeFunding({
            gatewayCode: 'monnify',
            user: { _id: req.user.id, email: req.user.email },
            amount,
            metadata: { userId: req.user.id },
        });
        res.json({ authorization_url: init.authorizationUrl, reference: init.reference });
    } catch (err) {
        if (err.code === 'PAYMENT_INITIALIZATION_AMBIGUOUS') {
            return res.status(202).json({
                message: err.message,
                code: err.code,
                status: 'pending',
                reference: err.reference,
            });
        }
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

        const gateway = await paymentGatewayService.getGateway('monnify');
        if (!gateway || gateway.status !== 'active') throw new Error('Monnify gateway is not active');
        const adapter = paymentGatewayService.getAdapterInstance(gateway);
        const result = await adapter.createReservedAccount(user);
        
        if (result.status && result.accounts?.length > 0) {
            const accountReference = result.accountReference || `VIRTUAL_${user._id}`;
            const accounts = result.accounts.map(acc => ({
                bankName: acc.bankName,
                accountName: acc.accountName,
                accountNumber: acc.accountNumber,
                provider: 'monnify',
                gatewayId: String(gateway._id),
                accountReference,
            }));

            user.virtualAccounts = accounts;
            user.virtualAccountGatewaySnapshots = {
                [accountReference]: paymentGatewayService._snapshotGatewayConfig(gateway),
            };
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
                const { gateway, adapter } = await getConfiguredMonnifyAdapter({ allowInactive: true });
                const syncResult = await adapter.getReservedAccount(accountReference);
                
                if (syncResult.status && syncResult.accounts?.length > 0) {
                    const syncedReference = syncResult.accountReference || accountReference;
                    const accounts = syncResult.accounts.map(acc => ({
                        bankName: acc.bankName,
                        accountName: acc.accountName,
                        accountNumber: acc.accountNumber,
                        provider: 'monnify',
                        gatewayId: String(gateway._id),
                        accountReference: syncedReference,
                    }));

                    const user = await User.findById(req.user.id);
                    user.virtualAccounts = accounts;
                    user.virtualAccountGatewaySnapshots = {
                        [syncedReference]: paymentGatewayService._snapshotGatewayConfig(gateway),
                    };
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

