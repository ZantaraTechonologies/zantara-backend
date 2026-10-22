'use strict'

const mongoose = require('mongoose')
const crypto = require('crypto')
const PaymentGateway = require('../models/PaymentGateway')
const TransactionStatus = require('../models/TransactionStatus')
const Transaction = require('../models/Transaction')
const User = require('../models/User')
const WebhookEvent = require('../models/WebhookEvent')
const WalletLedger = require('../models/WalletLedger')
const AuditLog = require('../models/AuditLog')
const walletService = require('./wallet.service')
const notificationService = require('./notification.service')
const investmentService = require('./investment.service')
const { parseInvestmentMoney } = require('../utils/investmentValidation')
const {
  assertPublicShareholdingAvailable,
  isPublicShareholdingAvailable,
  PUBLIC_SHAREHOLDING_HOLD_MESSAGE
} = require('../config/publicShareholding')
const { generatePaymentReference } = require('../utils/generateID')
const { createWithIdentifierRetry } = require('../utils/identifierRetry')
const {
  decryptSecret,
  decryptSecretStrict,
  encryptSecret,
  isEncrypted
} = require('../utils/crypto')
const {
  MONNIFY_BASE_URLS,
  plainMetadata,
  configurationVersion,
  isCanonicalMonnify,
  hasExactMonnifyEligibility,
  isCustomerFundingEligible,
  resolveCustomerFundingEnvironment
} = require('../utils/paymentGatewayEligibility')

const PaystackAdapter = require('../adapters/payment/paystack.adapter')
const MonnifyAdapter = require('../adapters/payment/monnify.adapter')
const FlutterwaveAdapter = require('../adapters/payment/flutterwave.adapter')
const {
  SUPPORTED_ADAPTER_CODES,
  getAdapterSpec
} = require('../adapters/payment/paymentAdapterRegistry')

const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60 * 1000
const SETTLEMENT_LEASE_MS = 15 * 60 * 1000
const ELIGIBILITY_VERIFICATION_LEASE_MS = 2 * 60 * 1000
const AUTOMATIC_SETTLEMENT_TYPES = new Set(['funding', 'investment_buy', 'gateway_test'])
const CREDENTIAL_STORAGE_STATE = Symbol('paymentGatewayCredentialStorageState')

class PaymentGatewayService {
  constructor () {
    this.adapters = {
      paystack: PaystackAdapter,
      monnify: MonnifyAdapter,
      flutterwave: FlutterwaveAdapter
    }
  }

  /**
   * Returns true if adapterType is registered in the authoritative adapter registry.
   */
  isSupportedAdapterType (adapterType) {
    if (!adapterType) return false
    return SUPPORTED_ADAPTER_CODES.includes(String(adapterType).toLowerCase())
  }

  // ─────────────────────────────────────────────────────────
  // INTERNAL HELPERS
  // ─────────────────────────────────────────────────────────

  /**
   * Decrypts secrets on a gateway document for internal adapter instantiation.
   * Never returns decrypted document to clients.
   */
  _hydrateGatewayCredentials (gateway) {
    if (!gateway) return null
    const doc = gateway.toObject ? gateway.toObject() : { ...gateway }
    doc[CREDENTIAL_STORAGE_STATE] = {
      secretKeyEncrypted: isEncrypted(doc.secretKey),
      webhookSecretEncrypted:
        !doc.webhookSecret || isEncrypted(doc.webhookSecret)
    }
    if (doc.secretKey && isEncrypted(doc.secretKey)) {
      doc.secretKey = decryptSecret(doc.secretKey)
    }
    if (doc.webhookSecret && isEncrypted(doc.webhookSecret)) {
      doc.webhookSecret = decryptSecret(doc.webhookSecret)
    }
    return doc
  }

  _snapshotGatewayConfig (gateway) {
    const protect = value => {
      if (!value) return ''
      return isEncrypted(value) ? value : encryptSecret(value)
    }
    return {
      gatewayId: String(gateway.gatewayId || gateway._id || ''),
      name: gateway.name,
      code: gateway.code,
      adapterType: gateway.adapterType,
      environment: gateway.environment,
      publicKey: gateway.publicKey || '',
      secretKey: protect(gateway.secretKey),
      webhookSecret: protect(gateway.webhookSecret),
      baseUrl: gateway.baseUrl,
      supportedChannels: gateway.supportedChannels || [],
      metadata: gateway.metadata || {},
      configurationVersion: Number(
        gateway.configurationVersion ??
        gateway.virtualAccountMutationVersion ??
        0
      )
    }
  }

  _webhookGatewayCandidates (gateway) {
    if (!gateway) return []
    const gatewayId = String(gateway._id || gateway.gatewayId || '')
    const code = String(gateway.code || '').toLowerCase()
    const adapterType = String(gateway.adapterType || code).toLowerCase()
    const snapshots = Array.isArray(gateway.webhookVerificationSnapshots)
      ? gateway.webhookVerificationSnapshots
      : []
    const candidates = [gateway]

    for (const value of snapshots) {
      const snapshot = value?.toObject ? value.toObject() : { ...(value || {}) }
      if (
        String(snapshot.gatewayId || '') !== gatewayId ||
        String(snapshot.code || '').toLowerCase() !== code ||
        String(snapshot.adapterType || '').toLowerCase() !== adapterType
      )
        continue
      candidates.push(
        this._hydrateGatewayCredentials({
          ...snapshot,
          _id: gateway._id,
          webhookVerificationSnapshots: snapshots
        })
      )
    }
    return candidates
  }

  _selectWebhookGateway (gateway, headers, rawBody) {
    const matches = []
    for (const candidate of this._webhookGatewayCandidates(gateway)) {
      const adapter = this.getAdapterInstance(candidate)
      if (adapter.verifyWebhookSignature(headers, rawBody))
        matches.push({ gateway: candidate, adapter })
    }
    if (matches.length === 0) return { matched: false }

    const contexts = new Map()
    for (const match of matches) {
      const key = JSON.stringify({
        secretKey: match.gateway.secretKey || '',
        baseUrl: match.gateway.baseUrl || '',
        environment: match.gateway.environment || ''
      })
      if (!contexts.has(key)) contexts.set(key, match)
    }
    if (contexts.size !== 1) return { matched: false, ambiguous: true }
    return { matched: true, ...contexts.values().next().value }
  }

  _isDefinitiveInitializationError (error) {
    if (error?.gatewayInitializationOutcome === 'definitive_failure')
      return true
    if (error?.code === 'PAYMENT_GATEWAY_ADAPTER_UNSUPPORTED') return true
    const status = Number(error?.response?.status)
    if (!Number.isInteger(status) || status < 400 || status >= 500) return false
    return ![408, 409, 425, 429].includes(status)
  }

  _getLegacyGatewayFallback (code) {
    const normalizedCode = String(code || '').toLowerCase()
    // Paystack is DB-only. Other legacy adapters remain unchanged in Phase 5A.
    if (normalizedCode === 'paystack') return null
    if (
      normalizedCode === 'flutterwave' &&
      process.env.FLUTTERWAVE_SECRET_KEY
    ) {
      return {
        _id: 'legacy-env-flutterwave',
        name: 'Flutterwave',
        code: 'flutterwave',
        adapterType: 'flutterwave',
        status: 'active',
        environment: process.env.FLUTTERWAVE_ENV || 'test',
        isDefault: false,
        publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY || '',
        secretKey: process.env.FLUTTERWAVE_SECRET_KEY,
        webhookSecret: process.env.FLUTTERWAVE_HASH || '',
        baseUrl:
          process.env.FLUTTERWAVE_BASE_URL || 'https://api.flutterwave.com/v3',
        supportedChannels: ['card', 'bank_transfer', 'ussd']
      }
    }
    return null
  }

  // ─────────────────────────────────────────────────────────
  // GATEWAY RETRIEVAL
  // ─────────────────────────────────────────────────────────

  /**
   * Retrieves and hydrates a single gateway by code.
   */
  async getGateway (code) {
    const normalizedCode = String(code || '')
      .trim()
      .toLowerCase()
    if (!normalizedCode) return null
    const count = await PaymentGateway.countDocuments()
    if (count === 0) {
      // Legacy fallback: only if no DB records exist
      return this._getLegacyGatewayFallback(normalizedCode)
    }

    let query = PaymentGateway.findOne({ code: normalizedCode })
    if (typeof query?.select === 'function') {
      query = query.select(
        '+webhookVerificationSnapshots +virtualAccountMutationVersion'
      )
    }
    const gateway = await query
    return gateway ? this._hydrateGatewayCredentials(gateway) : null
  }

  /**
   * Returns all gateways with status=active.
   * Multiple gateways may be simultaneously active.
   */
  async getActiveGateways () {
    const count = await PaymentGateway.countDocuments()
    if (count === 0) return []
    let query = PaymentGateway.find({ status: 'active' })
    if (typeof query?.select === 'function') {
      query = query.select('+virtualAccountMutationVersion')
    }
    const gateways = await query
    return gateways
      .map(g => this._hydrateGatewayCredentials(g))
      .filter(g => this._isCustomerFundingEligible(g))
  }

  /**
   * Returns the active gateway marked isDefault=true, or null if none.
   */
  async getDefaultGateway () {
    const count = await PaymentGateway.countDocuments()
    if (count === 0) return null
    let query = PaymentGateway.findOne({
      isDefault: true,
      status: 'active'
    })
    if (typeof query?.select === 'function') {
      query = query.select('+virtualAccountMutationVersion')
    }
    const gateway = await query
    const hydrated = gateway ? this._hydrateGatewayCredentials(gateway) : null
    return this._isCustomerFundingEligible(hydrated) ? hydrated : null
  }

  _isCustomerFundingEligible (gateway) {
    return isCustomerFundingEligible(gateway)
  }

  async getEligibleFundingGateway () {
    let query = PaymentGateway.find({ status: 'active' })
      .sort({ priority: 1, createdAt: 1 })
    if (typeof query?.select === 'function') {
      query = query.select('+virtualAccountMutationVersion')
    }
    const gateways = await query
    return gateways
      .map(candidate => this._hydrateGatewayCredentials(candidate))
      .find(candidate => this._isCustomerFundingEligible(candidate)) || null
  }

  /**
   * Returns active gateways that support the given channel.
   */
  async getGatewaysForChannel (channel) {
    const count = await PaymentGateway.countDocuments()
    if (count === 0) return []

    let query = PaymentGateway.find({
      status: 'active',
      supportedChannels: channel
    }).sort({ priority: 1, createdAt: 1 })
    if (typeof query?.select === 'function') {
      query = query.select('+virtualAccountMutationVersion')
    }
    const gateways = await query
    return gateways
      .map(g => this._hydrateGatewayCredentials(g))
      .filter(g => this._isCustomerFundingEligible(g))
  }

  async assertDatabaseManagedPaystackReady ({
    requireLive = String(process.env.PAYMENT_GATEWAY_REQUIRE_LIVE || '')
      .trim()
      .toLowerCase() === 'true'
  } = {}) {
    const gateway = await this.getGateway('paystack')
    if (!gateway)
      throw new Error('Database-managed Paystack gateway is required')
    if (String(gateway.adapterType || '').toLowerCase() !== 'paystack') {
      throw new Error("Gateway code 'paystack' must use the Paystack adapter")
    }
    if (gateway.status !== 'active') {
      throw new Error('Database-managed Paystack gateway must be active')
    }
    if (!gateway.publicKey) {
      throw new Error('Database-managed Paystack public key is required')
    }
    if (!gateway.secretKey || isEncrypted(gateway.secretKey)) {
      throw new Error(
        'Database-managed Paystack secret key is unavailable or unreadable'
      )
    }
    if (gateway.webhookSecret && isEncrypted(gateway.webhookSecret)) {
      throw new Error('Database-managed Paystack webhook secret is unreadable')
    }
    const storageState = gateway[CREDENTIAL_STORAGE_STATE]
    if (
      !storageState?.secretKeyEncrypted ||
      !storageState.webhookSecretEncrypted
    ) {
      throw new Error(
        'Database-managed Paystack credentials must be encrypted at rest'
      )
    }
    if (requireLive && gateway.environment !== 'live') {
      throw new Error(
        'Production requires a live Paystack gateway configuration'
      )
    }
    if (
      requireLive &&
      (!gateway.publicKey.startsWith('pk_live_') ||
        !gateway.secretKey.startsWith('sk_live_'))
    ) {
      throw new Error(
        'Production requires Paystack live public and secret keys'
      )
    }
    return true
  }

  /**
   * Instantiates the correct adapter for a given gateway configuration.
   *
   * Rejects unknown adapter types with a controlled error — it never silently
   * falls back to Paystack or any other gateway.
   */
  getAdapterInstance (gateway) {
    if (!gateway) throw new Error('Payment gateway configuration is required')

    const adapterType = String(
      gateway.adapterType || gateway.code || ''
    ).toLowerCase()

    if (!this.isSupportedAdapterType(adapterType)) {
      const err = new Error(
        `Unsupported payment gateway adapter: ${adapterType}`
      )
      err.code = 'PAYMENT_GATEWAY_ADAPTER_UNSUPPORTED'
      throw err
    }

    const AdapterClass = this.adapters[adapterType]
    if (!AdapterClass) {
      const err = new Error(
        `Unsupported payment gateway adapter: ${adapterType}`
      )
      err.code = 'PAYMENT_GATEWAY_ADAPTER_UNSUPPORTED'
      throw err
    }
    return new AdapterClass(gateway)
  }

  // ─────────────────────────────────────────────────────────
  // FUNDING INITIALIZATION
  // ─────────────────────────────────────────────────────────

