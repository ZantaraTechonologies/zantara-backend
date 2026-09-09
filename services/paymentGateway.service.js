const mongoose = require('mongoose');
const PaymentGateway = require('../models/PaymentGateway');
const TransactionStatus = require('../models/TransactionStatus');
const WebhookEvent = require('../models/WebhookEvent');
const walletService = require('./wallet.service');
const notificationService = require('./notification.service');
const investmentService = require('./investment.service');
const { logTransaction } = require('../utils/transaction');
const { generateReference } = require('../utils/generateID');
const { decryptSecret, isEncrypted } = require('../utils/crypto');

const PaystackAdapter = require('../adapters/payment/paystack.adapter');
const MonnifyAdapter = require('../adapters/payment/monnify.adapter');
const FlutterwaveAdapter = require('../adapters/payment/flutterwave.adapter');

class PaymentGatewayService {
    constructor() {
        this.adapters = {
            paystack: PaystackAdapter,
            monnify: MonnifyAdapter,
            flutterwave: FlutterwaveAdapter
        };
    }

    /**
     * Decrypts secrets on a gateway document for internal adapter instantiation.
     * Never returns decrypted document to clients.
     */
    _hydrateGatewayCredentials(gateway) {
        if (!gateway) return null;
        const doc = gateway.toObject ? gateway.toObject() : { ...gateway };
        if (doc.secretKey && isEncrypted(doc.secretKey)) {
            doc.secretKey = decryptSecret(doc.secretKey);
        }
        if (doc.webhookSecret && isEncrypted(doc.webhookSecret)) {
            doc.webhookSecret = decryptSecret(doc.webhookSecret);
        }
        return doc;
    }

    /**
     * Legacy environment fallback for Paystack if no database records exist yet.
     */
    _getLegacyPaystackFallback() {
        const secret = process.env.PAYSTACK_SECRET_KEY;
        if (!secret) return null;

        return {
            _id: 'legacy-env-paystack',
            name: 'Paystack',
            code: 'paystack',
            adapterType: 'paystack',
            status: 'active',
            environment: secret.startsWith('sk_live_') ? 'live' : 'test',
            isDefault: true,
            priority: 1,
            publicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
            secretKey: secret,
            webhookSecret: secret,
            baseUrl: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
            supportedChannels: ['card', 'bank_transfer', 'ussd'],
            metadata: {},
            isLegacyFallback: true
        };
    }

    /**
     * Retrieves a gateway by its unique code.
     */
    async getGateway(code) {
        if (!code) return null;
        const normalizedCode = String(code).trim().toLowerCase();
        let gateway = await PaymentGateway.findOne({ code: normalizedCode });

        if (!gateway) {
            // Backward compatibility fallback to environment if DB is empty
            const count = await PaymentGateway.countDocuments();
            if (count === 0 && normalizedCode === 'paystack') {
                const fallback = this._getLegacyPaystackFallback();
                if (fallback) return fallback;
            }
            return null;
        }

        return this._hydrateGatewayCredentials(gateway);
    }

    /**
     * Retrieves all active payment gateways.
     */
    async getActiveGateways() {
        const gateways = await PaymentGateway.find({ status: 'active' }).sort({ priority: 1, createdAt: 1 });

        if (gateways.length === 0) {
            const count = await PaymentGateway.countDocuments();
            if (count === 0) {
                const fallback = this._getLegacyPaystackFallback();
                if (fallback) return [fallback];
            }
            return [];
        }

        return gateways.map(g => this._hydrateGatewayCredentials(g));
    }

    /**
     * Retrieves the single active default gateway.
     */
    async getDefaultGateway() {
        let gateway = await PaymentGateway.findOne({ status: 'active', isDefault: true });

        if (!gateway) {
            // If no explicit default, try the first active gateway
            gateway = await PaymentGateway.findOne({ status: 'active' }).sort({ priority: 1, createdAt: 1 });
        }

        if (!gateway) {
            const count = await PaymentGateway.countDocuments();
            if (count === 0) {
                const fallback = this._getLegacyPaystackFallback();
                if (fallback) return fallback;
            }
            return null;
        }

        return this._hydrateGatewayCredentials(gateway);
    }

    /**
     * Retrieves all active gateways that support a specific payment channel.
     */
    async getGatewaysForChannel(channel) {
        if (!channel) return this.getActiveGateways();
        const gateways = await PaymentGateway.find({
            status: 'active',
            supportedChannels: channel
        }).sort({ priority: 1, createdAt: 1 });

        if (gateways.length === 0) {
            const count = await PaymentGateway.countDocuments();
            if (count === 0) {
                const fallback = this._getLegacyPaystackFallback();
                if (fallback && fallback.supportedChannels.includes(channel)) {
                    return [fallback];
                }
            }
            return [];
        }

        return gateways.map(g => this._hydrateGatewayCredentials(g));
    }

