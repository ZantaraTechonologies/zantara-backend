'use strict';

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
const { SUPPORTED_ADAPTER_CODES } = require('../adapters/payment/paymentAdapterRegistry');

class PaymentGatewayService {
    constructor() {
        this.adapters = {
            paystack: PaystackAdapter,
            monnify: MonnifyAdapter,
            flutterwave: FlutterwaveAdapter
        };
    }

    /**
     * Returns true if adapterType is registered in the authoritative adapter registry.
     */
    isSupportedAdapterType(adapterType) {
        if (!adapterType) return false;
        return SUPPORTED_ADAPTER_CODES.includes(String(adapterType).toLowerCase());
    }

    // ─────────────────────────────────────────────────────────
    // INTERNAL HELPERS
    // ─────────────────────────────────────────────────────────

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
     * DEPRECATED: Will be removed once all gateways are fully DB-managed.
     * Used ONLY when PaymentGateway collection is empty.
     */
    _getLegacyPaystackFallback() {
        const secret = process.env.PAYSTACK_SECRET_KEY;
        if (!secret) return null;

        console.log('[PaymentGateway] Using legacy Paystack .env fallback (no DB gateway records exist yet).');
        return {
            _id: 'legacy-env-paystack',
            name: 'Paystack',
            code: 'paystack',
            adapterType: 'paystack',
            status: 'active',
            environment: process.env.PAYSTACK_ENV || 'test',
            isDefault: true,
            publicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
            secretKey: secret,
            webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET || '',
            baseUrl: 'https://api.paystack.co',
            supportedChannels: ['card', 'bank_transfer', 'ussd']
        };
    }

    // ─────────────────────────────────────────────────────────
    // GATEWAY RETRIEVAL
    // ─────────────────────────────────────────────────────────

    /**
     * Retrieves and hydrates a single gateway by code.
     */
    async getGateway(code) {
        const count = await PaymentGateway.countDocuments();
        if (count === 0) {
            // Legacy fallback: only if no DB records exist
            const fallback = this._getLegacyPaystackFallback();
            if (fallback && fallback.code === code) return fallback;
            return null;
        }

        const gateway = await PaymentGateway.findOne({ code: code.toLowerCase() });
        return gateway ? this._hydrateGatewayCredentials(gateway) : null;
    }

    /**
     * Returns all gateways with status=active.
     * Multiple gateways may be simultaneously active.
     */
    async getActiveGateways() {
        const count = await PaymentGateway.countDocuments();
        if (count === 0) {
            const fallback = this._getLegacyPaystackFallback();
            return fallback ? [fallback] : [];
        }
        const gateways = await PaymentGateway.find({ status: 'active' });
        return gateways.map(g => this._hydrateGatewayCredentials(g));
    }

    /**
     * Returns the active gateway marked isDefault=true, or null if none.
     */
    async getDefaultGateway() {
        const count = await PaymentGateway.countDocuments();
        if (count === 0) {
            return this._getLegacyPaystackFallback();
        }
        const gateway = await PaymentGateway.findOne({ isDefault: true, status: 'active' });
        return gateway ? this._hydrateGatewayCredentials(gateway) : null;
    }

    /**
     * Returns active gateways that support the given channel.
     */
    async getGatewaysForChannel(channel) {
        const count = await PaymentGateway.countDocuments();
        if (count === 0) {
            const fallback = this._getLegacyPaystackFallback();
            if (fallback && fallback.supportedChannels.includes(channel)) {
                return [fallback];
            }
            return [];
        }

        const gateways = await PaymentGateway.find({
            status: 'active',
            supportedChannels: channel
        }).sort({ priority: 1, createdAt: 1 });
        return gateways.map(g => this._hydrateGatewayCredentials(g));
    }

    /**
     * Instantiates the correct adapter for a given gateway configuration.
     *
     * Rejects unknown adapter types with a controlled error — it never silently
     * falls back to Paystack or any other gateway.
     */
    getAdapterInstance(gateway) {
        if (!gateway) throw new Error('Payment gateway configuration is required');

        const adapterType = String(gateway.adapterType || gateway.code || '').toLowerCase();

        if (!this.isSupportedAdapterType(adapterType)) {
            const err = new Error(`Unsupported payment gateway adapter: ${adapterType}`);
            err.code = 'PAYMENT_GATEWAY_ADAPTER_UNSUPPORTED';
            throw err;
        }

        const AdapterClass = this.adapters[adapterType];
        if (!AdapterClass) {
            const err = new Error(`Unsupported payment gateway adapter: ${adapterType}`);
            err.code = 'PAYMENT_GATEWAY_ADAPTER_UNSUPPORTED';
            throw err;
        }
        return new AdapterClass(gateway);
    }