  /**
   * Initializes wallet funding through the resolved gateway.
   */
  async initializeFunding ({
    gatewayCode,
    requiredGatewayId,
    requiredEnvironment,
    requiredStatus,
    requiredMutationVersion,
    allowInactiveGateway = false,
    administrativeSandboxTest = false,
    administrativeValidationLeaseToken,
    channel,
    channels: requestedChannels,
    user,
    amount,
    callbackUrl,
    metadata = {},
    isDirectTransfer = false
  }) {
    let parsedAmount
    try {
      parsedAmount = parseInvestmentMoney(amount, { label: 'Funding amount' })
    } catch (error) {
      throw new Error(
        'Funding amount must be a positive value with at most two decimal places'
      )
    }
    const rawAmount = parsedAmount.naira
    if (rawAmount < 50) {
      throw new Error('Minimum funding amount is ₦50.00')
    }

    const txType = administrativeSandboxTest
      ? 'gateway_test'
      : metadata?.type || 'funding'
    if (txType === 'investment_buy') assertPublicShareholdingAvailable()

    let gateway = null

    // 1. Explicit Gateway Selection
    if (gatewayCode) {
      gateway = await this.getGateway(gatewayCode)
      if (!gateway) {
        const err = new Error(`Payment gateway '${gatewayCode}' not found`)
        err.code = 'PAYMENT_GATEWAY_NOT_FOUND'
        throw err
      }

      if (gateway.status === 'inactive' && !allowInactiveGateway) {
        const err = new Error(
          `Payment gateway '${gateway.name}' is currently inactive`
        )
        err.code = 'PAYMENT_GATEWAY_INACTIVE'
        throw err
      }

      if (gateway.status === 'maintenance') {
        const err = new Error(
          `Payment gateway '${gateway.name}' is undergoing scheduled maintenance`
        )
        err.code = 'PAYMENT_GATEWAY_MAINTENANCE'
        throw err
      }

    } else if (channel) {
      // 2. Channel-based Gateway Selection — the highest-priority active gateway
      //    supporting the requested channel (priority asc, createdAt asc).
      //    No automatic failover: if the top choice errors at initialization,
      //    the user simply retries — the transaction stays bound to one gateway.
      const candidates = await this.getGatewaysForChannel(channel)
      if (candidates.length === 0) {
        const err = new Error(
          `No active payment gateway supports channel '${channel}'`
        )
        err.code = 'PAYMENT_CHANNEL_UNSUPPORTED'
        throw err
      }
      gateway = candidates[0]
    } else {
      // 3. Default Gateway Fallback
      gateway = await this.getDefaultGateway()
      if (!this._isCustomerFundingEligible(gateway)) {
        gateway = await this.getEligibleFundingGateway()
      }
      if (!gateway) {
        const err = new Error(
          'No active payment gateway is configured on the platform'
        )
        err.code = 'PAYMENT_CONFIGURATION_ERROR'
        throw err
      }
    }

    if (
      allowInactiveGateway &&
      (
        !administrativeSandboxTest ||
        !requiredGatewayId ||
        !requiredEnvironment ||
        requiredStatus !== 'inactive' ||
        requiredMutationVersion === undefined ||
        !gatewayCode
      )
    ) {
      const err = new Error(
        'Inactive gateway initialization requires pinned gateway identity and environment.'
      )
      err.code = 'PAYMENT_GATEWAY_INACTIVE_OVERRIDE_INVALID'
      throw err
    }

    if (
      requiredGatewayId !== undefined &&
      String(gateway._id || gateway.gatewayId || '') !== String(requiredGatewayId)
    ) {
      const err = new Error('The selected payment gateway configuration changed. Please retry.')
      err.code = 'PAYMENT_GATEWAY_IDENTITY_MISMATCH'
      throw err
    }
    if (
      requiredEnvironment !== undefined &&
      gateway.environment !== requiredEnvironment
    ) {
      const err = new Error('The selected payment gateway environment changed. Please retry.')
      err.code = 'PAYMENT_GATEWAY_ENVIRONMENT_MISMATCH'
      throw err
    }
    if (requiredStatus !== undefined && gateway.status !== requiredStatus) {
      const err = new Error('The selected payment gateway status changed. Please retry.')
      err.code = 'PAYMENT_GATEWAY_STATUS_MISMATCH'
      throw err
    }
    if (
      requiredMutationVersion !== undefined &&
      Number(gateway.virtualAccountMutationVersion || 0) !== Number(requiredMutationVersion)
    ) {
      const err = new Error('The selected payment gateway configuration changed. Please retry.')
      err.code = 'PAYMENT_GATEWAY_CONFIGURATION_MISMATCH'
      throw err
    }
    const gatewayMetadata = gateway.metadata instanceof Map
      ? Object.fromEntries(gateway.metadata)
      : gateway.metadata || {}
    if (gatewayMetadata.administrativeSandboxOnly === true && !administrativeSandboxTest) {
      const err = new Error('This payment gateway is restricted to administrative sandbox validation.')
      err.code = 'PAYMENT_GATEWAY_SANDBOX_ISOLATED'
      throw err
    }
    if (!administrativeSandboxTest && !this._isCustomerFundingEligible(gateway)) {
      const err = new Error(
        'This payment gateway is not eligible for customer funding in the current environment.'
      )
      err.code = 'PAYMENT_GATEWAY_CUSTOMER_FUNDING_INELIGIBLE'
      throw err
    }

    const requested = channel
      ? [channel]
      : Array.isArray(requestedChannels)
      ? [...new Set(requestedChannels)]
      : []
    if (requested.length > 0) {
      const configuredChannels = gateway.supportedChannels || []
      const adapterChannels =
        getAdapterSpec(gateway.adapterType || gateway.code)
          ?.supportedChannels || []
      const unsupported = requested.find(
        item =>
          (configuredChannels.length > 0 && !configuredChannels.includes(item)) ||
          !adapterChannels.includes(item)
      )
      if (unsupported) {
        const err = new Error(
          `Channel '${unsupported}' is not supported by ${gateway.name}`
        )
        err.code = 'PAYMENT_CHANNEL_UNSUPPORTED'
        throw err
      }
    }

    console.log(
      `[PaymentGateway] Initializing funding via ${gateway.code} for user ${
        user._id || user.id
      }`
    )

    const amountKobo = parsedAmount.kobo
    const restrictedChannels = channel
      ? [channel]
      : Array.isArray(requestedChannels) && requestedChannels.length > 0
      ? [...new Set(requestedChannels)]
      : null
    const channels = restrictedChannels
      || (gateway.supportedChannels && gateway.supportedChannels.length
      ? gateway.supportedChannels
      : ['card', 'bank_transfer', 'ussd'])

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
    let sharePriceSnapshot = null
    if (txType === 'investment_buy') {
      const invSettings = await investmentService.getInvestmentSettings()
      if (!invSettings.investmentEnabled) {
        const err = new Error(
          'Share purchase is temporarily unavailable. Please try again later.'
        )
        err.code = 'INVALID_INVESTMENT_CONFIGURATION'
        throw err
      }
      let sharePrice
      try {
        sharePrice = parseInvestmentMoney(invSettings.sharePrice, {
          label: 'Share price'
        })
      } catch (error) {
        const configurationError = new Error(
          'Share purchase is temporarily unavailable. Please try again later.'
        )
        configurationError.code = 'INVALID_INVESTMENT_CONFIGURATION'
        throw configurationError
      }
      if (amountKobo % sharePrice.kobo !== 0) {
        const err = new Error(
          'Share-purchase amount must purchase a whole number of shares.'
        )
        err.code = 'INVALID_INVESTMENT_AMOUNT'
        throw err
      }
      const qty = amountKobo / sharePrice.kobo
      if (
        qty < invSettings.minSharesPerPurchase ||
        qty > invSettings.maxSharesPerUser ||
        qty > invSettings.totalSharesAvailable
      ) {
        const err = new Error(
          'Share-purchase amount is outside the permitted share limits.'
        )
        err.code = 'INVALID_INVESTMENT_AMOUNT'
        throw err
      }
      let sharesOwned
      try {
        sharesOwned = await investmentService.getAuthoritativeShareBalance(
          user._id || user.id
        )
      } catch (error) {
        const err = new Error(
          'Shareholding record requires share-balance reconciliation.'
        )
        err.code = 'INVALID_INVESTMENT_CONFIGURATION'
        throw err
      }
      if (sharesOwned + qty > invSettings.maxSharesPerUser) {
        const err = new Error(
          'Share-purchase amount exceeds the permitted per-user share limit.'
        )
        err.code = 'INVALID_INVESTMENT_AMOUNT'
        throw err
      }
      sharePriceSnapshot = sharePrice.naira
    }

    // Persist and reserve the reference before the gateway sees it. Duplicate
    // retries cannot repeat an external initialization or financial side effect.
    const reference = await createWithIdentifierRetry({
      label: 'Payment',
      fields: ['refId'],
      generate: () => ({ refId: generatePaymentReference(gateway.code) }),
      create: async ({ refId }) => {
        await TransactionStatus.create({
          refId,
          userId: user._id || user.id,
          type: txType,
          status: 'pending',
          amountKobo,
          amount: rawAmount,
          expectedCurrency: 'NGN',
          channels,
          provider: gateway.code,
          gatewayId: String(gateway._id || gateway.gatewayId || ''),
          service: gateway.name,
          gatewayConfigSnapshot: this._snapshotGatewayConfig(gateway),
          ...(txType === 'gateway_test' && administrativeValidationLeaseToken
            ? { administrativeValidationLeaseToken }
            : {}),
          initializationOutcome: 'pending',
          ...(sharePriceSnapshot != null
            ? { sharePrice: sharePriceSnapshot }
            : {})
        })
        return refId
      }
    })

    // 5. Delegate to Adapter
    // Resolve the effective callback URL exactly as the adapter will (the
    // adapter defaults to CLIENT_BASE_URL/<gateway>/return). The mobile
    // WebView needs this host to distinguish the definitive final RETURN
    // navigation from intermediate 3DS/issuer/card-auth navigation.
    const effectiveCallbackUrl =
      callbackUrl ||
      `${process.env.CLIENT_BASE_URL || 'http://localhost:5173'}/${
        gateway.adapterType || gateway.code
      }/return`
    let initResult
    try {
      const adapter = this.getAdapterInstance(gateway)
      initResult = await adapter.initializePayment({
        user,
        amount: rawAmount,
        channel,
        // Omit channel restrictions for normal wallet funding so the hosted
        // checkout can expose methods enabled for this merchant. Explicitly
        // restricted legacy flows continue to pass their requested channels.
        channels: restrictedChannels || undefined,
        reference,
        callbackUrl,
        metadata: {
          ...metadata,
          userId: user._id || user.id,
          refId: reference,
          gateway: gateway.code
        },
        isDirectTransfer
      })
    } catch (error) {
      const definitive = this._isDefinitiveInitializationError(error)
      try {
        await TransactionStatus.updateOne(
          { refId: reference, status: 'pending' },
          {
            $set: {
              status: definitive ? 'failed' : 'pending',
              initializationOutcome: definitive
                ? 'definitive_failure'
                : 'ambiguous',
              errorMessage: error.message,
              lastAttempt: new Date()
            }
          }
        )
      } catch (statusError) {
        console.error(
          `[PAYMENT-INIT-STATUS-ERROR] Reference=${reference}: ${statusError.message}`
        )
      }
      if (!definitive) {
        const ambiguous = new Error(
          'Payment initialization is awaiting gateway confirmation. Do not retry this reference.'
        )
        ambiguous.code = 'PAYMENT_INITIALIZATION_AMBIGUOUS'
        ambiguous.status = 'pending'
        ambiguous.reference = reference
        ambiguous.provider = gateway.code
        ambiguous.checkoutProvider = gateway.adapterType || gateway.code
        ambiguous.requestDispatched = error.requestDispatched
        ambiguous.cause = error
        throw ambiguous
      }
      throw error
    }

    return {
      success: true,
      authorizationUrl: initResult.authorizationUrl,
      reference,
      provider: gateway.code,
      checkoutProvider: gateway.adapterType || gateway.code,
      gateway: gateway.code,
      callbackUrl: effectiveCallbackUrl,
      raw: initResult.raw,
      // For direct transfer details
      accountNumber: initResult.accountNumber,
      bankName: initResult.bankName,
      accountName: initResult.accountName,
      amount: initResult.amount || rawAmount
    }
  }

  // ─────────────────────────────────────────────────────────
  // UNIVERSAL WALLET-CREDIT SAFETY FINALIZER
  // ─────────────────────────────────────────────────────────

  _newSettlementClaim () {
    const now = new Date()
    return {
      token: crypto.randomBytes(32).toString('hex'),
      claimedAt: now,
      expiresAt: new Date(now.getTime() + SETTLEMENT_LEASE_MS)
    }
  }

  _assertSettlementEnvironment (transactionStatus) {
    if (!transactionStatus || transactionStatus.type === 'gateway_test') return
    const runtimeEnvironment = resolveCustomerFundingEnvironment()
    const snapshotEnvironment = String(
      transactionStatus.gatewayConfigSnapshot?.environment || ''
    ).trim().toLowerCase()
    if (runtimeEnvironment && snapshotEnvironment !== runtimeEnvironment) {
      const error = new Error(
        `Payment environment mismatch: runtime is '${runtimeEnvironment}', transaction is '${snapshotEnvironment}'`
      )
      error.code = 'PAYMENT_GATEWAY_RUNTIME_ENVIRONMENT_MISMATCH'
      throw error
    }
  }

