'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const PaymentGateway = require('../models/PaymentGateway');
const TransactionStatus = require('../models/TransactionStatus');
const Transaction = require('../models/Transaction');
const WebhookEvent = require('../models/WebhookEvent');
const WalletLedger = require('../models/WalletLedger');
const walletService = require('./wallet.service');
const notificationService = require('./notification.service');
const investmentService = require('./investment.service');
const { parseInvestmentMoney } = require('../utils/investmentValidation');
const { generateReference } = require('../utils/generateID');
const { decryptSecret, isEncrypted } = require('../utils/crypto');

const PaystackAdapter = require('../adapters/payment/paystack.adapter');
const MonnifyAdapter = require('../adapters/payment/monnify.adapter');
const FlutterwaveAdapter = require('../adapters/payment/flutterwave.adapter');
const { SUPPORTED_ADAPTER_CODES } = require('../adapters/payment/paymentAdapterRegistry');

const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60 * 1000;
const SETTLEMENT_LEASE_MS = 15 * 60 * 1000;
const AUTOMATIC_SETTLEMENT_TYPES = new Set(['funding', 'investment_buy']);

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
        let parsedAmount;
        try {
            parsedAmount = parseInvestmentMoney(amount, { label: 'Funding amount' });
        } catch (error) {
            throw new Error('Funding amount must be a positive value with at most two decimal places');
        }
        const rawAmount = parsedAmount.naira;
        if (rawAmount < 50) {
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

        const amountKobo = parsedAmount.kobo;
        const channels = channel ? [channel] : (gateway.supportedChannels && gateway.supportedChannels.length ? gateway.supportedChannels : ['card', 'bank_transfer', 'ussd']);

        // Authoritative share price snapshot for investment-buy payments: read the
        // CURRENT server-side price at INIT time. Fulfillment must bind to this
        // snapshot used by the authoritative settlement transaction, eliminating
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
            if (!invSettings.investmentEnabled) {
                const err = new Error('Share purchase is temporarily unavailable. Please try again later.');
                err.code = 'INVALID_INVESTMENT_CONFIGURATION';
                throw err;
            }
            let sharePrice;
            try {
                sharePrice = parseInvestmentMoney(invSettings.sharePrice, { label: 'Share price' });
            } catch (error) {
                const configurationError = new Error('Share purchase is temporarily unavailable. Please try again later.');
                configurationError.code = 'INVALID_INVESTMENT_CONFIGURATION';
                throw configurationError;
            }
            if (amountKobo % sharePrice.kobo !== 0) {
                const err = new Error('Investment amount must purchase a whole number of shares.');
                err.code = 'INVALID_INVESTMENT_AMOUNT';
                throw err;
            }
            const qty = amountKobo / sharePrice.kobo;
            if (qty < invSettings.minSharesPerPurchase || qty > invSettings.maxSharesPerUser || qty > invSettings.totalSharesAvailable) {
                const err = new Error('Investment amount is outside the permitted share limits.');
                err.code = 'INVALID_INVESTMENT_AMOUNT';
                throw err;
            }
            let sharesOwned;
            try {
                sharesOwned = await investmentService.getAuthoritativeShareBalance(user._id || user.id);
            } catch (error) {
                const err = new Error('Investment account share balance requires manual reconciliation.');
                err.code = 'INVALID_INVESTMENT_CONFIGURATION';
                throw err;
            }
            if (sharesOwned + qty > invSettings.maxSharesPerUser) {
                const err = new Error('Investment amount exceeds the permitted per-user share limit.');
                err.code = 'INVALID_INVESTMENT_AMOUNT';
                throw err;
            }
            sharePriceSnapshot = sharePrice.naira;
        }

        // 4. Persist Pending TransactionStatus Record — gateway permanently bound here
        await TransactionStatus.create({
            refId: reference,
            userId: user._id || user.id,
            type: txType,
            status: 'pending',
            amountKobo,
            amount: rawAmount,
            expectedCurrency: 'NGN',
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

    _newSettlementClaim() {
        const now = new Date();
        return {
            token: crypto.randomBytes(32).toString('hex'),
            claimedAt: now,
            expiresAt: new Date(now.getTime() + SETTLEMENT_LEASE_MS)
        };
    }

    _requirePositiveSafeKobo(value, label) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            const error = new Error(`${label} must be a positive safe-integer kobo amount`);
            error.code = 'PAYMENT_EVIDENCE_INVALID';
            throw error;
        }
        return value;
    }

    _nairaToKobo(value, label) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            const error = new Error(`${label} must be a positive finite number`);
            error.code = 'PAYMENT_EVIDENCE_INVALID';
            throw error;
        }
        const rawKobo = value * 100;
        const kobo = Math.round(rawKobo);
        if (!Number.isSafeInteger(kobo) || Math.abs(rawKobo - kobo) > 1e-7) {
            const error = new Error(`${label} must reconcile exactly to safe integer kobo`);
            error.code = 'PAYMENT_EVIDENCE_INVALID';
            throw error;
        }
        return kobo;
    }

    _validatedGatewayEvidence(transactionStatus, gatewayPaymentResult) {
        const refId = transactionStatus && transactionStatus.refId;
        if (!transactionStatus || !refId) throw new Error('[Funding Safety] Local transaction reference is required');
        if (!transactionStatus.userId) throw new Error(`[Funding Safety] Reference '${refId}' has no authoritative local owner`);
        if (!AUTOMATIC_SETTLEMENT_TYPES.has(transactionStatus.type)) {
            throw new Error(`[Funding Safety] Unsupported automatic settlement type '${transactionStatus.type}'`);
        }

        const localProvider = String(transactionStatus.provider || '').trim().toLowerCase();
        const confirmedProvider = String(gatewayPaymentResult && gatewayPaymentResult.gateway || '').trim().toLowerCase();
        if (!localProvider || !confirmedProvider || localProvider !== confirmedProvider) {
            const error = new Error(`Provider mismatch: expected '${localProvider || 'missing'}', confirmed '${confirmedProvider || 'missing'}'`);
            error.code = 'PAYMENT_GATEWAY_MISMATCH';
            throw error;
        }

        const confirmedReference = String(gatewayPaymentResult.reference || '').trim();
        if (!confirmedReference || confirmedReference !== refId) {
            const error = new Error(`Reference mismatch: expected '${refId}', confirmed '${confirmedReference || 'missing'}'`);
            error.code = 'PAYMENT_REFERENCE_MISMATCH';
            throw error;
        }

        const expectedKobo = this._requirePositiveSafeKobo(transactionStatus.amountKobo, 'Expected amount');
        const confirmedKobo = this._nairaToKobo(gatewayPaymentResult.amount, 'Confirmed amount');
        if (expectedKobo !== confirmedKobo) {
            const error = new Error(`Amount mismatch: expected ${expectedKobo} kobo, confirmed ${confirmedKobo} kobo`);
            error.code = 'PAYMENT_AMOUNT_MISMATCH';
            throw error;
        }

        const expectedCurrency = String(transactionStatus.expectedCurrency || '').trim().toUpperCase();
        const confirmedCurrency = String(gatewayPaymentResult.currency || '').trim().toUpperCase();
        if (!expectedCurrency || !confirmedCurrency || expectedCurrency !== confirmedCurrency) {
            const error = new Error(`Currency mismatch: expected '${expectedCurrency || 'missing'}', confirmed '${confirmedCurrency || 'missing'}'`);
            error.code = 'PAYMENT_CURRENCY_MISMATCH';
            throw error;
        }

        const confirmedProviderRef = String(gatewayPaymentResult.providerTransactionId || '').trim();
        if (!confirmedProviderRef) {
            const error = new Error('Confirmed provider transaction identifier is required');
            error.code = 'PAYMENT_EVIDENCE_INVALID';
            throw error;
        }

        return {
            confirmedAmountKobo: confirmedKobo,
            confirmedCurrency,
            confirmedProvider,
            confirmedReference,
            confirmedProviderRef
        };
    }

    _assertPersistedSettlementEvidence(transactionStatus) {
        const invalid = message => {
            const error = new Error(message);
            error.code = 'SETTLEMENT_EVIDENCE_INVALID';
            return error;
        };
        if (!transactionStatus || !transactionStatus.refId) throw invalid('Persisted settlement reference is required');
        if (!transactionStatus.userId) throw invalid(`Reference '${transactionStatus.refId}' has no authoritative local owner`);
        if (!AUTOMATIC_SETTLEMENT_TYPES.has(transactionStatus.type)) {
            throw invalid(`Unsupported automatic settlement type '${transactionStatus.type}'`);
        }

        let expectedKobo;
        let confirmedKobo;
        try {
            expectedKobo = this._requirePositiveSafeKobo(transactionStatus.amountKobo, 'Expected amount');
            confirmedKobo = this._requirePositiveSafeKobo(transactionStatus.confirmedAmountKobo, 'Confirmed amount');
        } catch (error) {
            throw invalid(error.message);
        }
        if (expectedKobo !== confirmedKobo) throw invalid('Persisted settlement amount mismatch');

        const provider = String(transactionStatus.provider || '').trim().toLowerCase();
        const confirmedProvider = String(transactionStatus.confirmedProvider || '').trim().toLowerCase();
        if (!provider || !confirmedProvider || provider !== confirmedProvider) throw invalid('Persisted settlement provider mismatch');

        const confirmedReference = String(transactionStatus.confirmedReference || '').trim();
        if (!confirmedReference || confirmedReference !== transactionStatus.refId) throw invalid('Persisted settlement reference mismatch');

        const expectedCurrency = String(transactionStatus.expectedCurrency || '').trim().toUpperCase();
        const confirmedCurrency = String(transactionStatus.confirmedCurrency || '').trim().toUpperCase();
        if (!expectedCurrency || !confirmedCurrency || expectedCurrency !== confirmedCurrency) throw invalid('Persisted settlement currency mismatch');
        const confirmedProviderRef = String(transactionStatus.confirmedProviderRef || '').trim();
        if (!confirmedProviderRef) throw invalid('Persisted provider transaction identifier is required');

        return { expectedKobo, confirmedKobo, provider, expectedCurrency, confirmedProviderRef };
    }

    _providerTransactionReuseError(provider, providerTransactionId, ownerRefId, attemptedRefId) {
        const error = new Error(
            `Provider transaction '${provider}:${providerTransactionId}' already belongs to local reference '${ownerRefId}' and cannot settle '${attemptedRefId}'`
        );
        error.code = 'PAYMENT_PROVIDER_TRANSACTION_REUSED';
        return error;
    }

    async _assertProviderTransactionOwner({ provider, providerTransactionId, refId, session = null }) {
        const query = TransactionStatus.findOne({
            confirmedProvider: provider,
            confirmedProviderRef: providerTransactionId
        });
        const owner = session ? await query.session(session) : await query;
        if (owner && String(owner.refId) !== String(refId)) {
            throw this._providerTransactionReuseError(provider, providerTransactionId, owner.refId, refId);
        }
    }

    async _markReconciliationRequired(transactionStatus, error) {
        if (!transactionStatus || transactionStatus.status === 'failed') return;
        const result = error.gatewayPaymentResult || {};
        const confirmedAmount = typeof result.amount === 'number' && Number.isFinite(result.amount) && result.amount > 0
            ? Math.round(result.amount * 100)
            : null;
        await TransactionStatus.updateOne(
            { refId: transactionStatus.refId, status: transactionStatus.status },
            {
                $set: {
                    status: 'reconciliation_required',
                    reconciliationReason: error.message,
                    ...(Number.isSafeInteger(confirmedAmount) ? { confirmedAmountKobo: confirmedAmount } : {}),
                    ...(result.currency ? { confirmedCurrency: String(result.currency).toUpperCase() } : {}),
                    ...(result.reference ? { confirmedReference: String(result.reference) } : {})
                }
            }
        );
    }

    async finalizeFundingCredit({ transactionStatus, gatewayPaymentResult, source = 'webhook' }) {
        if (!transactionStatus) throw new Error('[Funding Safety] TransactionStatus record is required');
        const refId = transactionStatus.refId;

        if (transactionStatus.status === 'success') {
            return { success: true, status: 'success', alreadyProcessed: true, credited: false };
        }
        if (['processing', 'settlement_pending', 'reconciliation_required'].includes(transactionStatus.status)) {
            return { success: false, status: transactionStatus.status, alreadyProcessed: true, credited: false };
        }

        if (!gatewayPaymentResult || gatewayPaymentResult.status !== 'success') {
            if (gatewayPaymentResult && gatewayPaymentResult.status === 'failed') {
                const failed = await TransactionStatus.updateOne(
                    { refId, status: 'pending' },
                    { $set: { status: 'failed', errorMessage: gatewayPaymentResult.message || 'Payment failed at gateway' } }
                );
                if (failed.modifiedCount === 1 && transactionStatus.userId) {
                    notificationService.sendFundingAdvisory(transactionStatus.userId, {
                        kind: 'failed', amount: (transactionStatus.amountKobo || 0) / 100, reference: refId
                    }).catch(error => console.error('[Funding Advisory Error]', error.message));
                }
            }
            return {
                success: false,
                status: gatewayPaymentResult && gatewayPaymentResult.status || 'pending',
                message: gatewayPaymentResult && gatewayPaymentResult.message || 'Payment provider did not confirm success'
            };
        }

        let evidence;
        try {
            evidence = this._validatedGatewayEvidence(transactionStatus, gatewayPaymentResult);
            await this._assertProviderTransactionOwner({
                provider: evidence.confirmedProvider,
                providerTransactionId: evidence.confirmedProviderRef,
                refId
            });
        } catch (error) {
            error.gatewayPaymentResult = gatewayPaymentResult;
            await this._markReconciliationRequired(transactionStatus, error);
            if (transactionStatus.status === 'failed') {
                return { success: false, status: 'failed', alreadyProcessed: true, credited: false };
            }
            throw error;
        }

        if (transactionStatus.status === 'failed') {
            if (source !== 'webhook' || transactionStatus.type !== 'funding') {
                return { success: false, status: 'failed', alreadyProcessed: true, credited: false };
            }
            const priorCredit = await WalletLedger.findOne({
                reference: refId,
                userId: transactionStatus.userId,
                entryType: 'credit',
                source: { $in: ['funding', 'funding_retry'] }
            });
            if (priorCredit) {
                return { success: false, status: 'failed', alreadyProcessed: true, credited: false };
            }
        } else if (transactionStatus.status !== 'pending') {
            return { success: false, status: transactionStatus.status, alreadyProcessed: true, credited: false };
        }

        const claim = this._newSettlementClaim();
        let claimResult;
        try {
            claimResult = await TransactionStatus.updateOne(
                { refId, status: transactionStatus.status },
                {
                    $set: {
                        status: 'processing',
                        ...evidence,
                        settlementClaimToken: claim.token,
                        settlementLeaseExpiresAt: claim.expiresAt,
                        lastAttempt: claim.claimedAt,
                        ...(transactionStatus.status === 'failed'
                            ? { reconciliationReason: `Authenticated webhook recovery at ${claim.claimedAt.toISOString()}` }
                            : {})
                    }
                }
            );
        } catch (error) {
            if (error && error.code === 11000) {
                try {
                    await this._assertProviderTransactionOwner({
                        provider: evidence.confirmedProvider,
                        providerTransactionId: evidence.confirmedProviderRef,
                        refId
                    });
                } catch (reuseError) {
                    reuseError.gatewayPaymentResult = gatewayPaymentResult;
                    await this._markReconciliationRequired(transactionStatus, reuseError);
                    throw reuseError;
                }
            }
            throw error;
        }

        if (claimResult.modifiedCount !== 1) {
            const latest = await TransactionStatus.findOne({ refId });
            return {
                success: latest && latest.status === 'success',
                status: latest && latest.status || 'processing',
                alreadyProcessed: true,
                credited: false
            };
        }

        return this._settleOwnedClaim({ refId, claimToken: claim.token, source, gatewayPaymentResult });
    }

    async _settleOwnedClaim({ refId, claimToken, source = 'recovery', gatewayPaymentResult = null, actorNote = '' }) {
        if (!refId || !claimToken) throw new Error('Settlement reference and claim token are required');
        const session = await mongoose.startSession();
        session.startTransaction();
        let transactionStatus;
        let amountNaira;
        let credited = false;

        try {
            transactionStatus = await TransactionStatus.findOne({ refId }).session(session);
            if (!transactionStatus) throw new Error(`TransactionStatus record '${refId}' not found`);
            if (!['processing', 'settlement_pending'].includes(transactionStatus.status)) {
                throw new Error(`Cannot settle reference '${refId}': status is '${transactionStatus.status}'`);
            }
            if (transactionStatus.settlementClaimToken !== claimToken) {
                const error = new Error(`Settlement claim ownership lost for '${refId}'`);
                error.code = 'SETTLEMENT_CLAIM_LOST';
                throw error;
            }
            const leaseExpiry = new Date(transactionStatus.settlementLeaseExpiresAt || 0);
            if (!leaseExpiry.getTime() || leaseExpiry <= new Date()) {
                const error = new Error(`Settlement lease expired for '${refId}'`);
                error.code = 'SETTLEMENT_LEASE_EXPIRED';
                throw error;
            }

            const evidence = this._assertPersistedSettlementEvidence(transactionStatus);
            await this._assertProviderTransactionOwner({
                provider: evidence.provider,
                providerTransactionId: evidence.confirmedProviderRef,
                refId,
                session
            });
            amountNaira = evidence.confirmedKobo / 100;

            const settleClaim = await TransactionStatus.updateOne(
                { refId, status: { $in: ['processing', 'settlement_pending'] }, settlementClaimToken: claimToken },
                { $set: { status: 'settlement_pending', ...(actorNote ? { reconciliationReason: actorNote } : {}) } },
                { session }
            );
            if (settleClaim.matchedCount !== 1) throw new Error(`Settlement claim ownership lost for '${refId}'`);

            if (transactionStatus.type === 'investment_buy') {
                const sharePrice = Number(transactionStatus.sharePrice);
                let sharePriceKobo;
                try {
                    sharePriceKobo = this._nairaToKobo(sharePrice, 'Share price');
                } catch (error) {
                    error.code = 'SETTLEMENT_EVIDENCE_INVALID';
                    throw error;
                }
                if (evidence.confirmedKobo % sharePriceKobo !== 0) {
                    const error = new Error(`Confirmed amount for '${refId}' is not a whole multiple of the snapshotted share price`);
                    error.code = 'SETTLEMENT_EVIDENCE_INVALID';
                    throw error;
                }
                const qty = evidence.confirmedKobo / sharePriceKobo;
                let fulfillment;
                try {
                    fulfillment = await investmentService.fulfillSharePurchase(
                        transactionStatus.userId, qty, refId, false, session, sharePrice
                    );
                } catch (error) {
                    if (error.code === 'SETTLEMENT_EVIDENCE_INVALID' ||
                        /share limit|share supply|investment feature is currently disabled|audit does not reconcile/i.test(error.message || '')) {
                        error.code = 'SETTLEMENT_EVIDENCE_INVALID';
                    }
                    throw error;
                }
                credited = !(fulfillment && fulfillment.message === 'Already processed');
            } else {
                const settlementKey = `payment:${evidence.provider}:${refId}`;
                const historicalCredit = await WalletLedger.findOne({
                    reference: refId,
                    userId: transactionStatus.userId,
                    entryType: 'credit',
                    source: { $in: ['funding', 'funding_retry'] }
                }).session(session);
                if (historicalCredit) {
                    if (historicalCredit.amount !== amountNaira) {
                        const error = new Error('Historical funding credit amount does not reconcile');
                        error.code = 'SETTLEMENT_EVIDENCE_INVALID';
                        throw error;
                    }
                } else {
                    await walletService.credit(
                        transactionStatus.userId,
                        amountNaira,
                        refId,
                        'funding',
                        null,
                        session,
                        { settlementKey }
                    );
                    credited = true;
                }

                const existingAudit = await Transaction.findOne({ transactionId: refId }).session(session);
                if (!existingAudit) {
                    await Transaction.create([{
                        userId: transactionStatus.userId,
                        transactionId: refId,
                        refId,
                        type: 'funding',
                        service: transactionStatus.service || evidence.provider,
                        amount: amountNaira,
                        status: 'success',
                        response: gatewayPaymentResult && gatewayPaymentResult.raw || {}
                    }], { session });
                }
            }

            const finalized = await TransactionStatus.updateOne(
                { refId, status: 'settlement_pending', settlementClaimToken: claimToken },
                {
                    $set: { status: 'success', lastAttempt: new Date() },
                    $unset: { settlementClaimToken: 1, settlementLeaseExpiresAt: 1 }
                },
                { session }
            );
            if (finalized.modifiedCount !== 1) {
                const error = new Error(`Settlement claim ownership lost before finalization for '${refId}'`);
                error.code = 'SETTLEMENT_CLAIM_LOST';
                throw error;
            }

            await session.commitTransaction();
        } catch (error) {
            await session.abortTransaction();
            if (error.code === 'SETTLEMENT_EVIDENCE_INVALID' || error.code === 'PAYMENT_PROVIDER_TRANSACTION_REUSED') {
                await TransactionStatus.updateOne(
                    { refId, settlementClaimToken: claimToken, status: { $in: ['processing', 'settlement_pending'] } },
                    {
                        $set: { status: 'reconciliation_required', reconciliationReason: error.message },
                        $unset: { settlementClaimToken: 1, settlementLeaseExpiresAt: 1 }
                    }
                );
            }
            throw error;
        } finally {
            session.endSession();
        }

        notificationService.sendFundingSuccess({
            userId: transactionStatus.userId,
            amount: amountNaira,
            method: transactionStatus.channels && transactionStatus.channels[0] || 'funding',
            reference: refId,
            type: transactionStatus.type
        }).catch(error => console.error('[Funding Notification Background Error]', error.message));

        return {
            success: true,
            settled: true,
            status: 'success',
            credited,
            amount: amountNaira,
            type: transactionStatus.type,
            reference: refId,
            source
        };
    }

    async adminSettleProcessing({ refId, adminId = null, note = '', claimToken = null, automatedRecovery = false }) {
        if (!refId) throw new Error('Reference is required for settlement');
        if (claimToken) {
            return this._settleOwnedClaim({ refId, claimToken, source: automatedRecovery ? 'automatic_recovery' : 'admin_reconciliation' });
        }

        const claim = this._newSettlementClaim();
        const actorNote = automatedRecovery
            ? `Automatic lease-expiry recovery at ${claim.claimedAt.toISOString()}`
            : [note, `Admin settlement by ${adminId || 'superAdmin'}`, `at ${claim.claimedAt.toISOString()}`].filter(Boolean).join('; ');
        const claimed = await TransactionStatus.updateOne(
            {
                refId,
                status: { $in: ['processing', 'settlement_pending'] },
                $or: [
                    { settlementLeaseExpiresAt: { $lte: claim.claimedAt } },
                    { settlementClaimToken: { $exists: false }, settlementLeaseExpiresAt: { $exists: false } }
                ]
            },
            {
                $set: {
                    status: 'settlement_pending',
                    settlementClaimToken: claim.token,
                    settlementLeaseExpiresAt: claim.expiresAt,
                    lastAttempt: claim.claimedAt,
                    reconciliationReason: actorNote
                }
            }
        );
        if (claimed.modifiedCount !== 1) {
            const latest = await TransactionStatus.findOne({ refId });
            if (!latest) throw new Error(`TransactionStatus record '${refId}' not found`);
            throw new Error(`Cannot settle reference '${refId}': status or active settlement lease is not eligible`);
        }

        return this._settleOwnedClaim({
            refId,
            claimToken: claim.token,
            source: automatedRecovery ? 'automatic_recovery' : 'admin_reconciliation',
            actorNote
        });
    }

    async recoverStrandedSettlements({ dryRun = false } = {}) {
        const now = new Date();
        const stranded = await TransactionStatus.find({
            status: { $in: ['processing', 'settlement_pending'] },
            type: { $in: ['funding', 'investment_buy'] },
            settlementLeaseExpiresAt: { $lte: now }
        });
        if (stranded.length === 0) return { scanned: 0, settled: 0, skipped: 0 };

        let settled = 0;
        let skipped = 0;
        for (const candidate of stranded) {
            if (dryRun) {
                skipped++;
                continue;
            }
            try {
                const result = await this.adminSettleProcessing({ refId: candidate.refId, automatedRecovery: true });
                if (result.settled) settled++;
                else skipped++;
            } catch (error) {
                skipped++;
                console.error(`[SETTLEMENT-RECOVERY-SKIP] Reference=${candidate.refId}: ${error.message}`);
            }
        }
        return { scanned: stranded.length, settled, skipped };
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
        const processingToken = crypto.randomBytes(32).toString('hex');

        try {
            const webhookEvent = await WebhookEvent.create({
                ...identity,
                eventType: normalized.eventType,
                payload,
                status: 'pending',
                attemptCount: 1,
                lastAttemptAt: now,
                processingExpiresAt,
                processingToken
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
                        processingExpiresAt,
                        processingToken
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
        if (!webhookEvent || !webhookEvent.processingToken) return false;
        const result = await WebhookEvent.findOneAndUpdate(
            {
                provider: webhookEvent.provider,
                eventId: webhookEvent.eventId,
                status: 'pending',
                processingToken: webhookEvent.processingToken
            },
            {
                $set: { status, errorMessage, processingExpiresAt: null },
                $unset: { processingToken: 1 }
            },
            { new: true }
        );
        return !!result;
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

            // Only a provider-assigned Monnify virtual-account reference may establish
            // ownership when a transfer has no pre-existing local transaction record.
            const virtualOwnerId = providerCode === 'monnify'
                && normalized.virtualAccountReference === `VIRTUAL_${normalized.userId}`
                ? normalized.userId
                : null;
            if (!transaction && virtualOwnerId) {
                transaction = await TransactionStatus.create({
                    refId,
                    userId: virtualOwnerId,
                    type: 'funding',
                    status: 'pending',
                    amountKobo: Math.round(normalized.amount * 100),
                    amount: normalized.amount,
                    expectedCurrency: normalized.currency,
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