    // ─────────────────────────────────────────────────────────
    // FUNDING INITIALIZATION
    // ─────────────────────────────────────────────────────────

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
        } else if (channel) {
            // 2. Channel-based Gateway Selection — the highest-priority active gateway
            //    supporting the requested channel (priority asc, createdAt asc).
            //    No automatic failover: if the top choice errors at initialization,
            //    the user simply retries — the transaction stays bound to one gateway.
            const candidates = await this.getGatewaysForChannel(channel);
            if (candidates.length === 0) {
                const err = new Error(`No active payment gateway supports channel '${channel}'`);
                err.code = 'PAYMENT_CHANNEL_UNSUPPORTED';
                throw err;
            }
            gateway = candidates[0];
        } else {
            // 3. Default Gateway Fallback
            gateway = await this.getDefaultGateway();
            if (!gateway) {
                const err = new Error('No active payment gateway is configured on the platform');
                err.code = 'PAYMENT_CONFIGURATION_ERROR';
                throw err;
            }
        }

        console.log(`[PaymentGateway] Initializing funding via ${gateway.code} for user ${user._id || user.id}`);

        // 3. Unique Reference Generation
        const reference = gateway.code === 'paystack'
            ? generateReference()
            : `${gateway.code.toUpperCase()}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        const amountKobo = Math.round(rawAmount * 100);
        const channels = channel ? [channel] : (gateway.supportedChannels && gateway.supportedChannels.length ? gateway.supportedChannels : ['card', 'bank_transfer', 'ussd']);

        // 4. Persist Pending TransactionStatus Record — gateway permanently bound here
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

    // ─────────────────────────────────────────────────────────
    // UNIVERSAL WALLET-CREDIT SAFETY FINALIZER
    // ─────────────────────────────────────────────────────────

    /**
     * UNIVERSAL WALLET-CREDIT SAFETY FINALIZER
     *
     * Guarantees exactly-once, atomic, fully-verified wallet credit.
     *
     * Atomicity design:
     *   Step 1 — Atomic claim: TransactionStatus pending → processing (modifiedCount === 1 wins the lock)
     *   Step 2 — Atomic credit: walletService.credit() runs its own MongoDB session (wallet + ledger)
     *   Step 3 — Atomic finalize: TransactionStatus processing → success in the same wallet session
     *
     *   If Step 2 throws after Step 1 (e.g. wallet not found, network crash):
     *     - TransactionStatus remains 'processing'
     *     - A retry of this reference sees status='processing', re-enters
     *       the credit path, and is safely handled by walletService.credit()
     *       ledger idempotency (same reference = duplicate-key on WalletLedger).
     *     - Admin can inspect 'processing' records for manual reconciliation.
     *
     *   This is the safest pattern achievable without a 2-phase-commit or
     *   change-data-capture pipeline, and is production-grade for MongoDB.
     *
     * Failure modes:
     *   provider payment confirmed → TransactionStatus = processing
     *                                → walletService crashes
     *                                → status stays 'processing'  ← admin alarm, NOT 'failed'
     *
     *   provider payment confirmed → TransactionStatus = processing
     *                                → walletService succeeds
     *                                → status = 'success'         ← happy path
     *
     *   provider payment NOT confirmed (gateway says failed):
     *                                → status stays 'pending' or → 'failed'  (no credit)
     *
     *   amount / currency / reference mismatch:
     *                                → status = 'reconciliation_required'   (preserve evidence, no credit)
     */
    async finalizeFundingCredit({ transactionStatus, gatewayPaymentResult, source = 'webhook' }) {
        if (!transactionStatus) {
            throw new Error('[Funding Safety] TransactionStatus record is required');
        }

        const refId = transactionStatus.refId;

        // A. Already completed — return idempotently without crediting again
        if (transactionStatus.status === 'success') {
            console.log(`[Funding Safety] Reference ${refId} already finalized. Source: ${source}`);
            return {
                success: true,
                status: 'success',
                alreadyProcessed: true,
                credited: false,
                message: 'Transaction has already been credited successfully.'
            };
        }

        // B. Stuck in processing (previous crash window) — log for admin visibility and skip
        //    The WalletLedger unique index on reference will prevent double-credit if retried.
        if (transactionStatus.status === 'processing') {
            console.warn(`[FUNDING-SAFETY-WARN] Reference ${refId} is stuck in 'processing'. Previous finalization may have crashed mid-flight. Manual reconciliation review required.`);
            return {
                success: false,
                status: 'processing',
                alreadyProcessed: true,
                credited: false,
                message: 'Transaction is being finalized. If this persists, contact support.'
            };
        }

        // C. Already in reconciliation or failed — do not re-process
        if (transactionStatus.status === 'reconciliation_required' || transactionStatus.status === 'failed') {
            console.log(`[Funding Safety] Reference ${refId} is in terminal state '${transactionStatus.status}'. No action taken. Source: ${source}`);
            return {
                success: false,
                status: transactionStatus.status,
                alreadyProcessed: true,
                credited: false,
                message: `Transaction is in state '${transactionStatus.status}' and cannot be re-processed.`
            };
        }

        // D. Confirm gateway matches transaction gateway binding (prevents cross-gateway verification)
        if (transactionStatus.provider && gatewayPaymentResult.gateway) {
            if (transactionStatus.provider.toLowerCase() !== gatewayPaymentResult.gateway.toLowerCase()) {
                const err = new Error(`[Security Alert] Gateway mismatch: expected ${transactionStatus.provider}, got ${gatewayPaymentResult.gateway}`);
                err.code = 'PAYMENT_GATEWAY_MISMATCH';
                console.error(`[PAYMENT-SECURITY-ALERT] Reference=${refId}: ${err.message}`);
                throw err;
            }
        }

        // E. Confirm provider reported success
        if (gatewayPaymentResult.status !== 'success') {
            if (gatewayPaymentResult.status === 'failed') {
                await TransactionStatus.updateOne(
                    { refId, status: 'pending' },
                    { $set: { status: 'failed', errorMessage: gatewayPaymentResult.message || 'Payment failed at gateway' } }
                );
            }
            return {
                success: false,
                status: gatewayPaymentResult.status || 'pending',
                message: gatewayPaymentResult.message || 'Payment provider did not confirm success'
            };
        }

        // F. Reference verification
        if (gatewayPaymentResult.reference && gatewayPaymentResult.reference !== refId) {
            const reason = `Reference mismatch: expected ${refId}, got ${gatewayPaymentResult.reference}`;
            console.error(`[PAYMENT-SECURITY-ALERT] ${reason}`);
            await TransactionStatus.updateOne(
                { refId },
                {
                    $set: {
                        status: 'reconciliation_required',
                        reconciliationReason: reason,
                        confirmedAmountKobo: Math.round(Number(gatewayPaymentResult.amount || 0) * 100),
                        confirmedCurrency: (gatewayPaymentResult.currency || '').toUpperCase(),
                        confirmedProviderRef: gatewayPaymentResult.providerTransactionId || ''
                    }
                }
            );
            const err = new Error(`[Security Alert] ${reason}`);
            err.code = 'PAYMENT_REFERENCE_MISMATCH';
            throw err;
        }

        // G. Currency verification
        const confirmedCurrency = (gatewayPaymentResult.currency || 'NGN').toUpperCase();
        if (confirmedCurrency !== 'NGN') {
            const reason = `Currency mismatch: expected NGN, provider confirmed ${confirmedCurrency}`;
            console.error(`[PAYMENT-SECURITY-ALERT] Reference=${refId}: ${reason}`);
            await TransactionStatus.updateOne(
                { refId },
                {
                    $set: {
                        status: 'reconciliation_required',
                        reconciliationReason: reason,
                        confirmedAmountKobo: Math.round(Number(gatewayPaymentResult.amount || 0) * 100),
                        confirmedCurrency,
                        confirmedProviderRef: gatewayPaymentResult.providerTransactionId || ''
                    }
                }
            );
            const err = new Error(`[Security Alert] ${reason}`);
            err.code = 'PAYMENT_CURRENCY_MISMATCH';
            throw err;
        }

        // H. Amount verification (integer Kobo comparison — avoids floating-point errors)
        const expectedKobo = transactionStatus.amountKobo
            || Math.round(Number(transactionStatus.amount || 0) * 100);
        const confirmedKobo = Math.round(Number(gatewayPaymentResult.amount || 0) * 100);

        if (expectedKobo > 0 && confirmedKobo !== expectedKobo) {
            const reason = `Amount mismatch: expected ₦${expectedKobo / 100}, provider confirmed ₦${confirmedKobo / 100}`;
            console.error(`[PAYMENT-SECURITY-ALERT] Reference=${refId}: ${reason}`);
            // Preserve evidence — do NOT mark as 'failed' (real money moved)
            await TransactionStatus.updateOne(
                { refId },
                {
                    $set: {
                        status: 'reconciliation_required',
                        reconciliationReason: reason,
                        confirmedAmountKobo: confirmedKobo,
                        confirmedCurrency,
                        confirmedProviderRef: gatewayPaymentResult.providerTransactionId || ''
                    }
                }
            );
            const err = new Error(`[Security Alert] ${reason}`);
            err.code = 'PAYMENT_AMOUNT_MISMATCH';
            throw err;
        }

        const amountNaira = confirmedKobo / 100;
        const userId = transactionStatus.userId;

        // ─── ATOMIC STEP 1: Claim the finalization lock ───────────────────────
        //
        // Transition: pending → processing
        //   - Only ONE concurrent caller wins (modifiedCount === 1).
        //   - The losing caller returns immediately — the winning caller proceeds.
        //   - 'processing' is a visible intermediate state for ops monitoring.
        //   - If the process crashes after this point, status='processing' remains
        //     and is a clear signal for admin reconciliation.
        //
        const claimResult = await TransactionStatus.updateOne(
            { refId, status: 'pending' },
            {
                $set: {
                    status: 'processing',
                    confirmedAmountKobo: confirmedKobo,
                    confirmedCurrency,
                    confirmedProviderRef: gatewayPaymentResult.providerTransactionId || ''
                }
            }
        );

        if (claimResult.modifiedCount !== 1) {
            // Another concurrent process already claimed (or it was already success/processing)
            console.log(`[Funding Safety] Reference ${refId}: finalization lock already claimed by concurrent process. Source: ${source}`);
            return {
                success: true,
                status: 'success',
                alreadyProcessed: true,
                credited: false,
                message: 'Transaction finalized concurrently'
            };
        }

        // ─── ATOMIC STEP 2: Credit wallet + create ledger ─────────────────────
        //
        // walletService.credit() uses its own MongoDB session internally
        // (Wallet balance update + WalletLedger creation are atomic within that session).
        //
        // If this throws, TransactionStatus stays 'processing'.
        // That state is an admin alarm — NOT a silent failure.
        //
        try {
            if (userId) {
                if (transactionStatus.type === 'investment_buy') {
                    const meta = gatewayPaymentResult.metadata || {};
                    const qty = Number(meta.qty || 1);
                    await investmentService.fulfillSharePurchase(userId, qty, refId, false);
                } else {
                    await walletService.credit(userId, amountNaira, refId, 'funding');
                }
            }
        } catch (creditErr) {
            // Critical: wallet credit failed AFTER the lock was claimed.
            // Status stays 'processing' — do NOT mark success or failed.
            // This is visible to admin for manual reconciliation.
            console.error(`[FUNDING-CRITICAL] Reference=${refId}: wallet credit failed after lock claimed. Status='processing'. Manual review required.`, creditErr.message);
            throw creditErr;
        }

        // ─── ATOMIC STEP 3: Finalize to success ───────────────────────────────
        //
        // Transition: processing → success
        // If this fails (e.g. transient network error) after the wallet was credited:
        //   - Status stays 'processing' — admin can safely re-finalize since
        //     walletService.credit() is idempotent via unique WalletLedger reference.
        //
        await TransactionStatus.updateOne(
            { refId, status: 'processing' },
            { $set: { status: 'success' } }
        );

        // Non-blocking notification — never delays or rolls back financial result
        if (userId) {
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

        // Immutable audit log
        await logTransaction({
            userId,
            refId,
            type: transactionStatus.type || 'funding',
            service: transactionStatus.service || gatewayPaymentResult.gateway || 'Payment Gateway',
            amount: amountNaira,
            status: 'success',
            response: gatewayPaymentResult.raw || {}
        });

        console.log(`[Funding Safety] Reference ${refId}: finalized successfully. Amount ₦${amountNaira}. Source: ${source}`);

        return {
            success: true,
            status: 'success',
            credited: true,
            amount: amountNaira,
            reference: refId
        };
    }

    // ─────────────────────────────────────────────────────────
    // CLIENT VERIFICATION
    // ─────────────────────────────────────────────────────────

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

        // If already in a terminal or intermediate state, report without re-verifying
        if (transaction.status === 'success') {
            return { status: 'success', type: transaction.type, reference };
        }

        if (transaction.status === 'failed') {
            return { status: 'failed', type: transaction.type, reference };
        }

        if (transaction.status === 'reconciliation_required') {
            return {
                status: 'reconciliation_required',
                type: transaction.type,
                reference,
                message: 'This transaction requires manual review by our support team.'
            };
        }

        if (transaction.status === 'processing') {
            // Already claimed by concurrent process — safe to tell client it is finalizing
            return {
                status: 'processing',
                type: transaction.type,
                reference,
                message: 'Your payment is being finalized. Please wait a moment.'
            };
        }

        // Resolve the specific gateway bound to this transaction (never trust frontend)
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

    // ─────────────────────────────────────────────────────────
    // WEBHOOK ROUTING
    // ─────────────────────────────────────────────────────────

    /**
     * Routes and processes incoming webhooks for a specific gateway.
     *
     * WebhookEvent idempotency:
     *   We attempt to CREATE the WebhookEvent record first (create-before-check).
     *   The unique index on eventId turns a duplicate delivery into a duplicate-key error,
     *   which we catch and treat as "already processed" — race-safe without a findOne+create gap.
     */
    async routeWebhook(providerCode, req) {
        const gateway = await this.getGateway(providerCode);
        if (!gateway) {
            console.error(`[Webhook Error] No gateway found for provider: ${providerCode}`);
            return { status: 404, message: 'Gateway not found' };
        }

        const adapter = this.getAdapterInstance(gateway);

        // 1. Verify Signature first — reject unauthenticated requests before any DB work
        const isValid = adapter.verifyWebhookSignature(req.headers, req.body);
        if (!isValid) {
            console.error(`[PAYMENT-SECURITY-ALERT] Invalid webhook signature for provider: ${providerCode}`);
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

        // 4. WebhookEvent Idempotency — CREATE FIRST (race-safe)
        //    The unique index on eventId makes this atomic:
        //    - First delivery succeeds: create returns a new document.
        //    - Duplicate delivery throws a 11000 duplicate-key error → already processed.
        //    This avoids the findOne+create TOCTOU race.
        let webhookEvent;
        try {
            webhookEvent = await WebhookEvent.create({
                provider: providerCode,
                eventType: normalized.eventType,
                eventId,
                payload,
                status: 'pending'
            });
        } catch (dbErr) {
            if (dbErr.code === 11000) {
                // Duplicate event — idempotent success
                console.log(`[Webhook Idempotency] eventId=${eventId} for ${providerCode} already exists. Duplicate delivery ignored.`);
                return { status: 200, message: 'Event already processed' };
            }
            throw dbErr;
        }

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
                // Secondary server-side verification before wallet credit (never trust webhook alone)
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
                    console.warn(`[Webhook] Secondary verification failed for ${refId} via ${providerCode}: ${serverVerify.message}`);
                    return { status: 200, message: 'Secondary verification unconfirmed' };
                }
            } else {
                console.warn(`[Webhook] No TransactionStatus found for refId=${refId} from ${providerCode}`);
            }
        }

        webhookEvent.status = 'processed';
        await webhookEvent.save();

        return { status: 200, message: 'Webhook processed successfully' };
    }

    // ─────────────────────────────────────────────────────────
    // FUTURE ADMIN SUPPORT (PHASE 3 PREPARATION)
    // ─────────────────────────────────────────────────────────

    /**
     * Returns all gateway documents (for Admin use only — not client-facing).
     * Caller must sanitize with paymentGatewaySerializer before returning to API.
     */
    async listGatewaysForAdmin() {
        return PaymentGateway.find().sort({ priority: 1, createdAt: 1 });
    }
}

module.exports = new PaymentGatewayService();