  _requirePositiveSafeKobo (value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      const error = new Error(
        `${label} must be a positive safe-integer kobo amount`
      )
      error.code = 'PAYMENT_EVIDENCE_INVALID'
      throw error
    }
    return value
  }

  _nairaToKobo (value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      const error = new Error(`${label} must be a positive finite number`)
      error.code = 'PAYMENT_EVIDENCE_INVALID'
      throw error
    }
    const rawKobo = value * 100
    const kobo = Math.round(rawKobo)
    if (!Number.isSafeInteger(kobo) || Math.abs(rawKobo - kobo) > 1e-7) {
      const error = new Error(
        `${label} must reconcile exactly to safe integer kobo`
      )
      error.code = 'PAYMENT_EVIDENCE_INVALID'
      throw error
    }
    return kobo
  }

  _validatedGatewayEvidence (transactionStatus, gatewayPaymentResult) {
    const refId = transactionStatus && transactionStatus.refId
    if (!transactionStatus || !refId)
      throw new Error(
        '[Funding Safety] Local transaction reference is required'
      )
    if (!transactionStatus.userId)
      throw new Error(
        `[Funding Safety] Reference '${refId}' has no authoritative local owner`
      )
    if (!AUTOMATIC_SETTLEMENT_TYPES.has(transactionStatus.type)) {
      throw new Error(
        `[Funding Safety] Unsupported automatic settlement type '${transactionStatus.type}'`
      )
    }

    const localProvider = String(transactionStatus.provider || '')
      .trim()
      .toLowerCase()
    const confirmedProvider = String(
      (gatewayPaymentResult && gatewayPaymentResult.gateway) || ''
    )
      .trim()
      .toLowerCase()
    if (
      !localProvider ||
      !confirmedProvider ||
      localProvider !== confirmedProvider
    ) {
      const error = new Error(
        `Provider mismatch: expected '${
          localProvider || 'missing'
        }', confirmed '${confirmedProvider || 'missing'}'`
      )
      error.code = 'PAYMENT_GATEWAY_MISMATCH'
      throw error
    }

    const confirmedReference = String(
      gatewayPaymentResult.reference || ''
    ).trim()
    if (!confirmedReference || confirmedReference !== refId) {
      const error = new Error(
        `Reference mismatch: expected '${refId}', confirmed '${
          confirmedReference || 'missing'
        }'`
      )
      error.code = 'PAYMENT_REFERENCE_MISMATCH'
      throw error
    }

    const expectedKobo = this._requirePositiveSafeKobo(
      transactionStatus.amountKobo,
      'Expected amount'
    )
    const confirmedKobo = this._nairaToKobo(
      gatewayPaymentResult.amount,
      'Confirmed amount'
    )
    if (expectedKobo !== confirmedKobo) {
      const error = new Error(
        `Amount mismatch: expected ${expectedKobo} kobo, confirmed ${confirmedKobo} kobo`
      )
      error.code = 'PAYMENT_AMOUNT_MISMATCH'
      throw error
    }

    const expectedCurrency = String(transactionStatus.expectedCurrency || '')
      .trim()
      .toUpperCase()
    const confirmedCurrency = String(gatewayPaymentResult.currency || '')
      .trim()
      .toUpperCase()
    if (
      !expectedCurrency ||
      !confirmedCurrency ||
      expectedCurrency !== confirmedCurrency
    ) {
      const error = new Error(
        `Currency mismatch: expected '${
          expectedCurrency || 'missing'
        }', confirmed '${confirmedCurrency || 'missing'}'`
      )
      error.code = 'PAYMENT_CURRENCY_MISMATCH'
      throw error
    }

    const confirmedProviderRef = String(
      gatewayPaymentResult.providerTransactionId || ''
    ).trim()
    if (!confirmedProviderRef) {
      const error = new Error(
        'Confirmed provider transaction identifier is required'
      )
      error.code = 'PAYMENT_EVIDENCE_INVALID'
      throw error
    }

    return {
      confirmedAmountKobo: confirmedKobo,
      confirmedCurrency,
      confirmedProvider,
      confirmedReference,
      confirmedProviderRef
    }
  }

  _assertPersistedSettlementEvidence (transactionStatus) {
    const invalid = message => {
      const error = new Error(message)
      error.code = 'SETTLEMENT_EVIDENCE_INVALID'
      return error
    }
    if (!transactionStatus || !transactionStatus.refId)
      throw invalid('Persisted settlement reference is required')
    if (!transactionStatus.userId)
      throw invalid(
        `Reference '${transactionStatus.refId}' has no authoritative local owner`
      )
    if (!AUTOMATIC_SETTLEMENT_TYPES.has(transactionStatus.type)) {
      throw invalid(
        `Unsupported automatic settlement type '${transactionStatus.type}'`
      )
    }

    let expectedKobo
    let confirmedKobo
    try {
      expectedKobo = this._requirePositiveSafeKobo(
        transactionStatus.amountKobo,
        'Expected amount'
      )
      confirmedKobo = this._requirePositiveSafeKobo(
        transactionStatus.confirmedAmountKobo,
        'Confirmed amount'
      )
    } catch (error) {
      throw invalid(error.message)
    }
    if (expectedKobo !== confirmedKobo)
      throw invalid('Persisted settlement amount mismatch')

    const provider = String(transactionStatus.provider || '')
      .trim()
      .toLowerCase()
    const confirmedProvider = String(transactionStatus.confirmedProvider || '')
      .trim()
      .toLowerCase()
    if (!provider || !confirmedProvider || provider !== confirmedProvider)
      throw invalid('Persisted settlement provider mismatch')

    const confirmedReference = String(
      transactionStatus.confirmedReference || ''
    ).trim()
    if (!confirmedReference || confirmedReference !== transactionStatus.refId)
      throw invalid('Persisted settlement reference mismatch')

    const expectedCurrency = String(transactionStatus.expectedCurrency || '')
      .trim()
      .toUpperCase()
    const confirmedCurrency = String(transactionStatus.confirmedCurrency || '')
      .trim()
      .toUpperCase()
    if (
      !expectedCurrency ||
      !confirmedCurrency ||
      expectedCurrency !== confirmedCurrency
    )
      throw invalid('Persisted settlement currency mismatch')
    const confirmedProviderRef = String(
      transactionStatus.confirmedProviderRef || ''
    ).trim()
    if (!confirmedProviderRef)
      throw invalid('Persisted provider transaction identifier is required')

    return {
      expectedKobo,
      confirmedKobo,
      provider,
      expectedCurrency,
      confirmedProviderRef
    }
  }

  _providerTransactionReuseError (
    provider,
    providerTransactionId,
    ownerRefId,
    attemptedRefId
  ) {
    const error = new Error(
      `Provider transaction '${provider}:${providerTransactionId}' already belongs to local reference '${ownerRefId}' and cannot settle '${attemptedRefId}'`
    )
    error.code = 'PAYMENT_PROVIDER_TRANSACTION_REUSED'
    error.statusCode = 409
    return error
  }

  async _assertProviderTransactionOwner ({
    provider,
    providerTransactionId,
    refId,
    session = null
  }) {
    const query = TransactionStatus.findOne({
      confirmedProvider: provider,
      confirmedProviderRef: providerTransactionId
    })
    const owner = session ? await query.session(session) : await query
    if (owner && String(owner.refId) !== String(refId)) {
      throw this._providerTransactionReuseError(
        provider,
        providerTransactionId,
        owner.refId,
        refId
      )
    }
  }

  async _markReconciliationRequired (transactionStatus, error) {
    if (!transactionStatus || transactionStatus.status === 'failed') return
    const result = error.gatewayPaymentResult || {}
    const confirmedAmount =
      typeof result.amount === 'number' &&
      Number.isFinite(result.amount) &&
      result.amount > 0
        ? Math.round(result.amount * 100)
        : null
    await TransactionStatus.updateOne(
      { refId: transactionStatus.refId, status: transactionStatus.status },
      {
        $set: {
          status: 'reconciliation_required',
          reconciliationReason: error.message,
          ...(Number.isSafeInteger(confirmedAmount)
            ? { confirmedAmountKobo: confirmedAmount }
            : {}),
          ...(result.currency
            ? { confirmedCurrency: String(result.currency).toUpperCase() }
            : {}),
          ...(result.reference
            ? { confirmedReference: String(result.reference) }
            : {})
        }
      }
    )
  }

  async finalizeFundingCredit ({
    transactionStatus,
    gatewayPaymentResult,
    source = 'webhook',
    verificationLeaseToken = null
  }) {
    if (!transactionStatus)
      throw new Error('[Funding Safety] TransactionStatus record is required')
    this._assertSettlementEnvironment(transactionStatus)
    const refId = transactionStatus.refId
    const gatewayTestLeaseFilter = transactionStatus.type === 'gateway_test'
      ? (verificationLeaseToken
          ? { eligibilityVerificationLeaseToken: verificationLeaseToken }
          : { eligibilityVerificationLeaseToken: { $exists: false } })
      : {}

    if (transactionStatus.status === 'success') {
      return {
        success: true,
        status: 'success',
        alreadyProcessed: true,
        credited: false
      }
    }
    if (
      ['processing', 'settlement_pending', 'reconciliation_required'].includes(
        transactionStatus.status
      )
    ) {
      return {
        success: false,
        status: transactionStatus.status,
        alreadyProcessed: true,
        credited: false
      }
    }

    if (!gatewayPaymentResult || gatewayPaymentResult.status !== 'success') {
      if (gatewayPaymentResult && gatewayPaymentResult.status === 'failed') {
        const providerPaymentStatus = String(
          gatewayPaymentResult.providerStatus || ''
        ).trim().toUpperCase()
        const exactGatewayTestFailure =
          transactionStatus.type === 'gateway_test' &&
          String(transactionStatus.provider || '').toLowerCase() === 'monnify' &&
          ['FAILED', 'EXPIRED'].includes(providerPaymentStatus) &&
          String(gatewayPaymentResult.reference || '') === String(refId)
        const providerVerifiedAt = new Date()
        const confirmedAmountKobo = Number.isFinite(gatewayPaymentResult.amount)
          ? Math.round(Number(gatewayPaymentResult.amount) * 100)
          : null
        const failed = await TransactionStatus.updateOne(
          {
            refId,
            status: 'pending',
            ...(transactionStatus.type === 'gateway_test'
              ? { type: 'gateway_test', provider: transactionStatus.provider }
              : {}),
            ...gatewayTestLeaseFilter
          },
          {
            $set: {
              status: 'failed',
              errorMessage:
                gatewayPaymentResult.message || 'Payment failed at gateway',
              ...(exactGatewayTestFailure
                ? {
                    providerPaymentStatus,
                    providerVerifiedAt,
                    confirmedReference: String(gatewayPaymentResult.reference),
                    ...(Number.isSafeInteger(confirmedAmountKobo)
                      ? { confirmedAmountKobo }
                      : {}),
                    ...(gatewayPaymentResult.currency
                      ? {
                          confirmedCurrency: String(
                            gatewayPaymentResult.currency
                          ).toUpperCase()
                        }
                      : {})
                  }
                : {})
            }
          }
        )
        if (failed.modifiedCount !== 1) {
          const latest = await TransactionStatus.findOne({ refId })
          return {
            success: latest?.status === 'success',
            status: latest?.status || 'pending',
            providerStatus: latest?.providerPaymentStatus || undefined,
            alreadyProcessed: true,
            credited: false
          }
        }
        if (
          transactionStatus.userId &&
          transactionStatus.type !== 'gateway_test'
        ) {
          notificationService
            .sendFundingAdvisory(transactionStatus.userId, {
              kind: 'failed',
              amount: (transactionStatus.amountKobo || 0) / 100,
              reference: refId
            })
            .catch(error =>
              console.error('[Funding Advisory Error]', error.message)
            )
        }
      }
      return {
        success: false,
        status:
          (gatewayPaymentResult && gatewayPaymentResult.status) || 'pending',
        ...(gatewayPaymentResult?.providerStatus
          ? { providerStatus: gatewayPaymentResult.providerStatus }
          : {}),
        message:
          (gatewayPaymentResult && gatewayPaymentResult.message) ||
          'Payment provider did not confirm success'
      }
    }

    let evidence
    try {
      evidence = this._validatedGatewayEvidence(
        transactionStatus,
        gatewayPaymentResult
      )
      await this._assertProviderTransactionOwner({
        provider: evidence.confirmedProvider,
        providerTransactionId: evidence.confirmedProviderRef,
        refId
      })
    } catch (error) {
      error.gatewayPaymentResult = gatewayPaymentResult
      await this._markReconciliationRequired(transactionStatus, error)
      if (transactionStatus.status === 'failed') {
        return {
          success: false,
          status: 'failed',
          alreadyProcessed: true,
          credited: false
        }
      }
      throw error
    }

    if (transactionStatus.status === 'failed') {
      if (source !== 'webhook' || transactionStatus.type !== 'funding') {
        return {
          success: false,
          status: 'failed',
          alreadyProcessed: true,
          credited: false
        }
      }
      const priorCredit = await WalletLedger.findOne({
        reference: refId,
        userId: transactionStatus.userId,
        entryType: 'credit',
        source: { $in: ['funding', 'funding_retry'] }
      })
      if (priorCredit) {
        return {
          success: false,
          status: 'failed',
          alreadyProcessed: true,
          credited: false
        }
      }
    } else if (transactionStatus.status !== 'pending') {
      return {
        success: false,
        status: transactionStatus.status,
        alreadyProcessed: true,
        credited: false
      }
    }

    if (
      transactionStatus.type === 'investment_buy' &&
      source !== 'admin_reconciliation' &&
      !isPublicShareholdingAvailable()
    ) {
      try {
        const deferred = await TransactionStatus.updateOne(
          { refId, status: 'pending' },
          {
            $set: {
              status: 'settlement_pending',
              ...evidence,
              settlementLeaseExpiresAt: new Date(0),
              lastAttempt: new Date(),
              reconciliationReason: PUBLIC_SHAREHOLDING_HOLD_MESSAGE
            },
            $unset: { settlementClaimToken: 1 }
          }
        )
        if (deferred.modifiedCount !== 1) {
          const latest = await TransactionStatus.findOne({ refId })
          return {
            success: latest?.status === 'success',
            status: latest?.status || 'pending',
            alreadyProcessed: true,
            credited: false
          }
        }
      } catch (error) {
        if (error?.code === 11000) {
          await this._assertProviderTransactionOwner({
            provider: evidence.confirmedProvider,
            providerTransactionId: evidence.confirmedProviderRef,
            refId
          })
        }
        throw error
      }
      return {
        success: false,
        status: 'settlement_pending',
        credited: false,
        deferred: true,
        message: PUBLIC_SHAREHOLDING_HOLD_MESSAGE
      }
    }

    const claim = this._newSettlementClaim()
    let claimResult
    try {
      claimResult = await TransactionStatus.updateOne(
        {
          refId,
          status: transactionStatus.status,
          ...gatewayTestLeaseFilter
        },
        {
          $set: {
            status: 'processing',
            ...evidence,
            settlementClaimToken: claim.token,
            settlementLeaseExpiresAt: claim.expiresAt,
            lastAttempt: claim.claimedAt,
            ...(transactionStatus.status === 'failed'
              ? {
                  reconciliationReason: `Authenticated webhook recovery at ${claim.claimedAt.toISOString()}`
                }
              : {})
          },
          ...(transactionStatus.type === 'gateway_test'
            ? {
                $unset: {
                  eligibilityVerificationLeaseToken: 1,
                  eligibilityVerificationLeaseExpiresAt: 1
                }
              }
            : {})
        }
      )
    } catch (error) {
      if (error && error.code === 11000) {
        try {
          await this._assertProviderTransactionOwner({
            provider: evidence.confirmedProvider,
            providerTransactionId: evidence.confirmedProviderRef,
            refId
          })
        } catch (reuseError) {
          reuseError.gatewayPaymentResult = gatewayPaymentResult
          await this._markReconciliationRequired(transactionStatus, reuseError)
          throw reuseError
        }
      }
      throw error
    }

    if (claimResult.modifiedCount !== 1) {
      const latest = await TransactionStatus.findOne({ refId })
      return {
        success: latest && latest.status === 'success',
        status: (latest && latest.status) || 'processing',
        alreadyProcessed: true,
        credited: false
      }
    }

    return this._settleOwnedClaim({
      refId,
      claimToken: claim.token,
      source,
      gatewayPaymentResult
    })
  }

  async _settleOwnedClaim ({
    refId,
    claimToken,
    source = 'recovery',
    gatewayPaymentResult = null,
    actorNote = ''
  }) {
    if (!refId || !claimToken)
      throw new Error('Settlement reference and claim token are required')
    const session = await mongoose.startSession()
    session.startTransaction()
    let transactionStatus
    let amountNaira
    let credited = false

    try {
      let settlementQuery = TransactionStatus.findOne({ refId })
      if (typeof settlementQuery?.select === 'function') {
        settlementQuery = settlementQuery.select('+gatewayConfigSnapshot')
      }
      transactionStatus = await settlementQuery.session(session)
      if (!transactionStatus)
        throw new Error(`TransactionStatus record '${refId}' not found`)
      this._assertSettlementEnvironment(transactionStatus)
      const bypassPublicShareholdingHold = source === 'admin_reconciliation'
      if (
        transactionStatus.type === 'investment_buy' &&
        !bypassPublicShareholdingHold
      ) {
        assertPublicShareholdingAvailable()
      }
      if (
        !['processing', 'settlement_pending'].includes(transactionStatus.status)
      ) {
        throw new Error(
          `Cannot settle reference '${refId}': status is '${transactionStatus.status}'`
        )
      }
      if (transactionStatus.settlementClaimToken !== claimToken) {
        const error = new Error(
          `Settlement claim ownership lost for '${refId}'`
        )
        error.code = 'SETTLEMENT_CLAIM_LOST'
        throw error
      }
      const leaseExpiry = new Date(
        transactionStatus.settlementLeaseExpiresAt || 0
      )
      if (!leaseExpiry.getTime() || leaseExpiry <= new Date()) {
        const error = new Error(`Settlement lease expired for '${refId}'`)
        error.code = 'SETTLEMENT_LEASE_EXPIRED'
        throw error
      }

      const evidence =
        this._assertPersistedSettlementEvidence(transactionStatus)
      await this._assertProviderTransactionOwner({
        provider: evidence.provider,
        providerTransactionId: evidence.confirmedProviderRef,
        refId,
        session
      })
      amountNaira = evidence.confirmedKobo / 100

      const settleClaim = await TransactionStatus.updateOne(
        {
          refId,
          status: { $in: ['processing', 'settlement_pending'] },
          settlementClaimToken: claimToken
        },
        {
          $set: {
            status: 'settlement_pending',
            ...(actorNote ? { reconciliationReason: actorNote } : {})
          }
        },
        { session }
      )
      if (settleClaim.matchedCount !== 1)
        throw new Error(`Settlement claim ownership lost for '${refId}'`)

      if (transactionStatus.type === 'investment_buy') {
        const sharePrice = Number(transactionStatus.sharePrice)
        let sharePriceKobo
        try {
          sharePriceKobo = this._nairaToKobo(sharePrice, 'Share price')
        } catch (error) {
          error.code = 'SETTLEMENT_EVIDENCE_INVALID'
          throw error
        }
        if (evidence.confirmedKobo % sharePriceKobo !== 0) {
          const error = new Error(
            `Confirmed amount for '${refId}' is not a whole multiple of the snapshotted share price`
          )
          error.code = 'SETTLEMENT_EVIDENCE_INVALID'
          throw error
        }
        const qty = evidence.confirmedKobo / sharePriceKobo
        let fulfillment
        try {
          fulfillment = await investmentService.fulfillSharePurchase(
            transactionStatus.userId,
            qty,
            refId,
            false,
            session,
            sharePrice,
            { bypassPublicShareholdingHold }
          )
        } catch (error) {
          if (
            error.code === 'SETTLEMENT_EVIDENCE_INVALID' ||
            /share limit|share supply|share purchases are currently disabled|investment feature is currently disabled|audit does not reconcile/i.test(
              error.message || ''
            )
          ) {
            error.code = 'SETTLEMENT_EVIDENCE_INVALID'
          }
          throw error
        }
        credited = !(fulfillment && fulfillment.message === 'Already processed')
      } else if (transactionStatus.type !== 'gateway_test') {
        const settlementKey = `payment:${evidence.provider}:${refId}`
        const historicalCredit = await WalletLedger.findOne({
          reference: refId,
          userId: transactionStatus.userId,
          entryType: 'credit',
          source: { $in: ['funding', 'funding_retry'] }
        }).session(session)
        if (historicalCredit) {
          if (historicalCredit.amount !== amountNaira) {
            const error = new Error(
              'Historical funding credit amount does not reconcile'
            )
            error.code = 'SETTLEMENT_EVIDENCE_INVALID'
            throw error
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
          )
          credited = true
        }

        const existingAudit = await Transaction.findOne({
          transactionId: refId
        }).session(session)
        if (existingAudit) {
          const sameUser =
            String(existingAudit.userId) === String(transactionStatus.userId)
          const sameAmount =
            Number(existingAudit.amount) === Number(amountNaira)
          if (
            !sameUser ||
            existingAudit.type !== 'funding' ||
            !sameAmount ||
            existingAudit.refId !== refId
          ) {
            const error = new Error(
              `Funding audit identity conflict for '${refId}'`
            )
            error.code = 'SETTLEMENT_EVIDENCE_INVALID'
            throw error
          }
        } else {
          await Transaction.create(
            [
              {
                userId: transactionStatus.userId,
                transactionId: refId,
                refId,
                type: 'funding',
                service: transactionStatus.service || evidence.provider,
                amount: amountNaira,
                status: 'success',
                response:
                  (gatewayPaymentResult && gatewayPaymentResult.raw) || {}
              }
            ],
            { session }
          )
        }
      }

      const finalized = await TransactionStatus.updateOne(
        {
          refId,
          status: 'settlement_pending',
          settlementClaimToken: claimToken
        },
        {
          $set: { status: 'success', lastAttempt: new Date() },
          $unset: { settlementClaimToken: 1, settlementLeaseExpiresAt: 1 }
        },
        { session }
      )
      if (finalized.modifiedCount !== 1) {
        const error = new Error(
          `Settlement claim ownership lost before finalization for '${refId}'`
        )
        error.code = 'SETTLEMENT_CLAIM_LOST'
        throw error
      }

      await session.commitTransaction()
    } catch (error) {
      await session.abortTransaction()
      if (
        error.code === 'SETTLEMENT_EVIDENCE_INVALID' ||
        error.code === 'PAYMENT_PROVIDER_TRANSACTION_REUSED'
      ) {
        await TransactionStatus.updateOne(
          {
            refId,
            settlementClaimToken: claimToken,
            status: { $in: ['processing', 'settlement_pending'] }
          },
          {
            $set: {
              status: 'reconciliation_required',
              reconciliationReason: error.message
            },
            $unset: { settlementClaimToken: 1, settlementLeaseExpiresAt: 1 }
          }
        )
      }
      throw error
    } finally {
      session.endSession()
    }

    if (transactionStatus.type !== 'gateway_test') {
      notificationService
        .sendFundingSuccess({
          userId: transactionStatus.userId,
          amount: amountNaira,
          method:
            (transactionStatus.channels?.length === 1
              ? transactionStatus.channels[0]
              : transactionStatus.service || transactionStatus.provider) ||
            'funding',
          reference: refId,
          type: transactionStatus.type
        })
        .catch(error =>
          console.error('[Funding Notification Background Error]', error.message)
        )
    }

    return {
      success: true,
      settled: true,
      status: 'success',
      credited,
      amount: amountNaira,
      type: transactionStatus.type,
      reference: refId,
      source
    }
  }

  async adminSettleProcessing ({
    refId,
    adminId = null,
    note = '',
    claimToken = null,
    automatedRecovery = false
  }) {
    if (!refId) throw new Error('Reference is required for settlement')
    if (claimToken) {
      return this._settleOwnedClaim({
        refId,
        claimToken,
        source: automatedRecovery
          ? 'automatic_recovery'
          : 'admin_reconciliation'
      })
    }

    const claim = this._newSettlementClaim()
    const actorNote = automatedRecovery
      ? `Automatic lease-expiry recovery at ${claim.claimedAt.toISOString()}`
      : [
          note,
          `Admin settlement by ${adminId || 'superAdmin'}`,
          `at ${claim.claimedAt.toISOString()}`
        ]
          .filter(Boolean)
          .join('; ')
    const claimed = await TransactionStatus.updateOne(
      {
        refId,
        status: { $in: ['processing', 'settlement_pending'] },
        $or: [
          { settlementLeaseExpiresAt: { $lte: claim.claimedAt } },
          {
            settlementClaimToken: { $exists: false },
            settlementLeaseExpiresAt: { $exists: false }
          }
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
    )
    if (claimed.modifiedCount !== 1) {
      const latest = await TransactionStatus.findOne({ refId })
      if (!latest)
        throw new Error(`TransactionStatus record '${refId}' not found`)
      throw new Error(
        `Cannot settle reference '${refId}': status or active settlement lease is not eligible`
      )
    }

    return this._settleOwnedClaim({
      refId,
      claimToken: claim.token,
      source: automatedRecovery ? 'automatic_recovery' : 'admin_reconciliation',
      actorNote
    })
  }

  async recoverStrandedSettlements ({ dryRun = false } = {}) {
    const now = new Date()
    const stranded = await TransactionStatus.find({
      status: { $in: ['processing', 'settlement_pending'] },
      type: { $in: ['funding', 'investment_buy', 'gateway_test'] },
      settlementLeaseExpiresAt: { $lte: now }
    })
    if (stranded.length === 0) return { scanned: 0, settled: 0, skipped: 0 }

    let settled = 0
    let skipped = 0
    for (const candidate of stranded) {
      if (dryRun) {
        skipped++
        continue
      }
      if (
        candidate.type === 'investment_buy' &&
        !isPublicShareholdingAvailable()
      ) {
        skipped++
        continue
      }
      try {
        const result = await this.adminSettleProcessing({
          refId: candidate.refId,
          automatedRecovery: true
        })
        if (result.settled) settled++
        else skipped++
      } catch (error) {
        skipped++
        console.error(
          `[SETTLEMENT-RECOVERY-SKIP] Reference=${candidate.refId}: ${error.message}`
        )
      }
    }
    return { scanned: stranded.length, settled, skipped }
  }

  _gatewayTestRecoveryError (message, code, statusCode = 409) {
    const error = new Error(message)
    error.code = code
    error.statusCode = statusCode
    return error
  }

  async _loadGatewayTestRecoveryTransaction (reference, session = null) {
    let query = TransactionStatus.findOne({ refId: reference })
    if (typeof query?.select === 'function') {
      query = query.select(
        '+gatewayConfigSnapshot +administrativeValidationLeaseToken +eligibilityVerificationLeaseToken +eligibilityVerificationLeaseExpiresAt +eligibilityRecoveryOriginalEvidence'
      )
    }
    if (session && typeof query?.session === 'function') query = query.session(session)
    return query
  }

  async _loadGatewayTestRecoveryGateway (gatewayId, session = null) {
    let query = PaymentGateway.findById(gatewayId)
    if (typeof query?.select === 'function') {
      query = query.select(
        '+virtualAccountMutationVersion +virtualAccountClaimVersion'
      )
    }
    if (session && typeof query?.session === 'function') query = query.session(session)
    return query
  }

  _assertGatewayTestRecoveryContext ({
    transaction,
    gateway,
    reference,
    at = new Date(),
    recovered = false
  }) {
    const invalid = (message, code = 'MONNIFY_GATEWAY_TEST_RECOVERY_CONTEXT_INVALID') => {
      throw this._gatewayTestRecoveryError(message, code, 409)
    }
    if (!transaction) invalid('The gateway-test transaction was not found.', 'MONNIFY_GATEWAY_TEST_RECOVERY_NOT_FOUND')
    if (!gateway) invalid('The payment gateway was not found.', 'MONNIFY_GATEWAY_TEST_RECOVERY_GATEWAY_NOT_FOUND')

    const metadata = plainMetadata(gateway)
    const checkout = metadata.checkoutValidation
    const snapshot = transaction.gatewayConfigSnapshot
    const snapshotMetadata = plainMetadata(snapshot)
    const version = configurationVersion(gateway)
    const gatewayId = String(gateway._id || '')
    const expectedReference = String(reference || '')
    const expectedAmountKobo = transaction.amountKobo
    const recoveringInitialization = Boolean(
      checkout?.status === 'initializing' &&
      !checkout.reference &&
      checkout.leaseToken &&
      transaction.administrativeValidationLeaseToken === checkout.leaseToken
    )
    let merchantSecretMatches = false
    try {
      const snapshotSecret = decryptSecretStrict(snapshot?.secretKey)
      const currentSecret = decryptSecretStrict(gateway?.secretKey)
      const snapshotSecretBuffer = Buffer.from(snapshotSecret)
      const currentSecretBuffer = Buffer.from(currentSecret)
      merchantSecretMatches =
        snapshotSecretBuffer.length === currentSecretBuffer.length &&
        crypto.timingSafeEqual(snapshotSecretBuffer, currentSecretBuffer)
    } catch (_) {}

    if (
      transaction.refId !== expectedReference ||
      transaction.type !== 'gateway_test' ||
      !transaction.userId ||
      String(transaction.provider || '').toLowerCase() !== 'monnify' ||
      String(transaction.gatewayId || '') !== gatewayId ||
      !Number.isSafeInteger(expectedAmountKobo) ||
      expectedAmountKobo <= 0 ||
      String(transaction.expectedCurrency || '').trim().toUpperCase() !== 'NGN'
    ) {
      invalid('The transaction is not the exact recoverable Monnify gateway-test payment.')
    }
    if (!transaction.reconciliationReason) {
      invalid('The transaction has no retained manual-review evidence.')
    }
    if (
      !isCanonicalMonnify(gateway) ||
      gateway.environment !== 'test' ||
      gateway.baseUrl !== MONNIFY_BASE_URLS.test ||
      !Number.isSafeInteger(version) ||
      version < 0
    ) {
      invalid('Recovery requires the canonical TEST Monnify gateway configuration.')
    }
    if (
      !snapshot ||
      String(snapshot.gatewayId || '') !== gatewayId ||
      String(snapshot.code || '').toLowerCase() !== 'monnify' ||
      String(snapshot.adapterType || '').toLowerCase() !== 'monnify' ||
      snapshot.environment !== 'test' ||
      snapshot.baseUrl !== MONNIFY_BASE_URLS.test ||
      Number(snapshot.configurationVersion) !== version ||
      !String(snapshot.publicKey || '').trim() ||
      !snapshot.secretKey ||
      !isEncrypted(snapshot.secretKey) ||
      !gateway.secretKey ||
      !isEncrypted(gateway.secretKey) ||
      String(snapshot.publicKey) !== String(gateway.publicKey || '') ||
      !merchantSecretMatches ||
      !String(snapshotMetadata.contractCode || '').trim() ||
      String(snapshotMetadata.contractCode) !== String(metadata.contractCode || '')
    ) {
      invalid('The pinned encrypted Monnify snapshot is missing or no longer matches the original merchant configuration.', 'MONNIFY_GATEWAY_TEST_RECOVERY_SNAPSHOT_INVALID')
    }

    const checkoutMatches = Boolean(
      checkout &&
      (checkout.reference === expectedReference || recoveringInitialization) &&
      String(checkout.gatewayId || '') === gatewayId &&
      checkout.environment === 'test' &&
      Number(checkout.configurationVersion) === version &&
      checkout.amountKobo === expectedAmountKobo &&
      String(checkout.currency || '').trim().toUpperCase() === 'NGN'
    )
    if (!checkoutMatches) {
      invalid('The original eligibility checkout context no longer matches this transaction.', 'MONNIFY_GATEWAY_TEST_RECOVERY_CHECKOUT_INVALID')
    }

    if (recovered) {
      const retainedContext =
        (metadata.administrativeSandboxOnly === true &&
          ['initializing', 'initialized', 'ambiguous', 'verified'].includes(checkout.status)) ||
        (checkout.status === 'verified' && hasExactMonnifyEligibility(gateway))
      if (!retainedContext) {
        invalid('The recovered eligibility context no longer belongs to this gateway.')
      }
    } else {
      const expiresAt = new Date(checkout.expiresAt)
      if (
        gateway.status !== 'inactive' ||
        gateway.isDefault ||
        metadata.administrativeSandboxOnly !== true ||
        !['initializing', 'initialized', 'ambiguous'].includes(checkout.status) ||
        !expiresAt.getTime() ||
        expiresAt <= at
      ) {
        invalid('The original TEST eligibility context is inactive, expired, or no longer isolated.', 'MONNIFY_GATEWAY_TEST_RECOVERY_CHECKOUT_EXPIRED')
      }
    }

    return { metadata, checkout, snapshot, version, recoveringInitialization }
  }

  async _releaseGatewayTestRecoveryLease (reference, token) {
    if (!reference || !token) return
    await TransactionStatus.updateOne(
      {
        refId: reference,
        status: 'reconciliation_required',
        type: 'gateway_test',
        eligibilityVerificationLeaseToken: token
      },
      {
        $unset: {
          eligibilityVerificationLeaseToken: 1,
          eligibilityVerificationLeaseExpiresAt: 1
        }
      }
    )
  }

  async _alreadyRecoveredGatewayTest ({ transaction, gateway, reference }) {
    if (
      transaction?.status !== 'success' ||
      !(transaction.eligibilityRecoveredAt instanceof Date)
    ) {
      throw this._gatewayTestRecoveryError(
        `Reference '${reference}' is not eligible for gateway-test recovery.`,
        'MONNIFY_GATEWAY_TEST_RECOVERY_STATUS_INVALID',
        409
      )
    }
    this._assertGatewayTestRecoveryContext({
      transaction,
      gateway,
      reference,
      recovered: true
    })
    const evidence = this._assertPersistedSettlementEvidence(transaction)
    if (
      String(transaction.providerPaymentStatus || '').toUpperCase() !== 'PAID' ||
      !(transaction.providerVerifiedAt instanceof Date)
    ) {
      throw this._gatewayTestRecoveryError(
        'The recovered transaction is missing authoritative PAID verification evidence.',
        'MONNIFY_GATEWAY_TEST_RECOVERY_EVIDENCE_INVALID',
        409
      )
    }
    await this._assertProviderTransactionOwner({
      provider: evidence.provider,
      providerTransactionId: evidence.confirmedProviderRef,
      refId: reference
    })
    return {
      success: true,
      status: 'success',
      reference,
      recovered: true,
      alreadyRecovered: true,
      credited: false,
      nextAction: 'check_eligibility'
    }
  }

  _assertGatewayTestRecoveryProviderIdentity (transaction, evidence) {
    const retainedProvider = String(
      transaction?.confirmedProvider || ''
    ).trim().toLowerCase()
    const retainedProviderRef = String(
      transaction?.confirmedProviderRef || ''
    ).trim()
    if (
      (retainedProvider && retainedProvider !== evidence.confirmedProvider) ||
      (retainedProviderRef && retainedProviderRef !== evidence.confirmedProviderRef)
    ) {
      throw this._gatewayTestRecoveryError(
        'Fresh Monnify evidence does not match the provider identity retained for manual review.',
        'MONNIFY_GATEWAY_TEST_RECOVERY_EVIDENCE_MISMATCH',
        422
      )
    }
  }

  async recoverGatewayTestReconciliation ({
    gatewayId,
    reference,
    adminId,
    operatorName = 'SuperAdmin',
    note = '',
    ipAddress,
    userAgent
  }) {
    if (!gatewayId || !reference || !adminId) {
      throw this._gatewayTestRecoveryError(
        'Gateway, reference, and SuperAdmin identity are required.',
        'MONNIFY_GATEWAY_TEST_RECOVERY_REQUEST_INVALID',
        400
      )
    }

    let transaction = await this._loadGatewayTestRecoveryTransaction(reference)
    let gateway = await this._loadGatewayTestRecoveryGateway(gatewayId)
    if (
      transaction &&
      String(transaction.userId || '') !== String(adminId)
    ) {
      throw this._gatewayTestRecoveryError(
        'Only the SuperAdmin who initialized this gateway-test payment can recover it.',
        'MONNIFY_GATEWAY_TEST_RECOVERY_OWNER_MISMATCH',
        403
      )
    }
    if (transaction?.status === 'success') {
      return this._alreadyRecoveredGatewayTest({ transaction, gateway, reference })
    }
    if (transaction?.status !== 'reconciliation_required') {
      throw this._gatewayTestRecoveryError(
        `Reference '${reference}' is not under gateway-test manual review.`,
        'MONNIFY_GATEWAY_TEST_RECOVERY_STATUS_INVALID',
        409
      )
    }
    this._assertGatewayTestRecoveryContext({ transaction, gateway, reference })

    const claimedAt = new Date()
    const leaseToken = crypto.randomBytes(32).toString('hex')
    const leaseExpiresAt = new Date(
      claimedAt.getTime() + ELIGIBILITY_VERIFICATION_LEASE_MS
    )
    let claimQuery = TransactionStatus.findOneAndUpdate(
      {
        _id: transaction._id,
        refId: reference,
        status: 'reconciliation_required',
        type: 'gateway_test',
        provider: 'monnify',
        gatewayId: transaction.gatewayId,
        $or: [
          { eligibilityVerificationLeaseExpiresAt: { $lte: claimedAt } },
          {
            eligibilityVerificationLeaseToken: { $exists: false },
            eligibilityVerificationLeaseExpiresAt: { $exists: false }
          }
        ]
      },
      {
        $set: {
          eligibilityVerificationLeaseToken: leaseToken,
          eligibilityVerificationLeaseExpiresAt: leaseExpiresAt
        }
      },
      { new: true }
    )
    if (typeof claimQuery?.select === 'function') {
      claimQuery = claimQuery.select(
        '+gatewayConfigSnapshot +administrativeValidationLeaseToken +eligibilityVerificationLeaseToken +eligibilityVerificationLeaseExpiresAt +eligibilityRecoveryOriginalEvidence'
      )
    }
    transaction = await claimQuery
    if (!transaction) {
      const latest = await this._loadGatewayTestRecoveryTransaction(reference)
      if (latest?.status === 'success') {
        gateway = await this._loadGatewayTestRecoveryGateway(gatewayId)
        return this._alreadyRecoveredGatewayTest({ transaction: latest, gateway, reference })
      }
      const latestExpiry = new Date(latest?.eligibilityVerificationLeaseExpiresAt || 0)
      if (
        latest?.status === 'reconciliation_required' &&
        latest?.eligibilityVerificationLeaseToken &&
        latestExpiry.getTime() > claimedAt.getTime()
      ) {
        return {
          success: false,
          status: 'processing',
          reference,
          recovered: false,
          credited: false,
          retryAllowed: true,
          message: 'This gateway-test recovery is already in progress.'
        }
      }
      throw this._gatewayTestRecoveryError(
        'The recovery lease is unavailable or malformed. Refresh before retrying.',
        'MONNIFY_GATEWAY_TEST_RECOVERY_LEASE_CONFLICT',
        409
      )
    }

    let committed = false
    let session = null
    let evidence = null
    try {
      const context = this._assertGatewayTestRecoveryContext({ transaction, gateway, reference })
      const hydratedSnapshot = this._hydrateGatewayCredentials(context.snapshot)
      if (
        !hydratedSnapshot?.publicKey ||
        !hydratedSnapshot?.secretKey ||
        isEncrypted(hydratedSnapshot.secretKey) ||
        !String(hydratedSnapshot.metadata?.contractCode || '').trim()
      ) {
        throw this._gatewayTestRecoveryError(
          'The pinned Monnify snapshot cannot be authenticated.',
          'MONNIFY_GATEWAY_TEST_RECOVERY_SNAPSHOT_UNREADABLE',
          409
        )
      }

      const adapter = this.getAdapterInstance(hydratedSnapshot)
      const verification = await adapter.verifyPayment(reference)
      const providerStatus = String(verification?.providerStatus || '').trim().toUpperCase()
      if (
        verification?.success !== true ||
        verification?.status !== 'success' ||
        providerStatus !== 'PAID'
      ) {
        const error = this._gatewayTestRecoveryError(
          'Monnify did not authoritatively confirm this transaction as PAID.',
          'MONNIFY_GATEWAY_TEST_RECOVERY_NOT_PAID',
          422
        )
        if (providerStatus) error.providerStatus = providerStatus
        throw error
      }

      try {
        evidence = this._validatedGatewayEvidence(transaction, {
          ...verification,
          gateway: 'monnify'
        })
      } catch (_) {
        throw this._gatewayTestRecoveryError(
          'Fresh Monnify evidence does not match the original reference, amount, currency, or provider identity.',
          'MONNIFY_GATEWAY_TEST_RECOVERY_EVIDENCE_MISMATCH',
          422
        )
      }
      this._assertGatewayTestRecoveryProviderIdentity(transaction, evidence)
      await this._assertProviderTransactionOwner({
        provider: evidence.confirmedProvider,
        providerTransactionId: evidence.confirmedProviderRef,
        refId: reference
      })

      session = await mongoose.startSession()
      session.startTransaction()
      const finalAt = new Date()
      const lockedTransaction = await this._loadGatewayTestRecoveryTransaction(reference, session)
      const lockedGateway = await this._loadGatewayTestRecoveryGateway(gatewayId, session)
      const lockedContext = this._assertGatewayTestRecoveryContext({
        transaction: lockedTransaction,
        gateway: lockedGateway,
        reference,
        at: finalAt
      })
      const lockedLeaseExpiry = new Date(
        lockedTransaction.eligibilityVerificationLeaseExpiresAt || 0
      )
      if (
        String(lockedTransaction.userId || '') !== String(adminId) ||
        lockedTransaction.eligibilityVerificationLeaseToken !== leaseToken ||
        !lockedLeaseExpiry.getTime() ||
        lockedLeaseExpiry <= finalAt
      ) {
        throw this._gatewayTestRecoveryError(
          'Recovery lease ownership was lost before verification completed.',
          'MONNIFY_GATEWAY_TEST_RECOVERY_LEASE_LOST',
          409
        )
      }

      evidence = this._validatedGatewayEvidence(lockedTransaction, {
        ...verification,
        gateway: 'monnify'
      })
      this._assertGatewayTestRecoveryProviderIdentity(lockedTransaction, evidence)
      await this._assertProviderTransactionOwner({
        provider: evidence.confirmedProvider,
        providerTransactionId: evidence.confirmedProviderRef,
        refId: reference,
        session
      })

      const versionClause = lockedContext.version === 0
        ? {
            $or: [
              { virtualAccountMutationVersion: 0 },
              { virtualAccountMutationVersion: { $exists: false } }
            ]
          }
        : { virtualAccountMutationVersion: lockedContext.version }
      const gatewayFence = await PaymentGateway.updateOne(
        {
          _id: lockedGateway._id,
          code: 'monnify',
          adapterType: 'monnify',
          status: 'inactive',
          isDefault: false,
          environment: 'test',
          baseUrl: MONNIFY_BASE_URLS.test,
          publicKey: lockedContext.snapshot.publicKey,
          secretKey: lockedGateway.secretKey,
          'metadata.contractCode': lockedContext.snapshot.metadata.contractCode,
          'metadata.administrativeSandboxOnly': true,
          'metadata.checkoutValidation.status': lockedContext.checkout.status,
          ...(lockedContext.recoveringInitialization
            ? {
                'metadata.checkoutValidation.leaseToken': lockedContext.checkout.leaseToken,
                'metadata.checkoutValidation.reference': { $exists: false }
              }
            : { 'metadata.checkoutValidation.reference': reference }),
          'metadata.checkoutValidation.gatewayId': String(lockedGateway._id),
          'metadata.checkoutValidation.environment': 'test',
          'metadata.checkoutValidation.configurationVersion': lockedContext.version,
          'metadata.checkoutValidation.amountKobo': lockedTransaction.amountKobo,
          'metadata.checkoutValidation.currency': 'NGN',
          'metadata.checkoutValidation.expiresAt': { $gt: finalAt },
          ...versionClause
        },
        { $inc: { virtualAccountClaimVersion: 1 } },
        { session }
      )
      if (Number(gatewayFence?.matchedCount ?? gatewayFence?.n ?? 0) !== 1) {
        throw this._gatewayTestRecoveryError(
          'The Monnify gateway or checkout context changed during recovery.',
          'MONNIFY_GATEWAY_TEST_RECOVERY_CONFIGURATION_CONFLICT',
          409
        )
      }

      const recovered = await TransactionStatus.updateOne(
        {
          _id: lockedTransaction._id,
          refId: reference,
          status: 'reconciliation_required',
          type: 'gateway_test',
          provider: 'monnify',
          gatewayId: lockedTransaction.gatewayId,
          userId: lockedTransaction.userId,
          eligibilityVerificationLeaseToken: leaseToken,
          eligibilityVerificationLeaseExpiresAt: { $gt: finalAt }
        },
        {
          $set: {
            status: 'success',
            eligibilityRecoveryOriginalEvidence: {
              confirmedAmountKobo: lockedTransaction.confirmedAmountKobo ?? null,
              confirmedCurrency: lockedTransaction.confirmedCurrency ?? null,
              confirmedProvider: lockedTransaction.confirmedProvider ?? null,
              confirmedReference: lockedTransaction.confirmedReference ?? null,
              confirmedProviderRef: lockedTransaction.confirmedProviderRef ?? null,
              providerPaymentStatus: lockedTransaction.providerPaymentStatus ?? null,
              providerVerifiedAt: lockedTransaction.providerVerifiedAt ?? null,
              reconciliationReason: lockedTransaction.reconciliationReason,
              capturedAt: finalAt
            },
            ...evidence,
            providerPaymentStatus: 'PAID',
            providerVerifiedAt: finalAt,
            eligibilityRecoveredAt: finalAt,
            lastAttempt: finalAt
          },
          $unset: {
            eligibilityVerificationLeaseToken: 1,
            eligibilityVerificationLeaseExpiresAt: 1,
            settlementClaimToken: 1,
            settlementLeaseExpiresAt: 1
          }
        },
        { session }
      )
      if (Number(recovered?.matchedCount ?? recovered?.n ?? 0) !== 1) {
        throw this._gatewayTestRecoveryError(
          'The gateway-test transaction changed before recovery completed.',
          'MONNIFY_GATEWAY_TEST_RECOVERY_TRANSACTION_CONFLICT',
          409
        )
      }

      const providerTransactionIdHash = crypto
        .createHash('sha256')
        .update(evidence.confirmedProviderRef)
        .digest('hex')
        .slice(0, 16)
      await AuditLog.create([{
        adminId,
        operatorName,
        action: 'MONNIFY_GATEWAY_TEST_RECOVERED',
        target: `Gateway: ${lockedGateway.name}`,
        details: {
          gatewayId: lockedGateway._id,
          reference,
          environment: 'test',
          configurationVersion: lockedContext.version,
          amountKobo: evidence.confirmedAmountKobo,
          currency: evidence.confirmedCurrency,
          providerStatus: 'PAID',
          providerTransactionIdHash,
          previousReconciliationReason: lockedTransaction.reconciliationReason,
          note: String(note || '').trim().slice(0, 500),
          walletCredited: false,
          gatewayActivated: false,
          defaultGatewayChanged: false
        },
        result: 'success',
        ipAddress,
        userAgent
      }], { session })

      await session.commitTransaction()
      committed = true
      return {
        success: true,
        status: 'success',
        reference,
        recovered: true,
        alreadyRecovered: false,
        credited: false,
        nextAction: 'check_eligibility'
      }
    } catch (error) {
      if (session && !committed) {
        try {
          await session.abortTransaction()
        } catch (_) {}
      }
      if (error?.code === 11000 && evidence) {
        await this._assertProviderTransactionOwner({
          provider: evidence.confirmedProvider,
          providerTransactionId: evidence.confirmedProviderRef,
          refId: reference
        })
      }
      throw error
    } finally {
      if (session) await session.endSession()
      if (!committed) {
        await this._releaseGatewayTestRecoveryLease(reference, leaseToken)
      }
    }
  }



  // ─────────────────────────────────────────────────────────
  // CLIENT VERIFICATION
  // ─────────────────────────────────────────────────────────

  async _claimGatewayTestVerificationLease (transaction) {
    if (transaction?.type !== 'gateway_test' || transaction.status !== 'pending') {
      return null
    }
    const claimedAt = new Date()
    const token = crypto.randomBytes(32).toString('hex')
    let query = TransactionStatus.findOneAndUpdate(
      {
        ...(transaction._id
          ? { _id: transaction._id }
          : { refId: transaction.refId }),
        refId: transaction.refId,
        status: 'pending',
        type: 'gateway_test',
        provider: transaction.provider,
        gatewayId: transaction.gatewayId,
        $or: [
          { eligibilityVerificationLeaseExpiresAt: { $lte: claimedAt } },
          { eligibilityVerificationLeaseExpiresAt: { $exists: false } },
          { eligibilityVerificationLeaseToken: { $exists: false } }
        ]
      },
      {
        $set: {
          eligibilityVerificationLeaseToken: token,
          eligibilityVerificationLeaseExpiresAt: new Date(
            claimedAt.getTime() + ELIGIBILITY_VERIFICATION_LEASE_MS
          )
        }
      },
      { new: true }
    )
    if (typeof query?.select === 'function') {
      query = query.select(
        '+gatewayConfigSnapshot +eligibilityVerificationLeaseToken +eligibilityVerificationLeaseExpiresAt'
      )
    }
    const claimedTransaction = await query
    return claimedTransaction
      ? { transaction: claimedTransaction, token }
      : null
  }

  async _releaseGatewayTestVerificationLease (reference, token) {
    if (!reference || !token) return
    await TransactionStatus.updateOne(
      {
        refId: reference,
        status: 'pending',
        type: 'gateway_test',
        eligibilityVerificationLeaseToken: token
      },
      {
        $unset: {
          eligibilityVerificationLeaseToken: 1,
          eligibilityVerificationLeaseExpiresAt: 1
        }
      }
    )
  }

  /**
   * Verifies payment via transaction reference (used by client return redirect and manual requery).
   */
  async verifyFunding (reference, { verificationLeaseToken = null } = {}) {
    if (!reference) {
      return { status: 'not_found', message: 'Reference is required' }
    }

    const transactionQuery = TransactionStatus.findOne({ refId: reference })
    let transaction =
      typeof transactionQuery?.select === 'function'
        ? await transactionQuery.select(
          '+gatewayConfigSnapshot +eligibilityVerificationLeaseToken +eligibilityVerificationLeaseExpiresAt'
        )
        : await transactionQuery
    if (!transaction) {
      return { status: 'not_found', message: 'Transaction record not found' }
    }
    this._assertSettlementEnvironment(transaction)
    if (transaction.type === 'gateway_test' && transaction.status === 'pending') {
      if (verificationLeaseToken) {
        const leaseExpiry = new Date(
          transaction.eligibilityVerificationLeaseExpiresAt || 0
        )
        if (
          transaction.eligibilityVerificationLeaseToken !==
            verificationLeaseToken ||
          !leaseExpiry.getTime() ||
          leaseExpiry <= new Date()
        ) {
          return {
            status: 'processing',
            type: transaction.type,
            reference,
            message: 'This validation payment is already being verified.'
          }
        }
      } else {
        const claim = await this._claimGatewayTestVerificationLease(transaction)
        if (!claim) {
          return {
            status: 'processing',
            type: transaction.type,
            reference,
            message: 'This validation payment is already being verified.'
          }
        }
        transaction = claim.transaction
        verificationLeaseToken = claim.token
      }
    }
    const releaseVerificationLease = async () => {
      if (!verificationLeaseToken || transaction.type !== 'gateway_test') return
      await this._releaseGatewayTestVerificationLease(
        reference,
        verificationLeaseToken
      )
    }

    // If already in a terminal or intermediate state, report without re-verifying
    if (transaction.status === 'success') {
      return { status: 'success', type: transaction.type, reference }
    }

    if (transaction.status === 'failed') {
      return {
        status: 'failed',
        type: transaction.type,
        reference,
        ...(transaction.providerPaymentStatus
          ? { providerStatus: transaction.providerPaymentStatus }
          : {})
      }
    }

    if (transaction.status === 'reconciliation_required') {
      return {
        status: 'reconciliation_required',
        type: transaction.type,
        reference,
        message: 'This transaction requires manual review by our support team.'
      }
    }

    if (transaction.status === 'processing') {
      // Already claimed by concurrent process — safe to tell client it is finalizing
      return {
        status: 'processing',
        type: transaction.type,
        reference,
        message: 'Your payment is being finalized. Please wait a moment.'
      }
    }

    // Resolve the specific gateway bound to this transaction (never trust frontend)
    const gatewayCode = transaction.provider || 'paystack'
    const gateway = transaction.gatewayConfigSnapshot
      ? this._hydrateGatewayCredentials(transaction.gatewayConfigSnapshot)
      : await this.getGateway(gatewayCode)

    if (!gateway) {
      await releaseVerificationLease()
      return {
        status: 'pending',
        message: `Gateway '${gatewayCode}' configuration not available for verification`
      }
    }

    let finalResult
    try {
      const adapter = this.getAdapterInstance(gateway)
      const verifyResult = await adapter.verifyPayment(reference)

      finalResult = await this.finalizeFundingCredit({
        transactionStatus: transaction,
        gatewayPaymentResult: {
          ...verifyResult,
          gateway: gateway.code
        },
        source: 'client_verify',
        verificationLeaseToken
      })
      if (!['success', 'failed'].includes(finalResult.status)) {
        await releaseVerificationLease()
      }
    } catch (error) {
      await releaseVerificationLease()
      throw error
    }

    return {
      status: finalResult.status,
      type: transaction.type,
      reference,
      amount: finalResult.amount,
      ...(finalResult.deferred !== undefined
        ? { deferred: finalResult.deferred }
        : {}),
      ...(finalResult.message ? { message: finalResult.message } : {}),
      ...(finalResult.providerStatus
        ? { providerStatus: finalResult.providerStatus }
        : {})
    }
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
  async _claimWebhookEvent ({ providerCode, normalized, payload }) {
    const identity = { provider: providerCode, eventId: normalized.eventId }
    const now = new Date()
    const processingExpiresAt = new Date(
      now.getTime() + WEBHOOK_PROCESSING_LEASE_MS
    )
    const processingToken = crypto.randomBytes(32).toString('hex')

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
      })
      return { webhookEvent, identity }
    } catch (dbErr) {
      if (dbErr.code !== 11000) throw dbErr

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
      )

      if (webhookEvent) {
        console.log(
          `[Webhook Retry] eventId=${normalized.eventId} for ${providerCode} claimed for reprocessing.`
        )
        return { webhookEvent, identity, retried: true }
      }

      const existing = await WebhookEvent.findOne(identity)
      if (existing && ['processed', 'failed'].includes(existing.status)) {
        console.log(
          `[Webhook Idempotency] eventId=${normalized.eventId} for ${providerCode} is terminal (${existing.status}). Duplicate ignored.`
        )
        return {
          response: { status: 200, message: 'Event already processed' },
          identity
        }
      }

      // 503 follows the application's existing temporary-unavailability
      // convention and asks the provider to redeliver after the active lease.
      return {
        response: {
          status: 503,
          message: 'Webhook event is currently processing; retry later'
        },
        identity
      }
    }
  }

  async _setWebhookEventState (webhookEvent, status, errorMessage = null) {
    if (!webhookEvent || !webhookEvent.processingToken) return false
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
    )
    return !!result
  }

  _parseWebhookPayload (body) {
    if (!Buffer.isBuffer(body)) return body
    return JSON.parse(body.toString('utf8'))
  }

  _extractWebhookReference (providerCode, payload) {
    const code = String(providerCode || '').toLowerCase()
    const candidate =
      code === 'paystack'
        ? payload?.data?.reference
        : code === 'flutterwave'
        ? payload?.data?.tx_ref
        : code === 'monnify'
        ? payload?.eventData?.paymentReference ||
          payload?.eventData?.transactionReference
        : null
    const value = String(candidate || '')
    const prefix = code.toUpperCase()
    return new RegExp(
      `^${prefix}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$`
    ).test(value)
      ? value
      : null
  }

  _extractVirtualAccountReference (providerCode, payload) {
    if (String(providerCode || '').toLowerCase() !== 'monnify') return null
    const data = payload?.eventData || {}
    const product = data.product || {}
    const productReference = String(product.type || '').toUpperCase() === 'RESERVED_ACCOUNT'
      ? product.reference
      : ''
    const value = String(
      productReference || data.accountReference || data.destinationAccountReference || ''
    )
    return /^VIRTUAL_[a-f\d]{24}$/i.test(value) ? value : null
  }

  _paystackDvaWebhookError (message, code) {
    const error = new Error(message)
    error.code = code
    error.webhookTerminal = true
    return error
  }

  _assertPaystackDvaTransactionIdentity (
    transaction,
    { owner, gateway, reference, amountKobo, currency, providerTransactionId }
  ) {
    const channels = Array.isArray(transaction?.channels)
      ? transaction.channels
      : []
    if (
      !transaction ||
      String(transaction.userId || '') !== String(owner.userId) ||
      transaction.type !== 'funding' ||
      String(transaction.provider || '').toLowerCase() !== 'paystack' ||
      String(transaction.gatewayId || '') !== String(gateway._id) ||
      String(transaction.refId || '') !== reference ||
      transaction.amountKobo !== amountKobo ||
      String(transaction.expectedCurrency || '').toUpperCase() !== currency ||
      !channels.includes('virtual_account') ||
      (transaction.providerRef &&
        String(transaction.providerRef) !== providerTransactionId)
    ) {
      throw this._paystackDvaWebhookError(
        'Existing transaction does not match the verified Paystack DVA deposit',
        'PAYSTACK_DVA_DEPOSIT_TRANSACTION_MISMATCH'
      )
    }
  }

  _assertMonnifyVirtualAccountTransactionIdentity (
    transaction,
    { owner, gateway, reference, amountKobo, currency, providerTransactionId }
  ) {
    const channels = Array.isArray(transaction?.channels)
      ? transaction.channels
      : []
    if (
      !transaction ||
      String(transaction.userId || '') !== String(owner.userId) ||
      transaction.type !== 'funding' ||
      String(transaction.provider || '').toLowerCase() !== 'monnify' ||
      String(transaction.gatewayId || '') !== String(gateway._id) ||
      String(transaction.refId || '') !== reference ||
      transaction.amountKobo !== amountKobo ||
      String(transaction.expectedCurrency || '').toUpperCase() !== currency ||
      !channels.includes('virtual_account') ||
      (transaction.providerRef && String(transaction.providerRef) !== providerTransactionId)
    ) {
      const error = new Error('Existing transaction does not match the verified Monnify reserved-account deposit')
      error.code = 'MONNIFY_VIRTUAL_ACCOUNT_TRANSACTION_MISMATCH'
      error.webhookTerminal = true
      throw error
    }
  }

  async _processPaystackDvaDeposit ({
    gateway,
    adapter,
    normalized,
    webhookEvent
  }) {
    try {
      const webhookDva = normalized.dedicatedNuban || {}
      const reference = String(normalized.raw?.reference || '')
      const providerTransactionId = String(
        normalized.providerTransactionId || ''
      )
      const amountKobo = normalized.amountKobo
      const currency = String(normalized.currency || '').toUpperCase()
      if (
        normalized.eventType !== 'charge.success' ||
        normalized.status !== 'success' ||
        !webhookDva.isDedicatedNuban ||
        normalized.reference !== reference ||
        !reference ||
        reference.length > 200 ||
        !/^\d+$/.test(providerTransactionId) ||
        normalized.eventId !== providerTransactionId ||
        !Number.isSafeInteger(amountKobo) ||
        amountKobo <= 0 ||
        currency !== 'NGN' ||
        !/^\d{10}$/.test(webhookDva.receiverAccountNumber || '') ||
        !/^\d+$/.test(webhookDva.providerCustomerId || '') ||
        !/^CUS_[A-Za-z0-9]+$/.test(webhookDva.providerCustomerCode || '')
      ) {
        throw this._paystackDvaWebhookError(
          'Paystack dedicated-NUBAN webhook evidence is incomplete',
          'PAYSTACK_DVA_DEPOSIT_MALFORMED'
        )
      }

      let serverVerify
      try {
        serverVerify = await adapter.verifyPayment(reference)
      } catch (error) {
        serverVerify = {
          success: false,
          status: 'pending',
          reference,
          message: `Provider verification unavailable: ${error.message}`
        }
      }
      if (serverVerify.status === 'failed') {
        await this._setWebhookEventState(
          webhookEvent,
          'failed',
          `Secondary verification confirmed failure: ${serverVerify.message}`
        )
        return {
          status: 200,
          message: 'Secondary verification confirmed DVA deposit failure'
        }
      }
      if (serverVerify.status !== 'success') {
        await this._setWebhookEventState(
          webhookEvent,
          'retryable',
          `Secondary verification inconclusive: ${serverVerify.message}`
        )
        return {
          status: 503,
          message: 'Secondary verification inconclusive; retry later'
        }
      }

      const verifiedDva = serverVerify.dedicatedNuban || {}
      const verifiedAmountKobo = serverVerify.amountKobo
      const verifiedCurrency = String(serverVerify.currency || '').toUpperCase()
      if (
        !verifiedDva.isDedicatedNuban ||
        serverVerify.reference !== reference ||
        String(serverVerify.providerTransactionId || '') !==
          providerTransactionId ||
        !Number.isSafeInteger(verifiedAmountKobo) ||
        verifiedAmountKobo !== amountKobo ||
        verifiedCurrency !== currency ||
        verifiedDva.receiverAccountNumber !==
          webhookDva.receiverAccountNumber ||
        verifiedDva.providerCustomerId !== webhookDva.providerCustomerId ||
        verifiedDva.providerCustomerCode !== webhookDva.providerCustomerCode
      ) {
        throw this._paystackDvaWebhookError(
          'Paystack webhook and server verification DVA evidence do not match',
          'PAYSTACK_DVA_DEPOSIT_EVIDENCE_MISMATCH'
        )
      }

      const virtualAccountService = require('./virtualAccount.service')
      const owner = await virtualAccountService.resolvePaystackDepositOwner({
        gateway,
        accountNumber: verifiedDva.receiverAccountNumber,
        providerCustomerId: verifiedDva.providerCustomerId,
        providerCustomerCode: verifiedDva.providerCustomerCode
      })
      if (owner.gatewaySnapshot) {
        const snapshotAdapter = String(
          owner.gatewaySnapshot.adapterType || owner.gatewaySnapshot.code || ''
        ).toLowerCase()
        const snapshotGatewayId = String(owner.gatewaySnapshot.gatewayId || '')
        const snapshotCode = String(
          owner.gatewaySnapshot.code || ''
        ).toLowerCase()
        if (
          snapshotAdapter !== 'paystack' ||
          (snapshotGatewayId && snapshotGatewayId !== String(gateway._id)) ||
          (snapshotCode &&
            snapshotCode !== String(gateway.code || '').toLowerCase())
        ) {
          throw this._paystackDvaWebhookError(
            'Stored DVA gateway snapshot does not belong to Paystack',
            'PAYSTACK_DVA_DEPOSIT_GATEWAY_MISMATCH'
          )
        }
      }

      const transactionQuery = TransactionStatus.findOne({ refId: reference })
      let transaction =
        typeof transactionQuery?.select === 'function'
          ? await transactionQuery.select('+gatewayConfigSnapshot')
          : await transactionQuery
      if (!transaction) {
        try {
          transaction = await TransactionStatus.create({
            refId: reference,
            userId: owner.userId,
            type: 'funding',
            status: 'pending',
            amountKobo: verifiedAmountKobo,
            expectedCurrency: verifiedCurrency,
            channels: ['virtual_account'],
            provider: 'paystack',
            gatewayId: String(gateway._id),
            service: gateway.name,
            providerRef: providerTransactionId,
            gatewayConfigSnapshot:
              owner.gatewaySnapshot || this._snapshotGatewayConfig(gateway)
          })
        } catch (error) {
          if (error?.code !== 11000) throw error
          const concurrentQuery = TransactionStatus.findOne({
            refId: reference
          })
          transaction =
            typeof concurrentQuery?.select === 'function'
              ? await concurrentQuery.select('+gatewayConfigSnapshot')
              : await concurrentQuery
          if (!transaction) throw error
        }
      }

      this._assertPaystackDvaTransactionIdentity(transaction, {
        owner,
        gateway,
        reference,
        amountKobo: verifiedAmountKobo,
        currency: verifiedCurrency,
        providerTransactionId
      })
      const finalResult = await this.finalizeFundingCredit({
        transactionStatus: transaction,
        gatewayPaymentResult: { ...serverVerify, gateway: 'paystack' },
        source: 'webhook'
      })
      if (finalResult.status !== 'success') {
        await this._setWebhookEventState(
          webhookEvent,
          'retryable',
          `DVA deposit settlement remains ${finalResult.status}`
        )
        return {
          status: 503,
          message: 'DVA deposit settlement is still processing; retry later'
        }
      }

      await this._setWebhookEventState(webhookEvent, 'processed')
      return {
        status: 200,
        message: 'Paystack DVA deposit settled successfully'
      }
    } catch (error) {
      const terminal =
        error.webhookTerminal === true ||
        [
          'PAYMENT_GATEWAY_MISMATCH',
          'PAYMENT_REFERENCE_MISMATCH',
          'PAYMENT_CURRENCY_MISMATCH',
          'PAYMENT_AMOUNT_MISMATCH',
          'PAYMENT_PROVIDER_TRANSACTION_REUSED',
          'PAYMENT_EVIDENCE_INVALID',
          'SETTLEMENT_EVIDENCE_INVALID',
          'PAYMENT_GATEWAY_RUNTIME_ENVIRONMENT_MISMATCH'
        ].includes(error.code)
      await this._setWebhookEventState(
        webhookEvent,
        terminal ? 'failed' : 'retryable',
        error.message
      )
      if (terminal) {
        console.warn(
          `[Webhook] Rejected Paystack DVA deposit: ${error.message}`
        )
        return { status: 200, message: 'Paystack DVA deposit webhook rejected' }
      }
      console.error(
        `[Webhook] Paystack DVA deposit processing failed: ${error.message}`
      )
      return {
        status: 503,
        message: 'Paystack DVA deposit processing failed; retry later'
      }
    }
  }

  /**
   * Routes and processes incoming webhooks for a specific gateway.
   */
  async routeWebhook (providerCode, req) {
    let gateway = await this.getGateway(providerCode)
    let adapter = null
    let payload
    const selected = gateway
      ? this._selectWebhookGateway(gateway, req.headers, req.body)
      : { matched: false }
    if (selected.ambiguous) {
      console.error(
        `[PAYMENT-SECURITY-ALERT] Ambiguous webhook verification context for provider: ${providerCode}`
      )
      return { status: 409, message: 'Ambiguous webhook verification context' }
    }
    let isValid = selected.matched
    if (selected.matched) {
      gateway = selected.gateway
      adapter = selected.adapter
    }

    // A gateway can be rotated immediately after initialization. For new
    // generated references, retry signature verification with the encrypted
    // configuration snapshot bound to that payment.
    if (!isValid) {
      try {
        payload = this._parseWebhookPayload(req.body)
      } catch (error) {
        return gateway
          ? { status: 400, message: 'Malformed JSON payload' }
          : { status: 404, message: 'Gateway not found' }
      }
      const reference = this._extractWebhookReference(providerCode, payload)
      if (reference) {
        const transactionQuery = TransactionStatus.findOne({ refId: reference })
        const transaction =
          typeof transactionQuery?.select === 'function'
            ? await transactionQuery.select('+gatewayConfigSnapshot')
            : await transactionQuery
        if (transaction?.gatewayConfigSnapshot) {
          const snapshotGateway = this._hydrateGatewayCredentials(
            transaction.gatewayConfigSnapshot
          )
          const snapshotAdapterType = String(
            snapshotGateway.adapterType || snapshotGateway.code || ''
          ).toLowerCase()
          if (snapshotAdapterType === String(providerCode).toLowerCase()) {
            const snapshotAdapter = this.getAdapterInstance(snapshotGateway)
            if (snapshotAdapter.verifyWebhookSignature(req.headers, req.body)) {
              snapshotGateway._id = snapshotGateway._id || transaction.gatewayId
              gateway = snapshotGateway
              adapter = snapshotAdapter
              isValid = true
            }
          }
        }
      }
      if (!isValid) {
        const virtualAccountReference = this._extractVirtualAccountReference(
          providerCode,
          payload
        )
        if (virtualAccountReference) {
          let userQuery = User.find({
            virtualAccounts: {
              $elemMatch: {
                provider: 'monnify',
                accountReference: virtualAccountReference,
                provisioningStatus: 'active',
                active: true,
                assigned: true
              }
            }
          })
          if (typeof userQuery?.select === 'function') userQuery = userQuery.select('+virtualAccountGatewaySnapshots')
          if (typeof userQuery?.limit === 'function') userQuery = userQuery.limit(2)
          const users = await userQuery
          const user = Array.isArray(users) && users.length === 1 ? users[0] : null
          const snapshot =
            user?.virtualAccountGatewaySnapshots instanceof Map
              ? user.virtualAccountGatewaySnapshots.get(virtualAccountReference)
              : user?.virtualAccountGatewaySnapshots?.[virtualAccountReference]
          if (snapshot) {
            const snapshotGateway = this._hydrateGatewayCredentials(snapshot)
            snapshotGateway._id = snapshotGateway._id || snapshotGateway.gatewayId
            const snapshotAdapter = this.getAdapterInstance(snapshotGateway)
            if (snapshotAdapter.verifyWebhookSignature(req.headers, req.body)) {
              gateway = snapshotGateway
              adapter = snapshotAdapter
              isValid = true
            }
          }
        }
      }
    }

    if (!isValid) {
      if (!gateway) {
        console.error(
          `[Webhook Error] No gateway found for provider: ${providerCode}`
        )
        return { status: 404, message: 'Gateway not found' }
      }
      console.error(
        `[PAYMENT-SECURITY-ALERT] Invalid webhook signature for provider: ${providerCode}`
      )
      return { status: 401, message: 'Invalid webhook signature' }
    }

    // 2. Parse payload
    if (payload === undefined) {
      try {
        payload = this._parseWebhookPayload(req.body)
      } catch (e) {
        console.error('[Webhook Error] Failed to parse JSON buffer:', e.message)
        return { status: 400, message: 'Malformed JSON payload' }
      }
    }

    // 3. Normalize Event
    const normalized = adapter.normalizeWebhook(payload)
    const claim = await this._claimWebhookEvent({
      providerCode,
      normalized,
      payload
    })
    if (claim.response) return claim.response
    const webhookEvent = claim.webhookEvent

    if (normalized.eventDomain === 'virtual_account_provisioning') {
      try {
        // Lazy loading avoids a module cycle because virtual-account
        // provisioning already depends on this gateway service.
        const virtualAccountService = require('./virtualAccount.service')
        await virtualAccountService.handlePaystackAssignmentWebhook({
          gateway,
          normalized
        })
        await this._setWebhookEventState(webhookEvent, 'processed')
        return {
          status: 200,
          message: 'Virtual-account assignment webhook processed successfully'
        }
      } catch (error) {
        const terminal = error.webhookTerminal === true
        await this._setWebhookEventState(
          webhookEvent,
          terminal ? 'failed' : 'retryable',
          error.message
        )
        if (terminal) {
          console.warn(
            `[Webhook] Rejected ${normalized.eventType} for ${providerCode}: ${error.message}`
          )
          return {
            status: 200,
            message: 'Virtual-account assignment webhook rejected'
          }
        }
        console.error(
          `[Webhook] Failed to process ${normalized.eventType} for ${providerCode}: ${error.message}`
        )
        return {
          status: 503,
          message: 'Virtual-account assignment processing failed; retry later'
        }
      }
    }

    if (
      providerCode === 'paystack' &&
      normalized.eventType === 'charge.success' &&
      normalized.dedicatedNuban?.claimsDedicatedNuban
    ) {
      return this._processPaystackDvaDeposit({
        gateway,
        adapter,
        normalized,
        webhookEvent
      })
    }

    // 5. Process Successful Payment Event
    if (normalized.status === 'success') {
      const refId = normalized.reference
      let virtualAccountOwner = null
      if (providerCode === 'monnify' && normalized.virtualAccountReference) {
        const providerTransactionId = String(normalized.providerTransactionId || '')
        const amountKobo = Math.round(Number(normalized.amount) * 100)
        const currency = String(normalized.currency || '').toUpperCase()
        if (
          !refId ||
          refId === normalized.virtualAccountReference ||
          !providerTransactionId ||
          !Number.isSafeInteger(amountKobo) ||
          amountKobo <= 0 ||
          currency !== 'NGN' ||
          !/^\d{10}$/.test(String(normalized.destinationAccountNumber || ''))
        ) {
          await this._setWebhookEventState(
            webhookEvent,
            'failed',
            'Monnify reserved-account deposit evidence is incomplete'
          )
          return { status: 200, message: 'Monnify reserved-account deposit webhook rejected' }
        }
        try {
          const virtualAccountService = require('./virtualAccount.service')
          virtualAccountOwner = await virtualAccountService.resolveMonnifyDepositOwner({
            gateway,
            accountReference: normalized.virtualAccountReference,
            accountNumber: normalized.destinationAccountNumber
          })
          if (virtualAccountOwner.gatewaySnapshot) {
            const snapshotAdapter = String(
              virtualAccountOwner.gatewaySnapshot.adapterType || virtualAccountOwner.gatewaySnapshot.code || ''
            ).toLowerCase()
            const snapshotGatewayId = String(virtualAccountOwner.gatewaySnapshot.gatewayId || '')
            if (
              snapshotAdapter !== 'monnify' ||
              (snapshotGatewayId && snapshotGatewayId !== String(gateway._id))
            ) {
              const error = new Error('Stored reserved-account gateway snapshot does not belong to Monnify')
              error.code = 'MONNIFY_VIRTUAL_ACCOUNT_GATEWAY_MISMATCH'
              error.webhookTerminal = true
              throw error
            }
          }
        } catch (error) {
          await this._setWebhookEventState(
            webhookEvent,
            error.webhookTerminal === true ? 'failed' : 'retryable',
            error.message
          )
          return {
            status: error.webhookTerminal === true ? 200 : 503,
            message: error.webhookTerminal === true
              ? 'Monnify reserved-account deposit webhook rejected'
              : 'Monnify reserved-account ownership is temporarily unavailable'
          }
        }
      }
      const transactionQuery = TransactionStatus.findOne({ refId })
      let transaction =
        typeof transactionQuery?.select === 'function'
          ? await transactionQuery.select('+gatewayConfigSnapshot')
          : await transactionQuery

      if (!transaction && virtualAccountOwner) {
        try {
          transaction = await TransactionStatus.create({
            refId,
            userId: virtualAccountOwner.userId,
            type: 'funding',
            status: 'pending',
            amountKobo: Math.round(normalized.amount * 100),
            amount: normalized.amount,
            expectedCurrency: normalized.currency,
            channels: ['virtual_account'],
            provider: providerCode,
            gatewayId: String(gateway._id),
            service: gateway.name,
            providerRef: String(normalized.providerTransactionId),
            gatewayConfigSnapshot:
              virtualAccountOwner.gatewaySnapshot || this._snapshotGatewayConfig(gateway)
          })
        } catch (error) {
          if (error?.code !== 11000) throw error
          const concurrentQuery = TransactionStatus.findOne({ refId })
          transaction =
            typeof concurrentQuery?.select === 'function'
              ? await concurrentQuery.select('+gatewayConfigSnapshot')
              : await concurrentQuery
          if (!transaction) throw error
        }
      }

      if (transaction && virtualAccountOwner) {
        this._assertMonnifyVirtualAccountTransactionIdentity(transaction, {
          owner: virtualAccountOwner,
          gateway,
          reference: refId,
          amountKobo: Math.round(normalized.amount * 100),
          currency: String(normalized.currency || '').toUpperCase(),
          providerTransactionId: String(normalized.providerTransactionId || '')
        })
      }

      if (transaction) {
        let gatewayTestVerificationLeaseToken = null
        if (transaction.type === 'gateway_test' && transaction.status === 'pending') {
          const claim = await this._claimGatewayTestVerificationLease(transaction)
          if (!claim) {
            await this._setWebhookEventState(
              webhookEvent,
              'retryable',
              'Gateway-test verification is already in progress'
            )
            return {
              status: 503,
              message: 'Gateway-test verification is already in progress'
            }
          }
          transaction = claim.transaction
          gatewayTestVerificationLeaseToken = claim.token
        }

        // Secondary server-side verification before wallet credit (never trust webhook alone)
        let serverVerify
        try {
          const verificationGateway = transaction.gatewayConfigSnapshot
            ? this._hydrateGatewayCredentials(transaction.gatewayConfigSnapshot)
            : gateway
          const verificationAdapter =
            this.getAdapterInstance(verificationGateway)
          serverVerify = await verificationAdapter.verifyPayment(refId)
        } catch (verifyErr) {
          // A transport/adapter exception cannot authoritatively establish
          // payment failure. Keep the transaction recoverable.
          serverVerify = {
            success: false,
            status: 'pending',
            reference: refId,
            message: `Provider verification unavailable: ${verifyErr.message}`
          }
        }

        if (serverVerify.status === 'success') {
          if (
            providerCode === 'paystack' &&
            serverVerify.dedicatedNuban?.claimsDedicatedNuban
          ) {
            await this._setWebhookEventState(
              webhookEvent,
              'failed',
              'Verified dedicated-NUBAN payment did not pass DVA ownership routing'
            )
            return {
              status: 200,
              message: 'Paystack DVA deposit webhook rejected'
            }
          }
          try {
            const transactionProvider = String(transaction.provider || '').toLowerCase()
            const snapshotCode = String(
              transaction.gatewayConfigSnapshot?.code || ''
            ).toLowerCase()
            const snapshotAdapter = String(
              transaction.gatewayConfigSnapshot?.adapterType || snapshotCode
            ).toLowerCase()
            const verifiedGatewayCode =
              snapshotCode === transactionProvider &&
              snapshotAdapter === String(providerCode).toLowerCase()
                ? transactionProvider
                : providerCode
            const finalResult = await this.finalizeFundingCredit({
              transactionStatus: transaction,
              gatewayPaymentResult: {
                ...serverVerify,
                gateway: verifiedGatewayCode
              },
              source: 'webhook',
              verificationLeaseToken: gatewayTestVerificationLeaseToken
            })
            if (
              gatewayTestVerificationLeaseToken &&
              finalResult.status !== 'success'
            ) {
              await this._setWebhookEventState(
                webhookEvent,
                'retryable',
                `Verified payment settlement is ${finalResult.status}`
              )
              return {
                status: 503,
                message: 'Verified payment settlement is not complete'
              }
            }
          } catch (settlementErr) {
            await this._releaseGatewayTestVerificationLease(
              refId,
              gatewayTestVerificationLeaseToken
            )
            const terminalSecurityFailure = [
              'PAYMENT_GATEWAY_MISMATCH',
              'PAYMENT_REFERENCE_MISMATCH',
              'PAYMENT_CURRENCY_MISMATCH',
              'PAYMENT_AMOUNT_MISMATCH',
              'PAYMENT_GATEWAY_RUNTIME_ENVIRONMENT_MISMATCH'
            ].includes(settlementErr.code)
            await this._setWebhookEventState(
              webhookEvent,
              terminalSecurityFailure ? 'failed' : 'retryable',
              settlementErr.message
            )
            throw settlementErr
          }
        } else if (serverVerify.status === 'failed') {
          await this._releaseGatewayTestVerificationLease(
            refId,
            gatewayTestVerificationLeaseToken
          )
          // The provider authoritatively confirmed a terminal failure.
          // Preserve existing TransactionStatus handling and stop retries.
          await this._setWebhookEventState(
            webhookEvent,
            'failed',
            `Secondary verification confirmed failure: ${serverVerify.message}`
          )
          return {
            status: 200,
            message: 'Secondary verification confirmed payment failure'
          }
        } else {
          await this._releaseGatewayTestVerificationLease(
            refId,
            gatewayTestVerificationLeaseToken
          )
          await this._setWebhookEventState(
            webhookEvent,
            'retryable',
            `Secondary verification inconclusive: ${serverVerify.message}`
          )
          console.warn(
            `[Webhook] Secondary verification inconclusive for ${refId} via ${providerCode}: ${serverVerify.message}`
          )
          return {
            status: 503,
            message: 'Secondary verification inconclusive; retry later'
          }
        }
      } else {
        console.warn(
          `[Webhook] No TransactionStatus found for refId=${refId} from ${providerCode}`
        )
      }
    }

    await this._setWebhookEventState(webhookEvent, 'processed')

    return { status: 200, message: 'Webhook processed successfully' }
  }

  // ─────────────────────────────────────────────────────────
  // FUTURE ADMIN SUPPORT (PHASE 3 PREPARATION)
  // ─────────────────────────────────────────────────────────

  /**
   * Returns all gateway documents (for Admin use only — not client-facing).
   * Caller must sanitize with paymentGatewaySerializer before returning to API.
   */
  async listGatewaysForAdmin () {
    return PaymentGateway.find().sort({ priority: 1, createdAt: 1 })
  }
}

module.exports = new PaymentGatewayService()
