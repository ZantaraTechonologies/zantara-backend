'use strict';

const mongoose = require('mongoose');
const PaymentGateway = require('../models/PaymentGateway');
const TransactionStatus = require('../models/TransactionStatus');
const WebhookEvent = require('../models/WebhookEvent');
const WalletLedger = require('../models/WalletLedger');
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

const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60 * 1000;

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

        // Authoritative share price snapshot for investment-buy payments: read the
        // CURRENT server-side price at INIT time. Fulfillment must bind to this
        // snapshot (see _finalizeAfterClaim), never a fresh re-read, eliminating
        // the TOCTOU where a price change mid-payment broke legitimate purchases.
        //
        // FAIL-CLOSED: for a NEW investment_buy payment the authoritative share
        // price MUST be obtained and validated BEFORE the TransactionStatus is
        // created and BEFORE the gateway is initialized. If the price cannot be
        // loaded, is missing, non-finite or <= 0, initialization is aborted so
        // the gateway never gets the chance to take the customer's money.
        const txType = metadata?.type || 'funding';
        let sharePriceSnapshot = null;
        if (txType === 'investment_buy') {
            const invSettings = await investmentService.getInvestmentSettings();
            const sp = Number(invSettings && invSettings.sharePrice);
            if (!Number.isFinite(sp) || sp <= 0) {
                const err = new Error('Share purchase is temporarily unavailable. Please try again later.');
                err.code = 'INVALID_INVESTMENT_CONFIGURATION';
                throw err;
            }
            sharePriceSnapshot = sp;
        }

        // 4. Persist Pending TransactionStatus Record — gateway permanently bound here
        await TransactionStatus.create({
            refId: reference,
            userId: user._id || user.id,
            type: txType,
            status: 'pending',
            amountKobo,
            amount: rawAmount,
            channels,
            provider: gateway.code,
            service: gateway.name,
            ...(sharePriceSnapshot != null ? { sharePrice: sharePriceSnapshot } : {})
        });

        // 5. Delegate to Adapter
        const adapter = this.getAdapterInstance(gateway);
        // Resolve the effective callback URL exactly as the adapter will (the
        // adapter defaults to CLIENT_BASE_URL/<gateway>/return). The mobile
        // WebView needs this host to distinguish the definitive final RETURN
        // navigation from intermediate 3DS/issuer/card-auth navigation.
        const effectiveCallbackUrl = callbackUrl
            || `${process.env.CLIENT_BASE_URL || 'http://localhost:5173'}/${gateway.code}/return`;
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
            callbackUrl: effectiveCallbackUrl,
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
     *     - Admin can inspect 'processing' records for manual reconciliation.
     *
     *   NOTE: Exactly-once credit is enforced by the TransactionStatus state
     *   machine (atomic claim + terminal-success check), NOT by the
     *   WalletLedger.reference index — that index is intentionally non-unique
     *   and must never be relied on for dedupe.
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
     *
     * Failed-state recovery (narrow, webhook-only):
     *   A FUNDING record currently in 'failed' may ONLY be recovered by an
     *   authenticated provider webhook whose independent server-to-server
     *   verification re-confirms explicit provider success. Recovery requires
     *   strict eligibility (see _isWebhookRecoveryEligible) and an atomic
     *   failed → processing claim before re-using the exact same credit path.
     *   No client/callback/admin source, and no 'reconciliation_required'
     *   record, may ever auto-recover.
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
        //    Exactly-once credit is enforced by the TransactionStatus state machine
        //    (atomic pending→processing claim + terminal-success check), NOT by the
        //    WalletLedger.reference index — that index is intentionally non-unique and
        //    must not be relied on for dedupe. Records stuck in 'processing' need
        //    manual reconciliation review.
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

        // C. Already in reconciliation — terminal, never re-process automatically.
        //    reconciliation_required preserves evidence of a real-money anomaly for
        //    manual admin review. Do NOT auto-recover it.
        if (transactionStatus.status === 'reconciliation_required') {
            console.log(`[Funding Safety] Reference ${refId} is in terminal state 'reconciliation_required'. No action taken. Source: ${source}`);
            return {
                success: false,
                status: 'reconciliation_required',
                alreadyProcessed: true,
                credited: false,
                message: `Transaction is in state 'reconciliation_required' and cannot be re-processed.`
            };
        }

        // C1. Mid-settlement (claim acquired, settle-step in flight/crashed) — a
        //     competing webhook must never re-credit while the recovery sweep or
        //     an admin is finishing this payment. The settle path completes it
        //     exactly-once (settlement_pending → success); here we defer.
        if (transactionStatus.status === 'settlement_pending') {
            console.log(`[Funding Safety] Reference ${refId} is mid-settlement ('settlement_pending'). Deferring webhook finalization. Source: ${source}`);
            return {
                success: false,
                status: 'settlement_pending',
                alreadyProcessed: true,
                credited: false,
                message: 'Transaction is being finalized by reconciliation. Please wait a moment.'
            };
        }

        // C2. Failed state — by default terminal, EXCEPT the single narrow,
        //     authenticated-webhook FUNDING recovery (see _handleFailedState).
        //     No client / callback / admin source may ever resurrect a failed record.
        if (transactionStatus.status === 'failed') {
            return this._handleFailedState({ transactionStatus, gatewayPaymentResult, refId, source });
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
        //    Only an EXPLICIT terminal 'failed' verdict marks the record failed.
        //    pending / processing / ambiguous / not_found / transport errors must
        //    never permanently mark the record failed — they are left 'pending'
        //    (or 'processing') so a later verify or webhook can still recover.
        if (gatewayPaymentResult.status !== 'success') {
            if (gatewayPaymentResult.status === 'failed') {
                await TransactionStatus.updateOne(
                    { refId, status: 'pending' },
                    { $set: { status: 'failed', errorMessage: gatewayPaymentResult.message || 'Payment failed at gateway' } }
                );

                // Terminal funding-failed advisory (In-App + Push only; never SMS/email,
                // never claims refund/credit). Fired only AFTER the record is durably
                // marked failed. Non-blocking and deduplicated by reference.
                if (transactionStatus.userId) {
                    const failedAmount = ((transactionStatus.amountKobo || 0) / 100) || 0;
                    notificationService.sendFundingAdvisory(transactionStatus.userId, {
                        kind: 'failed',
                        amount: failedAmount,
                        reference: refId
                    }).catch(advisoryErr => {
                        console.error('[Funding Advisory Error]', advisoryErr && advisoryErr.message);
                    });
                }
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

        // ─── ATOMIC STEP 2 + 3: Credit wallet/fulfill, finalize to success ─────
        // Extracted into _finalizeAfterClaim so the webhook failed-state recovery
        // can atomically claim failed → processing and then reuse this EXACT
        // identical credit + finalize path (guaranteeing true exactly-once credit).
        return this._finalizeAfterClaim({
            transactionStatus,
            gatewayPaymentResult,
            refId,
            confirmedKobo,
            confirmedCurrency,
            source,
            recovery: false
        });
    }

    /**
     * Atomically finalizes an already-claimed (processing) transaction:
     * wallet credit / investment fulfillment → processing → success → notification → immutable audit log.
     *
     * Caller MUST have already claimed the state machine lock, otherwise the
     * processing → success transition below will be a no-op and the caller
     * returns success:false. Exactly-once is preserved by the state machine.
     */
    async _finalizeAfterClaim({ transactionStatus, gatewayPaymentResult, refId, confirmedKobo, confirmedCurrency, source, recovery = false }) {
        const amountNaira = confirmedKobo / 100;
        const userId = transactionStatus.userId;

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
                    // CRIT 3: Share quantity MUST be derived from the bank-verified
                    // amount (confirmedKobo) at the SERVER-side share price. Client-
                    // supplied gateway metadata.qty is never trusted — a payer can
                    // inject an arbitrary quantity into payment metadata and receive
                    // far more shares than were purchased.
                    //
                    // TOCTOU fix: the authoritative price is the SHARE-PRICE SNAPSHOT
                    // taken when the payment was initialized (transactionStatus.sharePrice).
                    // The quantity is bound to that snapshot, so a price change between
                    // init and fulfillment can neither reject a legitimate payment nor
                    // silently change how many shares the payer bought. Records created
                    // before the snapshot feature (no sharePrice stored) fall back to a
                    // current-settings read for backward compatibility.
                    let sharePrice;
                    if (Number(transactionStatus.sharePrice) > 0) {
                        sharePrice = Number(transactionStatus.sharePrice);
                    } else {
                        const settings = await investmentService.getInvestmentSettings();
                        sharePrice = Number(settings.sharePrice);
                    }
                    if (!(sharePrice > 0)) {
                        throw new Error('Invalid share price configured for investment fulfillment');
                    }

                    const perShareKobo = sharePrice * 100;
                    if (!Number.isInteger(perShareKobo) || perShareKobo <= 0) {
                        throw new Error('Share price does not reconcile to whole kobo');
                    }

                    if (confirmedKobo % perShareKobo !== 0) {
                        throw new Error(`Confirmed amount ₦${amountNaira.toLocaleString()} is not a whole multiple of share price ₦${sharePrice.toLocaleString()} per share`);
                    }

                    const qty = confirmedKobo / perShareKobo;

                    const metaQty = Number((gatewayPaymentResult.metadata || {}).qty);
                    if (metaQty > 0 && metaQty !== qty) {
                        console.error(`[PAYMENT-SECURITY-ALERT] Reference=${refId}: metadata.qty=${metaQty} diverges from amount-derived qty=${qty}. Deriving from confirmed amount.`);
                    }

                    await investmentService.fulfillSharePurchase(userId, qty, refId, false, null, sharePrice);
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
        // If this fails (e.g. transient network error) after the wallet was credited,
        // the record stays 'processing' and is a clear admin signal for manual review.
        //
        await TransactionStatus.updateOne(
            { refId, status: 'processing' },
            { $set: { status: 'success' } }
        );

        // Non-blocking notification — never delays or rolls back financial result.
        // Professionalized copy: customer-facing funding method only (gateway
        // names are NEVER surfaced), no SMS for funding, and the event is
        // deduplicated by reference so a concurrent duplicate dispatch is a no-op.
        if (userId) {
            notificationService.sendFundingSuccess({
                userId,
                amount: amountNaira,
                method: (transactionStatus.channels && transactionStatus.channels[0]) || transactionStatus.channel || 'funding',
                reference: refId,
                type: transactionStatus.type || 'funding'
            }).catch(notifErr => {
                console.error('[Funding Notification Background Error]', notifErr && notifErr.message);
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

        if (recovery) {
            console.log(`[FUNDING-RECOVERY] Reference ${refId}: recovered 'failed' → 'success' via authenticated webhook. Amount ₦${amountNaira}.`);
        }
        console.log(`[Funding Safety] Reference ${refId}: finalized successfully. Amount ₦${amountNaira}. Source: ${source}`);

        return {
            success: true,
            status: 'success',
            credited: true,
            amount: amountNaira,
            reference: refId,
            ...(recovery ? { recovered: true } : {})
        };
    }

    /**
     * Handles a TransactionStatus record currently in 'failed'.
     *
     * By default 'failed' is terminal. The single exception is an authenticated
     * provider WEBHOOK that re-confirms provider success for a FUNDING transaction
     * (source === 'webhook' AND strict _isWebhookRecoveryEligible passes). Once
     * eligible, the recovery atomically claims failed → processing (modifiedCount === 1)
     * and reuses _finalizeAfterClaim, so the credit is exactly-once.
     */
    async _handleFailedState({ transactionStatus, gatewayPaymentResult, refId, source }) {
        const eligible = await this._isWebhookRecoveryEligible({ transactionStatus, gatewayPaymentResult, refId, source });

        if (!eligible) {
            console.log(`[Funding Safety] Reference ${refId} is in terminal state 'failed'. No action taken. Source: ${source}`);
            return {
                success: false,
                status: 'failed',
                alreadyProcessed: true,
                credited: false,
                message: `Transaction is in state 'failed' and cannot be re-processed.`
            };
        }

        const confirmedCurrency = (gatewayPaymentResult.currency || 'NGN').toUpperCase();
        const confirmedKobo = Math.round(Number(gatewayPaymentResult.amount || 0) * 100);

        // ─── ATOMIC RECOVERY CLAIM: failed → processing ────────────────────────
        // Exactly one concurrent webhook wins (modifiedCount === 1). The losing
        // caller re-reads and reports the winner's state; NO second credit.
        const recoveryClaim = await TransactionStatus.updateOne(
            { refId, status: 'failed' },
            {
                $set: {
                    status: 'processing',
                    confirmedAmountKobo: confirmedKobo,
                    confirmedCurrency,
                    confirmedProviderRef: gatewayPaymentResult.providerTransactionId || '',
                    reconciliationReason: `Authenticated webhook recovery (providerTransactionId=${gatewayPaymentResult.providerTransactionId || 'n/a'}; gateway=${gatewayPaymentResult.gateway || 'n/a'}; source=${source})`
                }
            }
        );

        if (recoveryClaim.modifiedCount !== 1) {
            // Another process recovered/claimed it first (or state changed under us).
            const latest = await TransactionStatus.findOne({ refId });
            console.log(`[Funding Safety] Reference ${refId}: webhook recovery claim not acquired (status now '${latest && latest.status}'). No second credit.`);
            return {
                success: latest && latest.status === 'success',
                status: (latest && latest.status) || 'processing',
                alreadyProcessed: true,
                credited: false,
                message: 'Transaction recovery already claimed by a concurrent process'
            };
        }

        console.log(`[FUNDING-RECOVERY] Reference ${refId}: failed → processing recovery claim acquired via authenticated webhook.`);
        return this._finalizeAfterClaim({
            transactionStatus,
            gatewayPaymentResult,
            refId,
            confirmedKobo,
            confirmedCurrency,
            source,
            recovery: true
        });
    }

    /**
     * Strict eligibility for webhook failed→success recovery. ALL must hold:
     *   1. source === 'webhook'            (authenticated provider event already persisted by routeWebhook)
     *   2. transactionStatus.type === 'funding'
     *   3. gateway verify explicitly reports status === 'success' (independent server-to-server confirmation)
     *   4. provider binding matches the confirmed gateway
     *   5. provider reference matches refId
     *   6. confirmed currency is NGN
     *   7. confirmed amount (Kobo) matches the expected amount
     *   8. NO pre-existing funding credit ledger row for this reference
     *
     * Returns a boolean; NEVER throws (an eligibility error must leave the record
     * exactly as-is in 'failed').
     */
    async _isWebhookRecoveryEligible({ transactionStatus, gatewayPaymentResult, refId, source }) {
        try {
            if (source !== 'webhook') return false;
            if (!transactionStatus || transactionStatus.type !== 'funding') return false;
            if (!gatewayPaymentResult || gatewayPaymentResult.status !== 'success') return false;

            // Provider binding match — never recover across gateways.
            if (transactionStatus.provider && gatewayPaymentResult.gateway) {
                if (transactionStatus.provider.toLowerCase() !== String(gatewayPaymentResult.gateway).toLowerCase()) return false;
            }

            // Provider reference must match the local reference exactly.
            if (gatewayPaymentResult.reference && gatewayPaymentResult.reference !== refId) return false;

            // Currency must be NGN.
            if ((gatewayPaymentResult.currency || 'NGN').toUpperCase() !== 'NGN') return false;

            // Amount must match exactly (Kobo), and be a sane positive value.
            const expectedKobo = transactionStatus.amountKobo
                || Math.round(Number(transactionStatus.amount || 0) * 100);
            const confirmedKobo = Math.round(Number(gatewayPaymentResult.amount || 0) * 100);
            if (confirmedKobo <= 0) return false;
            if (expectedKobo > 0 && confirmedKobo !== expectedKobo) return false;

            // Must NOT have been previously credited. The WalletLedger reference
            // index is non-unique, so the state machine is the real guard — but
            // this explicit check blocks double-credit even on past/admin runs.
            const existingCredit = await WalletLedger.findOne({ reference: refId, entryType: 'credit' });
            if (existingCredit) return false;

            return true;
        } catch (eligibilityErr) {
            console.error(`[FUNDING-RECOVERY-WARN] Reference=${refId}: eligibility check error. Recovery skipped, record left 'failed'.`, eligibilityErr.message);
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────
    // ADMIN RECONCILIATION SETTLEMENT (write-path for stuck payments)
    // ─────────────────────────────────────────────────────────

    /**
     * Admin settlement of a TransactionStatus stuck in 'processing' — the crash
     * window left by finalizeFundingCredit (lock claimed, credit/finalize crashed),
     * or a stranded 'settlement_pending' claim needing completion.
     *
     * Recovery semantics:
     *   - Only crash-window records are settled: 'processing' (claim acquired,
     *     credit/finalize crashed) and 'settlement_pending' (claim acquired,
     *     finalize crashed). Terminal 'failed' and 'reconciliation_required'
     *     records keep their evidence-preserving semantics and are reviewed
     *     independently.
     *   - Exactly-once: the claim, the wallet credit / share fulfillment, and the
     *     settlement_pending → success transition are executed inside ONE MongoDB
     *     session and commit atomically. The finalize transition guards on the
     *     claimed state (modifiedCount === 1) BEFORE commit, so a concurrent
     *     settlement that already reached success makes the guard a no-op and
     *     this run aborts with its credit rolled back — a double-credit is
     *     impossible even when two settlers both start from 'processing'.
     *   - Idempotent across crashes: if the credit ALREADY committed (crash
     *     between an earlier credit commit and the finalize), the existing-ledger
     *     check skips the credit and only the status transition is made.
     *
     * @param {string} refId - TransactionStatus refId to settle
     * @param {string} [adminId] - performing admin id (for audit/notes)
     * @param {string} [note] - optional admin note recorded in reconciliationReason
     */
    async adminSettleProcessing({ refId, adminId = null, note = '' }) {
        if (!refId) {
            throw new Error('Reference is required for settlement');
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const transactionStatus = await TransactionStatus.findOne({ refId }).session(session);
            if (!transactionStatus) {
                await session.abortTransaction();
                throw new Error(`TransactionStatus record '${refId}' not found`);
            }

            if (transactionStatus.status !== 'processing' && transactionStatus.status !== 'settlement_pending') {
                await session.abortTransaction();
                throw new Error(
                    `Cannot settle reference '${refId}': status is '${transactionStatus.status}', expected 'processing'. Only crash-window (processing) records are eligible.`
                );
            }

            const confirmedKobo = transactionStatus.confirmedAmountKobo || transactionStatus.amountKobo;
            if (!confirmedKobo || confirmedKobo <= 0) {
                await session.abortTransaction();
                throw new Error(`Reference '${refId}' has no confirmed amount to settle against`);
            }

            const userId = transactionStatus.userId;
            const amountNaira = confirmedKobo / 100;
            let credited = false;

            // ATOMIC CLAIM + CREDIT + FINALIZE in ONE session. Crashes anywhere
            // roll the whole batch back to 'processing' (admin alarm, not silent
            // failure); success commits the claim→success transition and the
            // credit together, so no intermediate 'settlement_pending' is ever
            // left durable by this path.
            const claimNote = [
                note ? `${note}` : '',
                `Admin settlement claim by ${adminId || 'superAdmin'}`,
                `at ${new Date().toISOString()}`
            ].filter(Boolean).join('; ');

            await TransactionStatus.updateOne(
                { refId, status: 'processing' },
                {
                    $set: {
                        status: 'settlement_pending',
                        reconciliationReason: (transactionStatus.reconciliationReason
                            ? `${transactionStatus.reconciliationReason} | `
                            : '') + claimNote
                    }
                },
                { session }
            );

            if (userId) {
                if (transactionStatus.type === 'investment_buy') {
                    // Bind to the init-time price snapshot (see _finalizeAfterClaim);
                    // fall back to a fresh read only for pre-snapshot records.
                    let sharePrice;
                    if (Number(transactionStatus.sharePrice) > 0) {
                        sharePrice = Number(transactionStatus.sharePrice);
                    } else {
                        const settings = await investmentService.getInvestmentSettings();
                        sharePrice = Number(settings && settings.sharePrice);
                    }
                    if (!(sharePrice > 0)) {
                        await session.abortTransaction();
                        throw new Error('Invalid share price for settlement');
                    }

                    const perShareKobo = sharePrice * 100;
                    if (!Number.isInteger(perShareKobo) || perShareKobo <= 0) {
                        await session.abortTransaction();
                        throw new Error('Share price does not reconcile to whole kobo');
                    }
                    if (confirmedKobo % perShareKobo !== 0) {
                        await session.abortTransaction();
                        throw new Error(
                            `Cannot settle '${refId}': confirmed amount ₦${amountNaira} is not a whole multiple of the share price ₦${sharePrice}. Requires manual review of the payer.`
                        );
                    }

                    const qty = confirmedKobo / perShareKobo;
                    const fulfillment = await investmentService.fulfillSharePurchase(userId, qty, refId, false, session, sharePrice);
                    credited = !(fulfillment && fulfillment.message === 'Already processed');
                } else {
                    // Funding / payout credit — skip if an earlier crashed run already
                    // committed the credit (crash between credit commit and finalize).
                    const existingCredit = await WalletLedger.findOne({
                        reference: refId,
                        entryType: 'credit'
                    }).session(session);

                    if (!existingCredit) {
                        await walletService.credit(userId, amountNaira, refId, 'funding', null, session);
                        credited = true;
                    }
                }
            }

            const finalizeNote = [
                note ? `${note}` : '',
                `Admin settlement by ${adminId || 'superAdmin'}`,
                `at ${new Date().toISOString()}`
            ].filter(Boolean).join('; ');

            const finalize = await TransactionStatus.updateOne(
                { refId, status: 'settlement_pending' },
                {
                    $set: {
                        status: 'success',
                        reconciliationReason: (transactionStatus.reconciliationReason
                            ? `${transactionStatus.reconciliationReason} | `
                            : '') + finalizeNote
                    }
                },
                { session }
            );

            if (finalize.modifiedCount !== 1) {
                // A concurrent settlement claimed the transition first — its credit
                // (if any) was committed, ours aborts. Never double-credit.
                await session.abortTransaction();
                const latest = await TransactionStatus.findOne({ refId });
                return {
                    success: true,
                    status: (latest && latest.status) || 'success',
                    alreadyProcessed: true,
                    settled: false,
                    credited: false,
                    message: 'Settlement already claimed by a concurrent process'
                };
            }

            await session.commitTransaction();

            console.log(`[FUNDING-ADMIN-SETTLE] Reference ${refId}: processing → success. Credited this run: ${credited}. Amount ₦${amountNaira}.`);

            if (userId) {
                notificationService.sendFundingSuccess({
                    userId,
                    amount: amountNaira,
                    method: (transactionStatus.channels && transactionStatus.channels[0]) || transactionStatus.channel || 'funding',
                    reference: refId,
                    type: transactionStatus.type || 'funding'
                }).catch(notifErr => {
                    console.error('[Funding Notification Background Error]', notifErr && notifErr.message);
                });
            }

            return {
                success: true,
                settled: true,
                status: 'success',
                credited,
                amount: amountNaira,
                type: transactionStatus.type || 'funding',
                reference: refId
            };
        } catch (err) {
            await session.abortTransaction();
            throw err;
        } finally {
            session.endSession();
        }
    }

    /**
     * Automated crash-recovery sweep for the funding settlement state machine.
     *
     * Searches for records stranded in an intermediate settlement state and
     * finishes them exactly-once:
     *   - 'settlement_pending'  → a settlement that crashed mid-flight (claim
     *     acquired, credit/finalize interrupted),
     *   - 'processing' older than maxAgeMs → the finalizeFundingCredit crash
     *     window (claim acquired, credit/finalize crashed).
     *
     * Recovery is idempotent: adminSettleProcessing skips an already-committed
     * credit and only completes the status transition. Records that genuinely
     * cannot settle (e.g. a non-whole-share amount) are logged and skipped so
     * one bad record cannot block the recovery of the rest.
     *
     * @param {object} [opts]
     * @param {number} [opts.maxAgeMs] - consider 'processing' records older than this as crashed
     * @param {number} [opts.dryRun] - when truthy, only log candidates, change nothing
     */
    async recoverStrandedSettlements({ maxAgeMs = 15 * 60 * 1000, dryRun = false } = {}) {
        const cutoff = new Date(Date.now() - maxAgeMs);

        const strandedSettlementPending = await TransactionStatus.find({
            status: 'settlement_pending'
        });

        const strandedProcessing = await TransactionStatus.find({
            status: 'processing',
            lastAttempt: { $lt: cutoff }
        });

        const candidates = [
            ...strandedSettlementPending.map(t => ({ refId: t.refId, state: 'settlement_pending' })),
            ...strandedProcessing.map(t => ({ refId: t.refId, state: 'processing' }))
        ];

        if (candidates.length === 0) return { scanned: 0, settled: 0, skipped: 0 };

        let settled = 0;
        let skipped = 0;

        for (const candidate of candidates) {
            try {
                if (dryRun) {
                    console.log(`[SETTLEMENT-RECOVERY-DRY] Would settle ${candidate.refId} (state=${candidate.state})`);
                    skipped++;
                    continue;
                }
                const result = await this.adminSettleProcessing({ refId: candidate.refId });
                if (result && result.settled) settled++;
                else skipped++;
            } catch (recoverErr) {
                // Technical or validation failure — record stays in its evidence-
                // preserving intermediate state for manual admin review.
                skipped++;
                console.error(`[SETTLEMENT-RECOVERY-SKIP] Reference=${candidate.refId}: ${recoverErr.message}`);
            }
        }

        console.log(`[SETTLEMENT-RECOVERY] Scanned ${candidates.length} stranded records. Settled: ${settled}, skipped: ${skipped}.`);
        return { scanned: candidates.length, settled, skipped };
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
     * Atomically creates or claims an authenticated webhook event.
     *
     * pending means one request owns a short processing lease. A duplicate may
     * only reprocess a retryable event or a stale lease. processed and failed are
     * terminal states and are safely deduplicated.
     */
    async _claimWebhookEvent({ providerCode, normalized, payload }) {
        const identity = { provider: providerCode, eventId: normalized.eventId };
        const now = new Date();
        const processingExpiresAt = new Date(now.getTime() + WEBHOOK_PROCESSING_LEASE_MS);

        try {
            const webhookEvent = await WebhookEvent.create({
                ...identity,
                eventType: normalized.eventType,
                payload,
                status: 'pending',
                attemptCount: 1,
                lastAttemptAt: now,
                processingExpiresAt
            });
            return { webhookEvent, identity };
        } catch (dbErr) {
            if (dbErr.code !== 11000) throw dbErr;

            const webhookEvent = await WebhookEvent.findOneAndUpdate(
                {
                    ...identity,
                    $or: [
                        { status: 'retryable' },
                        { status: 'pending', processingExpiresAt: { $lte: now } },
                        { status: 'pending', processingExpiresAt: { $exists: false } }
                    ]
                },
                {
                    $set: {
                        status: 'pending',
                        eventType: normalized.eventType,
                        payload,
                        errorMessage: null,
                        lastAttemptAt: now,
                        processingExpiresAt
                    },
                    $inc: { attemptCount: 1 }
                },
                { new: true }
            );

            if (webhookEvent) {
                console.log(`[Webhook Retry] eventId=${normalized.eventId} for ${providerCode} claimed for reprocessing.`);
                return { webhookEvent, identity, retried: true };
            }

            const existing = await WebhookEvent.findOne(identity);
            if (existing && ['processed', 'failed'].includes(existing.status)) {
                console.log(`[Webhook Idempotency] eventId=${normalized.eventId} for ${providerCode} is terminal (${existing.status}). Duplicate ignored.`);
                return {
                    response: { status: 200, message: 'Event already processed' },
                    identity
                };
            }

            // 503 follows the application's existing temporary-unavailability
            // convention and asks the provider to redeliver after the active lease.
            return {
                response: { status: 503, message: 'Webhook event is currently processing; retry later' },
                identity
            };
        }
    }

    async _setWebhookEventState(webhookEvent, status, errorMessage = null) {
        webhookEvent.status = status;
        webhookEvent.errorMessage = errorMessage;
        webhookEvent.processingExpiresAt = null;
        await webhookEvent.save();
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
        const claim = await this._claimWebhookEvent({ providerCode, normalized, payload });
        if (claim.response) return claim.response;
        const webhookEvent = claim.webhookEvent;

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
                let serverVerify;
                try {
                    serverVerify = await adapter.verifyPayment(refId);
                } catch (verifyErr) {
                    // A transport/adapter exception cannot authoritatively establish
                    // payment failure. Keep the transaction recoverable.
                    serverVerify = {
                        success: false,
                        status: 'pending',
                        reference: refId,
                        message: `Provider verification unavailable: ${verifyErr.message}`
                    };
                }

                if (serverVerify.status === 'success') {
                    try {
                        await this.finalizeFundingCredit({
                            transactionStatus: transaction,
                            gatewayPaymentResult: {
                                ...serverVerify,
                                gateway: providerCode
                            },
                            source: 'webhook'
                        });
                    } catch (settlementErr) {
                        const terminalSecurityFailure = [
                            'PAYMENT_GATEWAY_MISMATCH',
                            'PAYMENT_REFERENCE_MISMATCH',
                            'PAYMENT_CURRENCY_MISMATCH',
                            'PAYMENT_AMOUNT_MISMATCH'
                        ].includes(settlementErr.code);
                        await this._setWebhookEventState(
                            webhookEvent,
                            terminalSecurityFailure ? 'failed' : 'retryable',
                            settlementErr.message
                        );
                        throw settlementErr;
                    }
                } else if (serverVerify.status === 'failed') {
                    // The provider authoritatively confirmed a terminal failure.
                    // Preserve existing TransactionStatus handling and stop retries.
                    await this._setWebhookEventState(
                        webhookEvent,
                        'failed',
                        `Secondary verification confirmed failure: ${serverVerify.message}`
                    );
                    return { status: 200, message: 'Secondary verification confirmed payment failure' };
                } else {
                    await this._setWebhookEventState(
                        webhookEvent,
                        'retryable',
                        `Secondary verification inconclusive: ${serverVerify.message}`
                    );
                    console.warn(`[Webhook] Secondary verification inconclusive for ${refId} via ${providerCode}: ${serverVerify.message}`);
                    return { status: 503, message: 'Secondary verification inconclusive; retry later' };
                }
            } else {
                console.warn(`[Webhook] No TransactionStatus found for refId=${refId} from ${providerCode}`);
            }
        }

        await this._setWebhookEventState(webhookEvent, 'processed');

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