    /**
     * Instantiates the correct adapter for a given gateway configuration.
     */
    getAdapterInstance(gateway) {
        if (!gateway) throw new Error('[PaymentGatewayService] Gateway configuration is required');
        const AdapterClass = this.adapters[gateway.adapterType || gateway.code];
        if (!AdapterClass) {
            throw new Error(`[PaymentGatewayService] Unsupported gateway adapter type: ${gateway.adapterType || gateway.code}`);
        }
        return new AdapterClass(gateway);
    }

    /**
     * Initializes wallet funding through the resolved gateway.
     */
    async initializeFunding({ gatewayCode, channel, user, amount, callbackUrl, metadata = {}, isDirectTransfer = false }) {
        const rawAmount = Number(amount);
        if (!rawAmount || rawAmount < 50) {
            throw new Error('Minimum funding amount is ₦50.00');
        }

        let gateway = null;

        // 1. Explicit Gateway Selection
        if (gatewayCode) {
            gateway = await this.getGateway(gatewayCode);
            if (!gateway) {
                const err = new Error(`Payment gateway '${gatewayCode}' not found`);
                err.code = 'PAYMENT_GATEWAY_NOT_FOUND';
                throw err;
            }

            if (gateway.status === 'inactive') {
                const err = new Error(`Payment gateway '${gateway.name}' is currently inactive`);
                err.code = 'PAYMENT_GATEWAY_INACTIVE';
                throw err;
            }

            if (gateway.status === 'maintenance') {
                const err = new Error(`Payment gateway '${gateway.name}' is undergoing scheduled maintenance`);
                err.code = 'PAYMENT_GATEWAY_MAINTENANCE';
                throw err;
            }

            if (channel && gateway.supportedChannels && gateway.supportedChannels.length > 0) {
                if (!gateway.supportedChannels.includes(channel)) {
                    const err = new Error(`Channel '${channel}' is not supported by ${gateway.name}`);
                    err.code = 'PAYMENT_CHANNEL_UNSUPPORTED';
                    throw err;
                }
            }
        } else {
            // 2. Default Gateway Fallback
            gateway = await this.getDefaultGateway();
            if (!gateway) {
                const err = new Error('No active payment gateway is configured on the platform');
                err.code = 'PAYMENT_CONFIGURATION_ERROR';
                throw err;
            }
        }

        // 3. Unique Reference Generation
        const reference = gateway.code === 'paystack'
            ? generateReference()
            : `${gateway.code.toUpperCase()}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        const amountKobo = Math.round(rawAmount * 100);
        const channels = channel ? [channel] : (gateway.supportedChannels && gateway.supportedChannels.length ? gateway.supportedChannels : ['card', 'bank_transfer', 'ussd']);

        // 4. Persist Pending TransactionStatus Record
        await TransactionStatus.create({
            refId: reference,
            userId: user._id || user.id,
            type: metadata?.type || 'funding',
            status: 'pending',
            amountKobo,
            amount: rawAmount,
            channels,
            provider: gateway.code,
            service: gateway.name
        });

        // 5. Delegate to Adapter
        const adapter = this.getAdapterInstance(gateway);
        const initResult = await adapter.initializePayment({
            user,
            amount: rawAmount,
            channel,
            reference,
            callbackUrl,
            metadata: {
                ...metadata,
                userId: user._id || user.id,
                refId: reference,
                gateway: gateway.code
            },
            isDirectTransfer
        });

        return {
            success: true,
            authorizationUrl: initResult.authorizationUrl,
            reference,
            provider: gateway.code,
            gateway: gateway.code,
            raw: initResult.raw,
            // For direct transfer details
            accountNumber: initResult.accountNumber,
            bankName: initResult.bankName,
            accountName: initResult.accountName,
            amount: initResult.amount || rawAmount
        };
    }

    /**
     * UNIVERSAL WALLET-CREDIT SAFETY FINALIZER
     * Single shared execution path ensuring exactly-once, atomic, verified wallet credit.
     */
    async finalizeFundingCredit({ transactionStatus, gatewayPaymentResult, source = 'webhook' }) {
        if (!transactionStatus) {
            throw new Error('[Funding Safety] TransactionStatus record is required');
        }

        const refId = transactionStatus.refId;

        // A. If already completed, return existing status without crediting
        if (transactionStatus.status === 'success') {
            return {
                success: true,
                status: 'success',
                alreadyProcessed: true,
                credited: false,
                message: 'Transaction has already been credited successfully.'
            };
        }

        // B. Confirm gateway matches transaction gateway binding
        if (transactionStatus.provider && gatewayPaymentResult.gateway) {
            if (transactionStatus.provider.toLowerCase() !== gatewayPaymentResult.gateway.toLowerCase()) {
                const err = new Error(`[Security Alert] Gateway mismatch: expected ${transactionStatus.provider}, got ${gatewayPaymentResult.gateway}`);
                err.code = 'PAYMENT_GATEWAY_MISMATCH';
                console.error(`[PAYMENT-SECURITY-ALERT] Reference=${refId}: ${err.message}`);
                throw err;
            }
        }

        // C. Confirm provider reported success
        if (gatewayPaymentResult.status !== 'success') {
            if (gatewayPaymentResult.status === 'failed') {
                await TransactionStatus.updateOne(
                    { refId, status: 'pending' },
                    { $set: { status: 'failed', errorMessage: gatewayPaymentResult.message || 'Payment failed at gateway' } }
                );
            }
            return {
                success: false,
                status: gatewayPaymentResult.status,
                message: gatewayPaymentResult.message || 'Payment provider did not confirm success'
            };
        }

        // D. Reference verification
        if (gatewayPaymentResult.reference && gatewayPaymentResult.reference !== refId) {
            const err = new Error(`[Security Alert] Reference mismatch: expected ${refId}, got ${gatewayPaymentResult.reference}`);
            err.code = 'PAYMENT_REFERENCE_MISMATCH';
            console.error(`[PAYMENT-SECURITY-ALERT] ${err.message}`);
            throw err;
        }

        // E. Currency verification
        const confirmedCurrency = (gatewayPaymentResult.currency || 'NGN').toUpperCase();
        if (confirmedCurrency !== 'NGN') {
            const err = new Error(`[Security Alert] Unsupported currency confirmed: ${confirmedCurrency}. Expected NGN.`);
            err.code = 'PAYMENT_CURRENCY_MISMATCH';
            console.error(`[PAYMENT-SECURITY-ALERT] Reference=${refId}: ${err.message}`);
            throw err;
        }

        // F. Amount verification (Decimal/Kobo safe comparison)
        const expectedKobo = transactionStatus.amountKobo
            || Math.round(Number(transactionStatus.amount || 0) * 100);
        const confirmedKobo = Math.round(Number(gatewayPaymentResult.amount || 0) * 100);

        if (expectedKobo > 0 && confirmedKobo !== expectedKobo) {
            const err = new Error(`[Security Alert] Amount mismatch for ${refId}: expected ₦${expectedKobo / 100}, provider confirmed ₦${confirmedKobo / 100}`);
            err.code = 'PAYMENT_AMOUNT_MISMATCH';
            console.error(`[PAYMENT-SECURITY-ALERT] ${err.message}`);

            await TransactionStatus.updateOne(
                { refId },
                { $set: { errorMessage: err.message, status: 'failed' } }
            );
            throw err;
        }

        const amountNaira = confirmedKobo / 100;
        const userId = transactionStatus.userId;

        // G. ATOMIC STATE TRANSITION: pending -> success (Exactly-Once Lock)
        const updateResult = await TransactionStatus.updateOne(
            { refId, status: 'pending' },
            { $set: { status: 'success' } }
        );

        if (updateResult.modifiedCount !== 1) {
            // Another thread/request (webhook or callback) already won the atomic transition
            console.log(`[Funding Safety] Reference ${refId} was already finalized by concurrent process.`);
            return {
                success: true,
                status: 'success',
                alreadyProcessed: true,
                credited: false,
                message: 'Transaction finalized concurrently'
            };
        }

        // H. Ledger-Backed Credit or Share Fulfillment
        if (userId) {
            if (transactionStatus.type === 'investment_buy') {
                const meta = gatewayPaymentResult.metadata || {};
                const qty = Number(meta.qty || 1);
                await investmentService.fulfillSharePurchase(userId, qty, refId, false);
            } else {
                await walletService.credit(userId, amountNaira, refId, 'funding');
            }

            // Non-blocking notification (does not delay financial response)
            const gatewayName = transactionStatus.service || transactionStatus.provider || 'Payment Gateway';
            notificationService.sendInApp(userId, {
                title: transactionStatus.type === 'investment_buy' ? 'Shares Purchased Successfully' : 'Wallet Funded Successfully',
                message: transactionStatus.type === 'investment_buy'
                    ? 'Your purchase of platform shares has been confirmed. Welcome aboard!'
                    : `Your wallet has been credited with ₦${amountNaira.toLocaleString()} via ${gatewayName}.`,
                type: 'transaction',
                metadata: { reference: refId }
            }).catch(notifErr => {
                console.error('[Funding Notification Background Error]', notifErr.message);
            });
        }

        // I. Log immutable transaction record
        await logTransaction({
            userId,
            refId,
            type: transactionStatus.type || 'funding',
            service: transactionStatus.service || gatewayPaymentResult.gateway || 'Payment Gateway',
            amount: amountNaira,
            status: 'success',
            response: gatewayPaymentResult.raw || {}
        });

        return {
            success: true,
            status: 'success',
            credited: true,
            amount: amountNaira,
            reference: refId
        };
    }

    /**
     * Verifies payment via transaction reference (used by client return redirect and manual requery).
     */
    async verifyFunding(reference) {
        if (!reference) {
            return { status: 'not_found', message: 'Reference is required' };
        }

        const transaction = await TransactionStatus.findOne({ refId: reference });
        if (!transaction) {
            return { status: 'not_found', message: 'Transaction record not found' };
        }

        // If already success or failed, return immediately
        if (transaction.status === 'success' || transaction.status === 'failed') {
            return {
                status: transaction.status,
                type: transaction.type,
                reference
            };
        }

        // Resolve the specific gateway bound to this transaction
        const gatewayCode = transaction.provider || 'paystack';
        const gateway = await this.getGateway(gatewayCode);

        if (!gateway) {
            return {
                status: 'pending',
                message: `Gateway '${gatewayCode}' configuration not available for verification`
            };
        }

        const adapter = this.getAdapterInstance(gateway);
        const verifyResult = await adapter.verifyPayment(reference);

        const finalResult = await this.finalizeFundingCredit({
            transactionStatus: transaction,
            gatewayPaymentResult: {
                ...verifyResult,
                gateway: gateway.code
            },
            source: 'client_verify'
        });

        return {
            status: finalResult.status,
            type: transaction.type,
            reference,
            amount: finalResult.amount
        };
    }

    /**
     * Routes and processes incoming webhooks for a specific gateway.
     */
    async routeWebhook(providerCode, req) {
        const gateway = await this.getGateway(providerCode);
        if (!gateway) {
            console.error(`[Webhook Error] No gateway found for provider: ${providerCode}`);
            return { status: 404, message: 'Gateway not found' };
        }

        const adapter = this.getAdapterInstance(gateway);

        // 1. Verify Signature
        const isValid = adapter.verifyWebhookSignature(req.headers, req.body);
        if (!isValid) {
            console.error(`[Webhook Security] Invalid signature for provider: ${providerCode}`);
            return { status: 401, message: 'Invalid webhook signature' };
        }

        // 2. Parse payload
        let payload = req.body;
        if (Buffer.isBuffer(payload)) {
            try {
                payload = JSON.parse(payload.toString('utf8'));
            } catch (e) {
                console.error('[Webhook Error] Failed to parse JSON buffer:', e.message);
                return { status: 400, message: 'Malformed JSON payload' };
            }
        }

        // 3. Normalize Event
        const normalized = adapter.normalizeWebhook(payload);
        const eventId = normalized.eventId;

        // 4. WebhookEvent Idempotency Check
        const existingEvent = await WebhookEvent.findOne({ eventId });
        if (existingEvent) {
            console.log(`[Webhook Event] ${eventId} for ${providerCode} already processed.`);
            return { status: 200, message: 'Event already processed' };
        }

        const webhookEvent = await WebhookEvent.create({
            provider: providerCode,
            eventType: normalized.eventType,
            eventId,
            payload,
            status: 'pending'
        });

        // 5. Process Successful Payment Event
        if (normalized.status === 'success') {
            const refId = normalized.reference;
            let transaction = await TransactionStatus.findOne({ refId });

            // Handle virtual account transfers where TransactionStatus might not exist yet
            if (!transaction && normalized.userId) {
                transaction = await TransactionStatus.create({
                    refId,
                    userId: normalized.userId,
                    type: 'funding',
                    status: 'pending',
                    amountKobo: Math.round(normalized.amount * 100),
                    amount: normalized.amount,
                    channels: ['bank_transfer'],
                    provider: providerCode,
                    service: gateway.name
                });
            }

            if (transaction) {
                // Secondary server-side verification before wallet credit
                const serverVerify = await adapter.verifyPayment(refId);

                if (serverVerify.status === 'success') {
                    await this.finalizeFundingCredit({
                        transactionStatus: transaction,
                        gatewayPaymentResult: {
                            ...serverVerify,
                            gateway: providerCode
                        },
                        source: 'webhook'
                    });
                } else {
                    webhookEvent.status = 'failed';
                    webhookEvent.errorMessage = `Secondary verification failed: ${serverVerify.message}`;
                    await webhookEvent.save();
                    return { status: 200, message: 'Secondary verification unconfirmed' };
                }
            }
        }

        webhookEvent.status = 'processed';
        await webhookEvent.save();

        return { status: 200, message: 'Webhook processed successfully' };
    }
}

module.exports = new PaymentGatewayService();
