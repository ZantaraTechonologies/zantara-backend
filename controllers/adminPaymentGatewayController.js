'use strict'

const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const PaymentGateway = require('../models/PaymentGateway')
const TransactionStatus = require('../models/TransactionStatus')
const WebhookEvent = require('../models/WebhookEvent')
const User = require('../models/User')
const AuditLog = require('../models/AuditLog')
const paymentGatewayService = require('../services/paymentGateway.service')
const {
  sanitizePaymentGateway,
  sanitizePaymentGatewayForClient
} = require('../utils/paymentGatewaySerializer')
const { encryptSecret, decryptSecretStrict, isEncrypted } = require('../utils/crypto')
const {
  buildGatewayChangePlan,
  paystackCredentialEnvironment,
  isValidPaystackCredential
} = require('../utils/paymentGatewayChangePlan')
const { logAction } = require('./auditController')
const {
  MONNIFY_BASE_URLS,
  plainMetadata,
  configurationVersion,
  isCanonicalMonnify,
  hasExactMonnifyEligibility,
  isCustomerFundingEligible
} = require('../utils/paymentGatewayEligibility')
const {
  SUPPORTED_ADAPTER_CODES,
  getAdapterSpec,
  getPublicCapabilities
} = require('../adapters/payment/paymentAdapterRegistry')

/**
 * Normalizes and validates the gateway routing priority.
 * Returns 1 for undefined/blank (schema default), the floored positive integer
 * for valid inputs, or null for invalid (negative, zero, non-numeric).
 */
function normalizePriority (value) {
  if (value === undefined || value === null || value === '') return 1
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return null
  return Math.floor(n)
}

function isAdministrativeSandboxOnly (metadata) {
  const value = metadata instanceof Map
    ? Object.fromEntries(metadata)
    : metadata || {}
  return value.administrativeSandboxOnly === true
}

function administrativeSandboxDefaultError () {
  return {
    status: 409,
    body: {
      success: false,
      code: 'PAYMENT_GATEWAY_SANDBOX_ISOLATED',
      message: 'An administrative sandbox gateway cannot be the platform default.'
    }
  }
}

const queryWithSession = (query, session) =>
  session && typeof query?.session === 'function'
    ? query.session(session)
    : query

const mutationMatched = result =>
  Number(result?.matchedCount ?? result?.n ?? 0) === 1

const MONNIFY_REPLACEMENT_CONFIRMATIONS = Object.freeze({
  test: 'replace-monnify-merchant',
  live: 'replace-monnify-live-merchant'
})
const MONNIFY_CHECKOUT_CONFIRMATIONS = Object.freeze({
  live: 'initialize-monnify-live-validation-checkout'
})
const MONNIFY_ELIGIBILITY_CONFIRMATIONS = Object.freeze({
  test: 'enable-monnify-test-customer-funding',
  live: 'enable-monnify-live-customer-funding'
})
const MONNIFY_GATEWAY_TEST_RECOVERY_CONFIRMATION =
  'recover-monnify-test-gateway-payment'
const MONNIFY_CHECKOUT_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000
const MONNIFY_CHECKOUT_INITIALIZATION_LEASE_MS = 5 * 60 * 1000
const MONNIFY_ELIGIBILITY_VERIFICATION_LEASE_MS = 2 * 60 * 1000
const MONNIFY_TERMINAL_VALIDATION_STATUSES = new Set(['FAILED', 'EXPIRED'])

async function loadGatewayForMutation (id, session) {
  let query = PaymentGateway.findById(id)
  if (typeof query?.select === 'function') {
    query = query.select(
      '+webhookVerificationSnapshots +virtualAccountMutationVersion'
    )
  }
  return queryWithSession(query, session)
}

function effectiveGatewayForEligibility (gateway, changePlan, nextStatus) {
  const current = gateway?.toObject ? gateway.toObject() : { ...(gateway || {}) }
  return {
    ...current,
    _id: gateway?._id,
    gatewayId: gateway?.gatewayId,
    status: nextStatus,
    environment: changePlan.next.environment,
    metadata: changePlan.next.metadata,
    virtualAccountMutationVersion: gateway?.virtualAccountMutationVersion
  }
}

function validateGatewayUpdatePlan (gateway, changePlan, body) {
  const nextStatus = body.status === undefined ? gateway.status : body.status
  const remainsDefault = gateway.isDefault && body.isDefault !== false && nextStatus === 'active'
  const effectiveDefault = body.isDefault === true || remainsDefault
  if (!['active', 'inactive', 'maintenance'].includes(nextStatus)) {
    return {
      status: 400,
      body: {
        success: false,
        code: 'PAYMENT_GATEWAY_STATUS_INVALID',
        message: "Status must be 'active', 'inactive', or 'maintenance'"
      }
    }
  }
  if (body.isDefault === true && nextStatus !== 'active') {
    return {
      status: 400,
      body: {
        success: false,
        code: 'PAYMENT_GATEWAY_DEFAULT_REQUIRES_ACTIVE',
        message: 'A default gateway must be active.'
      }
    }
  }
  if (
    effectiveDefault &&
    isAdministrativeSandboxOnly(changePlan.next.metadata)
  ) {
    return administrativeSandboxDefaultError()
  }
  if (
    effectiveDefault &&
    !isCustomerFundingEligible(
      effectiveGatewayForEligibility(gateway, changePlan, nextStatus)
    )
  ) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'PAYMENT_GATEWAY_CUSTOMER_FUNDING_INELIGIBLE',
        message: 'Only a customer-eligible active gateway in the current runtime environment can be made default.'
      }
    }
  }
  if (changePlan.changes.adapterType) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'PAYMENT_GATEWAY_ADAPTER_IMMUTABLE',
        message:
          'An existing gateway adapter type cannot be changed. Create a separate gateway configuration instead.',
        details: { effectiveChanges: changePlan.effectiveChanges }
      }
    }
  }
  if (!['test', 'live'].includes(changePlan.next.environment)) {
    return {
      status: 400,
      body: {
        success: false,
        code: 'PAYMENT_GATEWAY_ENVIRONMENT_INVALID',
        message: "Environment must be 'test' or 'live'"
      }
    }
  }
  if (
    isCanonicalMonnify(gateway) &&
    changePlan.metadataChanges.some(key => [
      'administrativeSandboxOnly',
      'checkoutValidation',
      'customerFundingEligibility'
    ].includes(key))
  ) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'MONNIFY_LIFECYCLE_EVIDENCE_IMMUTABLE',
        message: 'Monnify customer-funding isolation and validation evidence cannot be changed through ordinary gateway updates.'
      }
    }
  }
  if (
    isCanonicalMonnify(gateway) &&
    changePlan.next.baseUrl !== MONNIFY_BASE_URLS[changePlan.next.environment]
  ) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'MONNIFY_API_BASE_ENVIRONMENT_MISMATCH',
        message: `Monnify ${changePlan.next.environment} must use the exact API base ${MONNIFY_BASE_URLS[changePlan.next.environment]}.`
      }
    }
  }
  if (
    isCanonicalMonnify(gateway) &&
    changePlan.verificationChanges.length > 0 &&
    nextStatus === 'active'
  ) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'MONNIFY_CONFIGURATION_REQUIRES_INACTIVE',
        message: 'Deactivate Monnify before changing its verification configuration.'
      }
    }
  }
  if (
    changePlan.currentEnvironment === 'test' &&
    changePlan.next.environment === 'live' &&
    body.confirmEnvironmentChange !== 'test-to-live'
  ) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'PAYMENT_GATEWAY_ENVIRONMENT_CONFIRMATION_REQUIRED',
        message: 'Changing a gateway from test to live requires explicit confirmation.',
        details: {
          requiredConfirmation: { confirmEnvironmentChange: 'test-to-live' },
          effectiveChanges: changePlan.effectiveChanges
        }
      }
    }
  }
  if (
    changePlan.currentAdapter === 'paystack' &&
    (changePlan.changes.publicKey ||
      changePlan.changes.secretKey ||
      changePlan.changes.environment ||
      body.status === 'active')
  ) {
    const nextSecretKey = changePlan.changes.secretKey ? body.secretKey : gateway.secretKey
    const invalidFields = [
      ...(!isValidPaystackCredential(changePlan.next.publicKey, 'public')
        ? ['publicKey']
        : []),
      ...(!isValidPaystackCredential(nextSecretKey, 'secret')
        ? ['secretKey']
        : [])
    ]
    if (invalidFields.length > 0) {
      return {
        status: 400,
        body: {
          success: false,
          code: 'PAYMENT_GATEWAY_CREDENTIAL_INVALID',
          message: 'Active Paystack credentials must use valid public and secret key formats.',
          details: { invalidFields }
        }
      }
    }
    const publicKeyEnvironment = paystackCredentialEnvironment(
      changePlan.next.publicKey,
      'public'
    )
    const secretKeyEnvironment = paystackCredentialEnvironment(
      nextSecretKey,
      'secret'
    )
    const mismatchedFields = [
      ...(publicKeyEnvironment && publicKeyEnvironment !== changePlan.next.environment
        ? ['publicKey']
        : []),
      ...(secretKeyEnvironment && secretKeyEnvironment !== changePlan.next.environment
        ? ['secretKey']
        : [])
    ]
    if (mismatchedFields.length > 0) {
      return {
        status: 409,
        body: {
          success: false,
          code: 'PAYMENT_GATEWAY_CREDENTIAL_ENVIRONMENT_MISMATCH',
          message:
            'Paystack credential prefixes must match the selected gateway environment.',
          details: {
            environment: changePlan.next.environment,
            mismatchedFields,
            effectiveChanges: changePlan.effectiveChanges
          }
        }
      }
    }
  }
  if (
    isCanonicalMonnify(gateway) &&
    gateway.status !== 'active' &&
    nextStatus === 'active' &&
    (
      changePlan.verificationChanges.length > 0 ||
      isAdministrativeSandboxOnly(gateway.metadata) ||
      !hasExactMonnifyEligibility(gateway)
    )
  ) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'MONNIFY_CUSTOMER_FUNDING_ELIGIBILITY_REQUIRED',
        message:
          'Verify the exact current Monnify configuration and explicitly enable customer funding before activation.'
      }
    }
  }
  return null
}

function virtualAccountReferenceFilter (gateway) {
  const adapterType = String(gateway.adapterType || '').toLowerCase()
  if (adapterType === 'paystack') {
    return {
      virtualAccounts: {
        $elemMatch: {
          provider: 'paystack',
          gatewayId: String(gateway._id)
        }
      }
    }
  }
  if (adapterType === 'monnify') {
    const ownedScopes = [
      {
        virtualAccounts: {
          $elemMatch: {
            provider: 'monnify',
            gatewayId: String(gateway._id)
          }
        }
      }
    ]
    if (String(gateway.code || '').toLowerCase() === 'monnify') {
      ownedScopes.push({
        virtualAccounts: {
          $elemMatch: {
            provider: 'monnify',
            gatewayId: { $in: [null, ''] }
          }
        }
      })
    }
    return {
      $or: ownedScopes
    }
  }
  return null
}

function appendWebhookVerificationSnapshot (gateway, snapshot) {
  gateway.webhookVerificationSnapshots = [
    ...(Array.isArray(gateway.webhookVerificationSnapshots)
      ? gateway.webhookVerificationSnapshots
      : []),
    snapshot
  ]
  gateway.markModified('webhookVerificationSnapshots')
}

function retainedMonnifySigningSecrets (gateway) {
  return [
    monnifyHistoricalSnapshot(gateway),
    ...(Array.isArray(gateway.webhookVerificationSnapshots)
      ? gateway.webhookVerificationSnapshots
      : [])
  ].map(snapshot => {
    const hydrated = paymentGatewayService._hydrateGatewayCredentials(snapshot)
    return String(hydrated.webhookSecret || hydrated.secretKey || '')
  }).filter(Boolean)
}

function monnifyWebhookVerificationChanged (gateway, changePlan, body) {
  if (changePlan.currentAdapter !== 'monnify') return false
  const current = paymentGatewayService._hydrateGatewayCredentials(
    paymentGatewayService._snapshotGatewayConfig(gateway)
  )
  const nextSecret = changePlan.changes.secretKey
    ? String(body.secretKey || '').trim()
    : current.secretKey
  const nextWebhook = changePlan.changes.webhookSecret
    ? String(body.webhookSecret || '').trim()
    : current.webhookSecret
  return String(current.webhookSecret || current.secretKey || '') !==
    String(nextWebhook || nextSecret || '')
}

async function loadMonnifyAccountProbe (gateway, session) {
  let query = User.findOne(virtualAccountReferenceFilter(gateway))
  if (typeof query?.select === 'function') query = query.select('virtualAccounts')
  const user = await queryWithSession(query, session)
  const gatewayId = String(gateway._id)
  return (user?.virtualAccounts || []).find(account => {
    const accountGatewayId = String(account.gatewayId || '')
    return String(account.provider || '').toLowerCase() === 'monnify' &&
      (accountGatewayId === gatewayId ||
        (!accountGatewayId && String(gateway.code || '').toLowerCase() === 'monnify')) &&
      !!account.accountReference &&
      !!account.accountNumber
  }) || null
}

async function verifyMonnifyCredentialIdentity (gateway, changePlan, body, session) {
  const probe = await loadMonnifyAccountProbe(gateway, session)
  if (!probe) return false
  const current = paymentGatewayService._hydrateGatewayCredentials(
    paymentGatewayService._snapshotGatewayConfig(gateway)
  )
  const candidate = {
    ...current,
    _id: gateway._id,
    publicKey: changePlan.next.publicKey,
    secretKey: changePlan.changes.secretKey
      ? String(body.secretKey || '').trim()
      : current.secretKey,
    webhookSecret: changePlan.changes.webhookSecret
      ? String(body.webhookSecret || '').trim()
      : current.webhookSecret,
    baseUrl: changePlan.next.baseUrl,
    environment: changePlan.next.environment,
    metadata: changePlan.next.metadata
  }
  try {
    const adapter = paymentGatewayService.getAdapterInstance(candidate)
    return await adapter.verifyReservedAccountOwnership({
      accountReference: probe.accountReference,
      accountNumber: probe.accountNumber
    })
  } catch (_) {
    return false
  }
}

async function reauthenticateSuperAdmin (req) {
  const currentPassword = String(req.body?.currentPassword || '')
  if (!currentPassword) {
    const error = new Error('Current password is required.')
    error.code = 'SUPERADMIN_REAUTHENTICATION_REQUIRED'
    error.statusCode = 400
    throw error
  }
  if (currentPassword.length > 1024) {
    const error = new Error('Current password is invalid.')
    error.code = 'SUPERADMIN_REAUTHENTICATION_FAILED'
    error.statusCode = 403
    throw error
  }

  const adminId = req.user?._id || req.user?.id
  const admin = await User.findById(adminId).select(
    '+password status role roles name email phone'
  )
  const roles = [admin?.role, ...(Array.isArray(admin?.roles) ? admin.roles : [])]
  if (!admin || !admin.status || !roles.includes('superAdmin')) {
    const error = new Error('SuperAdmin account is unavailable.')
    error.code = 'SUPERADMIN_REAUTHENTICATION_FAILED'
    error.statusCode = 403
    throw error
  }
  if (!admin.password || !(await bcrypt.compare(currentPassword, admin.password))) {
    const error = new Error('Current password is incorrect.')
    error.code = 'SUPERADMIN_REAUTHENTICATION_FAILED'
    error.statusCode = 403
    throw error
  }
  return admin
}

function monnifyAccountsOwnedByGateway (user, gateway) {
  const gatewayId = String(gateway._id)
  const canonicalGateway = String(gateway.code || '').toLowerCase() === 'monnify'
  return (user?.virtualAccounts || []).filter(account => {
    const accountGatewayId = String(account.gatewayId || '')
    return String(account.provider || '').toLowerCase() === 'monnify' &&
      (accountGatewayId === gatewayId || (!accountGatewayId && canonicalGateway))
  })
}

function snapshotForReference (user, accountReference) {
  const snapshots = user?.virtualAccountGatewaySnapshots
  return snapshots instanceof Map
    ? snapshots.get(accountReference)
    : snapshots?.[accountReference]
}

function hasUsableMonnifySigningSecret (snapshot) {
  const hydrated = paymentGatewayService._hydrateGatewayCredentials(snapshot)
  const signingSecret = hydrated?.webhookSecret || hydrated?.secretKey
  return !!signingSecret && !isEncrypted(signingSecret)
}

function monnifyHistoricalSnapshot (gateway) {
  const snapshot = paymentGatewayService._snapshotGatewayConfig(gateway)
  if (hasUsableMonnifySigningSecret(snapshot)) return snapshot

  const storedApiKey = String(snapshot.publicKey || '').trim()
  const legacyApiKey = String(process.env.MONNIFY_API_KEY || '').trim()
  const legacySecretKey = String(process.env.MONNIFY_SECRET_KEY || '').trim()
  const legacyWebhookSecret =
    String(process.env.MONNIFY_WEBHOOK_SECRET || '').trim() || legacySecretKey

  // Only materialize the legacy runtime fallback when it is provably bound to
  // this gateway. Never guess a historical merchant from a secret alone.
  if (
    !storedApiKey || !legacyApiKey || storedApiKey !== legacyApiKey ||
    !legacyWebhookSecret || isEncrypted(legacyWebhookSecret)
  ) return snapshot

  return {
    ...snapshot,
    secretKey: legacySecretKey ? encryptSecret(legacySecretKey) : '',
    webhookSecret: encryptSecret(legacyWebhookSecret)
  }
}

function assertHistoricalMonnifySnapshot (snapshot, gateway) {
  const hydrated = paymentGatewayService._hydrateGatewayCredentials(snapshot)
  const signingSecret = hydrated?.webhookSecret || hydrated?.secretKey
  if (!hydrated || !signingSecret || isEncrypted(signingSecret)) {
    const error = new Error(
      'An active Monnify reserved account has no archived verification context, and the previous API Secret Key or configured webhook signing secret is unavailable.'
    )
    error.code = 'PAYMENT_GATEWAY_WEBHOOK_HISTORY_UNAVAILABLE'
    error.statusCode = 409
    throw error
  }
  if (
    String(hydrated.gatewayId || hydrated._id || '') !== String(gateway._id) ||
    String(hydrated.code || '').toLowerCase() !== 'monnify' ||
    String(hydrated.adapterType || '').toLowerCase() !== 'monnify'
  ) {
    const error = new Error(
      'A stored reserved-account snapshot does not belong to this Monnify gateway.'
    )
    error.code = 'MONNIFY_RESERVED_ACCOUNT_SNAPSHOT_MISMATCH'
    error.statusCode = 409
    throw error
  }
}

async function archiveMonnifyReservedAccountContexts (gateway, snapshot, session) {
  let query = User.find(virtualAccountReferenceFilter(gateway))
  if (typeof query?.select === 'function') {
    query = query.select('+virtualAccountGatewaySnapshots')
  }
  const users = await queryWithSession(query, session)
  let archivedAccounts = 0

  for (const user of users || []) {
    const references = new Set()
    for (const account of monnifyAccountsOwnedByGateway(user, gateway)) {
      if (!account.accountNumber) {
        if (
          account.provisioningStatus !== 'failed' ||
          account.provisioningFailureDisposition !== 'definitive_rejection'
        ) {
          const error = new Error(
            'An incomplete Monnify reserved-account operation must be reconciled before merchant replacement.'
          )
          error.code = 'MONNIFY_RESERVED_ACCOUNT_RECONCILIATION_REQUIRED'
          error.statusCode = 409
          throw error
        }
        continue
      }
      const accountReference = String(account.accountReference || '')
      if (
        !/^VIRTUAL_[a-f\d]{24}$/i.test(accountReference) ||
        account.provisioningStatus !== 'active' ||
        account.active !== true ||
        account.assigned !== true ||
        String(account.currency || '').toUpperCase() !== 'NGN'
      ) {
        const error = new Error(
          'A Monnify reserved account is not safely routable and must be reconciled before merchant replacement.'
        )
        error.code = 'MONNIFY_RESERVED_ACCOUNT_SNAPSHOT_UNAVAILABLE'
        error.statusCode = 409
        throw error
      }
      references.add(accountReference)
    }

    for (const accountReference of references) {
      const existing = snapshotForReference(user, accountReference)
      if (existing) {
        assertHistoricalMonnifySnapshot(existing, gateway)
        continue
      }
      assertHistoricalMonnifySnapshot(snapshot, gateway)
      const result = await User.updateOne(
        {
          _id: user._id,
          virtualAccounts: {
            $elemMatch: {
              provider: 'monnify',
              accountReference,
              accountNumber: { $exists: true, $ne: '' },
              $or: [
                { gatewayId: String(gateway._id) },
                { gatewayId: { $exists: false } },
                { gatewayId: null },
                { gatewayId: '' }
              ]
            }
          }
        },
        {
          $set: {
            [`virtualAccountGatewaySnapshots.${accountReference}`]: snapshot
          }
        },
        { session }
      )
      if (!mutationMatched(result)) {
        const error = new Error(
          'A reserved-account owner changed concurrently. Please retry.'
        )
        error.code = 'MONNIFY_RESERVED_ACCOUNT_SNAPSHOT_CONFLICT'
        error.statusCode = 409
        throw error
      }
      archivedAccounts++
    }
  }

  return { users: (users || []).length, archivedAccounts }
}

/**
 * GET /api/admin/payment-gateways
 * Returns all configured payment gateways with safe boolean credential indicators.
 */
const getAllGateways = async (req, res) => {
  try {
    const gateways = await PaymentGateway.find().sort({
      priority: 1,
      createdAt: 1
    })
    const sanitized = gateways.map(g => sanitizePaymentGateway(g))

    const activeCount = sanitized.filter(g => g.status === 'active').length
    const defaultGateway = sanitized.find(g => g.isDefault)?.code || null

    res.json({
      success: true,
      data: sanitized,
      summary: {
        total: sanitized.length,
        activeCount,
        defaultGateway
      }
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

/**
 * GET /api/admin/payment-gateways/:id
 * Returns a single gateway by ID.
 */
const getGatewayById = async (req, res) => {
  try {
    const { id } = req.params
    const gateway = await loadGatewayForMutation(id, null)
    if (!gateway) {
      return res
        .status(404)
        .json({ success: false, message: 'Payment gateway not found' })
    }
    res.json({ success: true, data: sanitizePaymentGateway(gateway) })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

/**
 * POST /api/admin/payment-gateways
 * SuperAdmin-only endpoint to register a new payment gateway.
 */
const createGateway = async (req, res) => {
  let mutationSession = null
  let mutationFinished = false
  try {
    const {
      name,
      code,
      adapterType,
      status = 'inactive',
      environment = 'test',
      isDefault = false,
      priority = 1,
      publicKey = '',
      secretKey = '',
      webhookSecret = '',
      baseUrl = '',
      supportedChannels = [],
      metadata = {}
    } = req.body

    if (!name || !code || !adapterType) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: name, code, adapterType'
      })
    }

    if (!SUPPORTED_ADAPTER_CODES.includes(adapterType.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: `Invalid adapterType '${adapterType}'. Must be one of: ${SUPPORTED_ADAPTER_CODES.join(
          ', '
        )}`
      })
    }

    const normalizedEnvironment = String(environment).trim().toLowerCase()
    const normalizedCode = code.toLowerCase().trim()
    if (!['test', 'live'].includes(normalizedEnvironment)) {
      return res.status(400).json({
        success: false,
        code: 'PAYMENT_GATEWAY_ENVIRONMENT_INVALID',
        message: "Environment must be 'test' or 'live'"
      })
    }
    if (
      normalizedEnvironment === 'live' &&
      req.body.confirmEnvironmentChange !== 'create-live'
    ) {
      return res.status(409).json({
        success: false,
        code: 'PAYMENT_GATEWAY_ENVIRONMENT_CONFIRMATION_REQUIRED',
        message: 'Creating a live gateway requires explicit confirmation.',
        details: {
          requiredConfirmation: { confirmEnvironmentChange: 'create-live' }
        }
      })
    }
    const isMonnifyAdapter = adapterType.toLowerCase() === 'monnify'
    const isMonnify = normalizedCode === 'monnify' && isMonnifyAdapter
    const normalizedBaseUrl = String(baseUrl || '').trim()
    if (isMonnify) {
      if (normalizedBaseUrl !== MONNIFY_BASE_URLS[normalizedEnvironment]) {
        return res.status(409).json({
          success: false,
          code: 'MONNIFY_API_BASE_ENVIRONMENT_MISMATCH',
          message: `Monnify ${normalizedEnvironment} must use the exact API base ${MONNIFY_BASE_URLS[normalizedEnvironment]}.`
        })
      }
    }
    if (isMonnify) {
      if (status !== 'inactive' || isDefault === true) {
        return res.status(409).json({
          success: false,
          code: 'MONNIFY_CREATION_REQUIRES_VALIDATION',
          message: 'A new Monnify gateway must be created inactive and non-default, then complete customer-funding validation.'
        })
      }
    }
    if (adapterType.toLowerCase() === 'paystack') {
      const invalidFields = [
        ...((status === 'active' || publicKey) && !isValidPaystackCredential(publicKey, 'public')
          ? ['publicKey']
          : []),
        ...((status === 'active' || secretKey) && !isValidPaystackCredential(secretKey, 'secret')
          ? ['secretKey']
          : [])
      ]
      if (invalidFields.length > 0) {
        return res.status(400).json({
          success: false,
          code: 'PAYMENT_GATEWAY_CREDENTIAL_INVALID',
          message: 'Active Paystack credentials must use valid public and secret key formats.',
          details: { invalidFields }
        })
      }
      const publicKeyEnvironment = paystackCredentialEnvironment(publicKey, 'public')
      const secretKeyEnvironment = paystackCredentialEnvironment(secretKey, 'secret')
      const mismatchedFields = [
        ...(publicKeyEnvironment && publicKeyEnvironment !== normalizedEnvironment
          ? ['publicKey']
          : []),
        ...(secretKeyEnvironment && secretKeyEnvironment !== normalizedEnvironment
          ? ['secretKey']
          : [])
      ]
      if (mismatchedFields.length > 0) {
        return res.status(409).json({
          success: false,
          code: 'PAYMENT_GATEWAY_CREDENTIAL_ENVIRONMENT_MISMATCH',
          message:
            'Paystack credential prefixes must match the selected gateway environment.',
          details: { environment: normalizedEnvironment, mismatchedFields }
        })
      }
    }
    for (const [field, value] of [['secretKey', secretKey], ['webhookSecret', webhookSecret]]) {
      if (isEncrypted(value) && !decryptSecretStrict(value)) {
        return res.status(400).json({
          success: false,
          code: 'PAYMENT_GATEWAY_CREDENTIAL_INVALID',
          message: `${field} contains unreadable encrypted data`
        })
      }
    }

    const requestPriority = normalizePriority(priority)
    if (requestPriority === null) {
      return res.status(400).json({
        success: false,
        message: 'Invalid priority. Must be a positive integer (1 or greater).'
      })
    }

    const existing = await PaymentGateway.findOne({
      $or: [{ code: normalizedCode }, { name: name.trim() }]
    })
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `A payment gateway with code '${normalizedCode}' or name '${name.trim()}' already exists`
      })
    }

    // Validate channels against adapter's declared supported channels
    const adapterSpec = getAdapterSpec(adapterType.toLowerCase())
    const adapterChannels = adapterSpec ? adapterSpec.supportedChannels : []
    if (supportedChannels.length > 0) {
      const invalidChannels = supportedChannels.filter(
        c => !adapterChannels.includes(c)
      )
      if (invalidChannels.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Channels [${invalidChannels.join(
            ', '
          )}] are not supported by the '${adapterType}' adapter. Allowed: ${adapterChannels.join(
            ', '
          )}`
        })
      }
    }

    if (isDefault && status !== 'active') {
      return res.status(400).json({
        success: false,
        message:
          'Default gateway must be active. Cannot make an inactive or maintenance gateway default.'
      })
    }
    if (isDefault && isAdministrativeSandboxOnly(metadata)) {
      const error = administrativeSandboxDefaultError()
      return res.status(error.status).json(error.body)
    }

    const encryptedSecretKey =
      secretKey && secretKey.trim() !== ''
        ? isEncrypted(secretKey.trim())
          ? secretKey.trim()
          : encryptSecret(secretKey.trim())
        : ''

    const encryptedWebhookSecret =
      webhookSecret && webhookSecret.trim() !== ''
        ? isEncrypted(webhookSecret.trim())
          ? webhookSecret.trim()
          : encryptSecret(webhookSecret.trim())
        : ''

    const monnifyMetadata = isMonnify ? { ...(metadata || {}) } : null
    if (monnifyMetadata) {
      delete monnifyMetadata.checkoutValidation
      delete monnifyMetadata.customerFundingEligibility
      monnifyMetadata.administrativeSandboxOnly = true
    }

    const effectiveMetadata = monnifyMetadata || metadata || {}
    if (
      isDefault &&
      !isCustomerFundingEligible({
        code: normalizedCode,
        adapterType: adapterType.toLowerCase(),
        status,
        environment: normalizedEnvironment,
        metadata: effectiveMetadata,
        virtualAccountMutationVersion: 0
      })
    ) {
      return res.status(409).json({
        success: false,
        code: 'PAYMENT_GATEWAY_CUSTOMER_FUNDING_INELIGIBLE',
        message: 'Only a customer-eligible active gateway in the current runtime environment can be made default.'
      })
    }

    mutationSession = await mongoose.startSession()
    mutationSession.startTransaction()
    const [gateway] = await PaymentGateway.create([{
      name: name.trim(),
      code: normalizedCode,
      adapterType: adapterType.toLowerCase(),
      status,
      environment: normalizedEnvironment,
      isDefault: false, // will assign via setDefault if requested
      priority: requestPriority,
      publicKey: publicKey.trim(),
      secretKey: encryptedSecretKey,
      webhookSecret: encryptedWebhookSecret,
      baseUrl: normalizedBaseUrl,
      supportedChannels,
      metadata: effectiveMetadata
    }], { session: mutationSession })

    if (isDefault && status === 'active') {
      await PaymentGateway.setDefault(gateway._id, { session: mutationSession })
      gateway.isDefault = true
    }

    const adminId = req.user?._id || req.user?.id
    const operatorName = req.user?.name || req.user?.email || 'SuperAdmin'
    await AuditLog.create([{
      adminId,
      operatorName,
      action: 'PAYMENT_GATEWAY_CREATED',
      target: `Gateway: ${gateway.name}`,
      details: {
        gatewayId: gateway._id,
        name: gateway.name,
        code: gateway.code,
        adapterType: gateway.adapterType,
        status: gateway.status,
        environment: gateway.environment,
        isDefault: gateway.isDefault,
        secretKeyConfigured: !!(secretKey && secretKey.trim() !== ''),
        webhookSecretConfigured: !!(
          webhookSecret && webhookSecret.trim() !== ''
        )
      },
      result: 'success',
      ipAddress: req.ip || req.headers?.['x-forwarded-for'],
      userAgent: req.headers?.['user-agent']
    }], { session: mutationSession })
    await mutationSession.commitTransaction()
    mutationFinished = true

    res
      .status(201)
      .json({ success: true, data: sanitizePaymentGateway(gateway) })
  } catch (error) {
    if (mutationSession && !mutationFinished) {
      try {
        await mutationSession.abortTransaction()
      } catch (_) {}
      mutationFinished = true
    }
    res.status(400).json({ success: false, message: error.message })
  } finally {
    if (mutationSession) {
      if (!mutationFinished) {
        try {
          await mutationSession.abortTransaction()
        } catch (_) {}
      }
      await mutationSession.endSession()
    }
  }
}

/**
 * PUT /api/admin/payment-gateways/:id
 * SuperAdmin-only endpoint to update gateway settings.
 * RULE: Blank secretKey / webhookSecret retains existing encrypted values.
 */
const updateGateway = async (req, res) => {
  let mutationSession = null
  let mutationFinished = false
  try {
    const { id } = req.params
    let gateway = await loadGatewayForMutation(id, null)
    if (!gateway) {
      return res
        .status(404)
        .json({ success: false, message: 'Payment gateway not found' })
    }

    const {
      name,
      adapterType,
      status,
      environment,
      isDefault,
      priority,
      publicKey,
      secretKey,
      webhookSecret,
      baseUrl,
      supportedChannels,
      metadata
    } = req.body

    let changePlan = buildGatewayChangePlan(gateway, req.body)
    if (
      isCanonicalMonnify(gateway) &&
      gateway.status !== 'active' &&
      req.body.status === 'active'
    ) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_ACTIVATION_REQUIRES_STATUS_ENDPOINT',
        message: 'Activate Monnify through the dedicated status action after sandbox checkout validation.'
      })
    }
    let validation = validateGatewayUpdatePlan(gateway, changePlan, req.body)
    if (validation) return res.status(validation.status).json(validation.body)

    mutationSession = await mongoose.startSession()
    mutationSession.startTransaction()
    gateway = await loadGatewayForMutation(id, mutationSession)
    if (!gateway) {
      return res
        .status(404)
        .json({ success: false, message: 'Payment gateway not found' })
    }
    changePlan = buildGatewayChangePlan(gateway, req.body)
    validation = validateGatewayUpdatePlan(gateway, changePlan, req.body)
    if (validation) return res.status(validation.status).json(validation.body)
    if (changePlan.requiresMutationFence) {
      const fence = await PaymentGateway.updateOne(
        { _id: id },
        { $inc: { virtualAccountMutationVersion: 1 } },
        { session: mutationSession }
      )
      if (!mutationMatched(fence)) {
        return res.status(409).json({
          success: false,
          message: 'Payment gateway changed concurrently. Please retry.'
        })
      }
      gateway.virtualAccountMutationVersion =
        Number(gateway.virtualAccountMutationVersion || 0) + 1
    }

    let isSecretRotated = false
    let isPublicKeyRotated = false
    let isWebhookRotated = false
    let isEnvChanged = false
    let isStatusChanged = false
    const previousEnv = gateway.environment
    const previousStatus = gateway.status
    const currentAdapter = String(gateway.adapterType || '').toLowerCase()
    const requestedAdapter = changePlan.next.adapterType
    const isPaystack = currentAdapter === 'paystack'
    const paystackVerificationChanged =
      isPaystack && changePlan.paystackVerificationChanges.length > 0
    const requiresPaystackDvaCheck =
      isPaystack &&
      (requestedAdapter !== 'paystack' || paystackVerificationChanged)
    const paystackDvaUsers = requiresPaystackDvaCheck
      ? await queryWithSession(
          User.countDocuments({
            virtualAccounts: {
              $elemMatch: {
                provider: 'paystack',
                gatewayId: String(gateway._id)
              }
            }
          }),
          mutationSession
        )
      : 0

    if (paystackDvaUsers > 0 && requestedAdapter !== 'paystack') {
      return res.status(409).json({
        success: false,
        message: `Cannot change the Paystack adapter while ${paystackDvaUsers} user(s) have dedicated virtual accounts.`
      })
    }

    const verificationConfigChanged = changePlan.requiresMutationFence
    if (verificationConfigChanged) {
      const unresolvedPayments = await queryWithSession(
        TransactionStatus.countDocuments({
          provider: gateway.code,
          status: {
            $in: [
              'pending',
              'processing',
              'settlement_pending',
              'reconciliation_required'
            ]
          }
        }),
        mutationSession
      )

      if (unresolvedPayments > 0) {
        return res.status(409).json({
          success: false,
          code: 'PAYMENT_GATEWAY_UNRESOLVED_TRANSACTIONS',
          message: `Cannot change gateway verification settings while ${unresolvedPayments} payment(s) remain unresolved.`,
          details: {
            unresolvedTransactions: unresolvedPayments,
            effectiveChanges: changePlan.effectiveChanges
          }
        })
      }
    }

    if (
      paystackDvaUsers > 0 &&
      changePlan.changes.environment
    ) {
      return res.status(409).json({
        success: false,
        code: 'PAYMENT_GATEWAY_DVA_ENVIRONMENT_LOCKED',
        message:
          'Cannot change the Paystack environment while users have dedicated virtual accounts.',
        details: {
          currentEnvironment: changePlan.currentEnvironment,
          requestedEnvironment: changePlan.next.environment,
          effectiveChanges: changePlan.effectiveChanges
        }
      })
    }

    if (paystackVerificationChanged) {
      const snapshot = paymentGatewayService._snapshotGatewayConfig(gateway)
      const hydratedSnapshot =
        paymentGatewayService._hydrateGatewayCredentials(snapshot)
      const unreadableSecret =
        !hydratedSnapshot.secretKey || isEncrypted(hydratedSnapshot.secretKey)
      if (paystackDvaUsers > 0 && unreadableSecret) {
        return res.status(409).json({
          success: false,
          message:
            'Cannot rotate Paystack verification settings while DVA users exist because the previous verification credentials are unavailable.'
        })
      }
      const nextSecretKey =
        secretKey && typeof secretKey === 'string' && secretKey.trim() !== ''
          ? secretKey.trim()
          : hydratedSnapshot.secretKey
      const currentSigningSecret = hydratedSnapshot.secretKey
      const nextSigningSecret = nextSecretKey
      const apiContextChanged =
        changePlan.changes.secretKey ||
        changePlan.changes.baseUrl ||
        changePlan.changes.environment
      if (
        paystackDvaUsers > 0 &&
        apiContextChanged &&
        nextSigningSecret === currentSigningSecret
      ) {
        return res.status(409).json({
          success: false,
          message:
            'Paystack API settings cannot change for existing DVA users while retaining the same webhook signing secret.'
        })
      }
      appendWebhookVerificationSnapshot(gateway, snapshot)
    }

    const monnifyAccountRoutingChanged =
      currentAdapter === 'monnify' &&
      (changePlan.changes.baseUrl ||
        changePlan.changes.environment ||
        changePlan.metadataChanges.includes('contractCode'))
    const monnifyCredentialsChanged =
      currentAdapter === 'monnify' &&
      (changePlan.changes.publicKey || changePlan.changes.secretKey)
    const monnifyMerchantBindingChanged =
      isCanonicalMonnify(gateway) &&
      (monnifyCredentialsChanged ||
        monnifyAccountRoutingChanged)
    let monnifyVirtualAccountUsers = 0
    if (monnifyAccountRoutingChanged || monnifyCredentialsChanged) {
      const referenceFilter = virtualAccountReferenceFilter(gateway)
      monnifyVirtualAccountUsers = referenceFilter
        ? await queryWithSession(
            User.countDocuments(referenceFilter),
            mutationSession
          )
        : 0
    }
    if (monnifyMerchantBindingChanged && monnifyVirtualAccountUsers === 0) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_MERCHANT_REPLACEMENT_REQUIRED',
        message:
          'Monnify merchant identity can only be changed through the reauthenticated merchant replacement workflow.'
      })
    }
    if (monnifyAccountRoutingChanged && monnifyVirtualAccountUsers > 0) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_RESERVED_ACCOUNT_ROUTING_LOCKED',
        message: `Cannot change Monnify account routing while ${monnifyVirtualAccountUsers} user(s) have reserved accounts.`,
        details: {
          effectiveChanges: changePlan.effectiveChanges,
          routingChanges: [
            ...(changePlan.changes.baseUrl ? ['baseUrl'] : []),
            ...(changePlan.changes.environment ? ['environment'] : []),
            ...(changePlan.metadataChanges.includes('contractCode')
              ? ['metadata.contractCode']
              : [])
          ]
        }
      })
    }
    if (monnifyCredentialsChanged && monnifyVirtualAccountUsers > 0) {
      const identityVerified = await verifyMonnifyCredentialIdentity(
        gateway,
        changePlan,
        req.body,
        mutationSession
      )
      if (!identityVerified) {
        return res.status(409).json({
          success: false,
          code: 'MONNIFY_CREDENTIAL_IDENTITY_UNVERIFIED',
          message:
            'The new Monnify credentials could not verify ownership of an existing reserved account. No credentials were changed.'
        })
      }
    }

    if (monnifyWebhookVerificationChanged(gateway, changePlan, req.body)) {
      const snapshot = paymentGatewayService._snapshotGatewayConfig(gateway)
      const hydratedSnapshot = paymentGatewayService._hydrateGatewayCredentials(snapshot)
      if (!hydratedSnapshot.webhookSecret && !hydratedSnapshot.secretKey) {
        return res.status(409).json({
          success: false,
          code: 'PAYMENT_GATEWAY_WEBHOOK_HISTORY_UNAVAILABLE',
          message:
            'Cannot rotate Monnify webhook verification because the previous signing secret is unavailable.'
        })
      }
      appendWebhookVerificationSnapshot(gateway, snapshot)
    }

    if (name && name.trim() !== '') gateway.name = name.trim()
    if (adapterType) {
      if (!SUPPORTED_ADAPTER_CODES.includes(adapterType.toLowerCase())) {
        return res.status(400).json({
          success: false,
          message: `Invalid adapterType. Must be one of: ${SUPPORTED_ADAPTER_CODES.join(
            ', '
          )}`
        })
      }
      gateway.adapterType = changePlan.next.adapterType
    }

    if (baseUrl !== undefined) gateway.baseUrl = changePlan.next.baseUrl
    if (publicKey !== undefined) {
      gateway.publicKey = changePlan.next.publicKey
      isPublicKeyRotated = changePlan.changes.publicKey
    }
    if (
      priority !== undefined &&
      priority !== null &&
      String(priority).trim() !== ''
    ) {
      const requestPriority = normalizePriority(priority)
      if (requestPriority === null) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid priority. Must be a positive integer (1 or greater).'
        })
      }
      gateway.priority = requestPriority
    }

    if (supportedChannels !== undefined && Array.isArray(supportedChannels)) {
      // Validate channels against adapter's declared supported channels
      const effectiveAdapter = (
        adapterType ||
        gateway.adapterType ||
        ''
      ).toLowerCase()
      const adapterSpec = getAdapterSpec(effectiveAdapter)
      const adapterChannels = adapterSpec ? adapterSpec.supportedChannels : []
      if (supportedChannels.length > 0 && adapterChannels.length > 0) {
        const invalidChannels = supportedChannels.filter(
          c => !adapterChannels.includes(c)
        )
        if (invalidChannels.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Channels [${invalidChannels.join(
              ', '
            )}] are not supported by the '${effectiveAdapter}' adapter. Allowed: ${adapterChannels.join(
              ', '
            )}`
          })
        }
      }
      gateway.supportedChannels = supportedChannels
    }

    if (metadata !== undefined && changePlan.changes.metadata) {
      gateway.metadata = changePlan.next.metadata
      gateway.markModified('metadata')
    }

    // Credentials Rotation: Update ONLY if non-empty string provided.
    // Blank string or undefined means "retain current configured secret".
    if (changePlan.changes.secretKey) {
      gateway.secretKey = isEncrypted(secretKey.trim())
        ? secretKey.trim()
        : encryptSecret(secretKey.trim())
      isSecretRotated = true
    }

    if (
      changePlan.changes.webhookSecret
    ) {
      gateway.webhookSecret = isEncrypted(webhookSecret.trim())
        ? webhookSecret.trim()
        : encryptSecret(webhookSecret.trim())
      isWebhookRotated = true
    }

    // Environment Switch Tracking
    if (changePlan.changes.environment) {
      gateway.environment = changePlan.next.environment
      isEnvChanged = true
    }

    if (isCanonicalMonnify(gateway) && changePlan.verificationChanges.length > 0) {
      const invalidatedMetadata = plainMetadata(gateway)
      delete invalidatedMetadata.checkoutValidation
      delete invalidatedMetadata.customerFundingEligibility
      invalidatedMetadata.administrativeSandboxOnly = true
      gateway.metadata = invalidatedMetadata
      gateway.markModified('metadata')
      gateway.lastHealthCheck = {
        status: 'unknown',
        checkedAt: new Date(),
        message: 'Monnify customer-funding validation is required after configuration changes'
      }
    }

    // Status Management
    if (status && status !== gateway.status) {
      if (!['active', 'inactive', 'maintenance'].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Status must be 'active', 'inactive', or 'maintenance'"
        })
      }
      gateway.status = status
      isStatusChanged = true

      // Inactive or maintenance gateway CANNOT be default
      if (status !== 'active' && gateway.isDefault) {
        gateway.isDefault = false
      }
    }

    await gateway.save(
      mutationSession ? { session: mutationSession } : undefined
    )

    // Default Gateway Handling
    if (isDefault === true && !gateway.isDefault) {
      await PaymentGateway.setDefault(
        gateway._id,
        mutationSession ? { session: mutationSession } : undefined
      )
      gateway.isDefault = true
    } else if (isDefault === false && gateway.isDefault) {
      gateway.isDefault = false
      await gateway.save(
        mutationSession ? { session: mutationSession } : undefined
      )
    }

    const adminId = req.user?._id || req.user?.id
    const operatorName = req.user?.name || req.user?.email || 'SuperAdmin'
    const auditEntries = []

    if (isPublicKeyRotated || isSecretRotated || isWebhookRotated) {
      auditEntries.push({
        adminId,
        operatorName,
        action: 'PAYMENT_GATEWAY_CREDENTIALS_ROTATED',
        target: `Gateway: ${gateway.name}`,
        details: {
          gatewayId: gateway._id,
          name: gateway.name,
          publicKeyUpdated: isPublicKeyRotated,
          secretKeyUpdated: isSecretRotated,
          webhookSecretUpdated: isWebhookRotated
        },
        result: 'success',
        ipAddress: req.ip || req.headers?.['x-forwarded-for'],
        userAgent: req.headers?.['user-agent']
      })
    }

    if (isEnvChanged) {
      auditEntries.push({
        adminId,
        operatorName,
        action: 'PAYMENT_GATEWAY_ENVIRONMENT_CHANGED',
        target: `Gateway: ${gateway.name}`,
        details: {
          gatewayId: gateway._id,
          name: gateway.name,
          previousEnv,
          newEnv: gateway.environment
        },
        result: 'success',
        ipAddress: req.ip || req.headers?.['x-forwarded-for'],
        userAgent: req.headers?.['user-agent']
      })
    }

    if (isStatusChanged) {
      auditEntries.push({
        adminId,
        operatorName,
        action: 'PAYMENT_GATEWAY_STATUS_CHANGED',
        target: `Gateway: ${gateway.name}`,
        details: {
          gatewayId: gateway._id,
          name: gateway.name,
          previousStatus,
          newStatus: gateway.status
        },
        result: 'success',
        ipAddress: req.ip || req.headers?.['x-forwarded-for'],
        userAgent: req.headers?.['user-agent']
      })
    }

    auditEntries.push({
      adminId,
      operatorName,
      action: 'PAYMENT_GATEWAY_UPDATED',
      target: `Gateway: ${gateway.name}`,
      details: {
        gatewayId: gateway._id,
        name: gateway.name,
        status: gateway.status,
        environment: gateway.environment,
        isDefault: gateway.isDefault
      },
      result: 'success',
      ipAddress: req.ip || req.headers?.['x-forwarded-for'],
      userAgent: req.headers?.['user-agent']
    })
    await AuditLog.create(auditEntries, { session: mutationSession })
    await mutationSession.commitTransaction()
    mutationFinished = true

    res.json({
      success: true,
      data: sanitizePaymentGateway(gateway),
      diagnostics: {
        effectiveChanges: changePlan.effectiveChanges,
        verificationConfigurationChanged: changePlan.requiresMutationFence
      }
    })
  } catch (error) {
    if (mutationSession && !mutationFinished) {
      try {
        await mutationSession.abortTransaction()
      } catch (_) {}
      mutationFinished = true
    }
    res.status(400).json({ success: false, message: error.message })
  } finally {
    if (mutationSession) {
      if (!mutationFinished) {
        try {
          await mutationSession.abortTransaction()
        } catch (_) {}
      }
      await mutationSession.endSession()
    }
  }
}

/**
 * PATCH /api/admin/payment-gateways/:id/status
 * SuperAdmin-only endpoint to update gateway status.
 */
const updateGatewayStatus = async (req, res) => {
  let mutationSession = null
  let mutationFinished = false
  try {
    const { id } = req.params
    const { status } = req.body

    if (!status || !['active', 'inactive', 'maintenance'].includes(status)) {
      return res.status(400).json({
        success: false,
        message:
          "Valid status ('active', 'inactive', 'maintenance') is required"
      })
    }

    let gateway = await loadGatewayForMutation(id, null)
    if (!gateway) {
      return res
        .status(404)
        .json({ success: false, message: 'Payment gateway not found' })
    }

    const changePlan = buildGatewayChangePlan(gateway, { status })
    const validation = validateGatewayUpdatePlan(gateway, changePlan, { status })
    if (validation) return res.status(validation.status).json(validation.body)

    mutationSession = await mongoose.startSession()
    mutationSession.startTransaction()
    gateway = await loadGatewayForMutation(id, mutationSession)
    if (!gateway) {
      return res
        .status(404)
        .json({ success: false, message: 'Payment gateway not found' })
    }
    const lockedPlan = buildGatewayChangePlan(gateway, { status })
    const lockedValidation = validateGatewayUpdatePlan(
      gateway,
      lockedPlan,
      { status }
    )
    if (lockedValidation) {
      return res
        .status(lockedValidation.status)
        .json(lockedValidation.body)
    }

    const oldStatus = gateway.status
    const isMonnifyActivation =
      isCanonicalMonnify(gateway) &&
      oldStatus !== 'active' &&
      status === 'active'
    if (isMonnifyActivation) {
      const version = configurationVersion(gateway)
      const activated = await PaymentGateway.updateOne(
        {
          _id: gateway._id,
          status: oldStatus,
          environment: gateway.environment,
          baseUrl: MONNIFY_BASE_URLS[gateway.environment],
          'metadata.administrativeSandboxOnly': false,
          'metadata.customerFundingEligibility.status': 'eligible',
          'metadata.customerFundingEligibility.gatewayId': String(gateway._id),
          'metadata.customerFundingEligibility.environment': gateway.environment,
          'metadata.customerFundingEligibility.configurationVersion': version,
          ...(version === 0
            ? {
                $or: [
                  { virtualAccountMutationVersion: 0 },
                  { virtualAccountMutationVersion: { $exists: false } }
                ]
              }
            : { virtualAccountMutationVersion: version })
        },
        { $set: { status: 'active' } },
        { session: mutationSession }
      )
      if (!mutationMatched(activated)) {
        return res.status(409).json({
          success: false,
          code: 'MONNIFY_CUSTOMER_FUNDING_ELIGIBILITY_REQUIRED',
          message: 'The eligible Monnify configuration changed before activation. Validate and enable customer funding again.'
        })
      }
    } else {
      gateway.status = status
      if (status !== 'active' && gateway.isDefault) {
        gateway.isDefault = false
      }
      await gateway.save({ session: mutationSession })
    }

    await AuditLog.create([{
      adminId: req.user?._id || req.user?.id,
      operatorName: req.user?.name || req.user?.email || 'SuperAdmin',
      action: 'PAYMENT_GATEWAY_STATUS_CHANGED',
      target: `Gateway: ${gateway.name}`,
      details: {
        gatewayId: gateway._id,
        name: gateway.name,
        oldStatus,
        newStatus: status,
        isDefault: gateway.isDefault
      },
      result: 'success',
      ipAddress: req.ip || req.headers?.['x-forwarded-for'],
      userAgent: req.headers?.['user-agent']
    }], { session: mutationSession })
    await mutationSession.commitTransaction()
    mutationFinished = true
    if (isMonnifyActivation) gateway.status = 'active'

    res.json({ success: true, data: sanitizePaymentGateway(gateway) })
  } catch (error) {
    if (mutationSession && !mutationFinished) {
      try {
        await mutationSession.abortTransaction()
      } catch (_) {}
      mutationFinished = true
    }
    res.status(400).json({ success: false, message: error.message })
  } finally {
    if (mutationSession) {
      if (!mutationFinished) {
        try {
          await mutationSession.abortTransaction()
        } catch (_) {}
      }
      await mutationSession.endSession()
    }
  }
}

/**
 * POST /api/admin/payment-gateways/:id/set-default
 * SuperAdmin-only endpoint to designate a gateway as the platform default.
 * Enforces: Gateway must be active. Uses concurrency-safe PaymentGateway.setDefault().
 */
const setDefaultGateway = async (req, res) => {
  let mutationSession = null
  let mutationFinished = false
  try {
    const { id } = req.params
    let gateway = await loadGatewayForMutation(id, null)
    if (!gateway) {
      return res
        .status(404)
        .json({ success: false, message: 'Payment gateway not found' })
    }

    if (gateway.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: `Cannot set gateway '${gateway.name}' as default because it is '${gateway.status}'. Only active gateways can be default.`
      })
    }
    if (isAdministrativeSandboxOnly(gateway.metadata)) {
      const error = administrativeSandboxDefaultError()
      return res.status(error.status).json(error.body)
    }
    if (!isCustomerFundingEligible(gateway)) {
      return res.status(409).json({
        success: false,
        code: 'PAYMENT_GATEWAY_CUSTOMER_FUNDING_INELIGIBLE',
        message: 'Only a customer-eligible active gateway in the current runtime environment can be the platform default.'
      })
    }

    mutationSession = await mongoose.startSession()
    mutationSession.startTransaction()
    gateway = await loadGatewayForMutation(id, mutationSession)
    if (!gateway) {
      return res
        .status(404)
        .json({ success: false, message: 'Payment gateway not found' })
    }
    if (
      gateway.status !== 'active' ||
      isAdministrativeSandboxOnly(gateway.metadata) ||
      !isCustomerFundingEligible(gateway)
    ) {
      return res.status(409).json({
        success: false,
        code: 'PAYMENT_GATEWAY_CUSTOMER_FUNDING_INELIGIBLE',
        message: 'The gateway changed and is no longer eligible to become the platform default.'
      })
    }

    await PaymentGateway.setDefault(gateway._id, { session: mutationSession })

    const adminId = req.user?._id || req.user?.id
    const operatorName = req.user?.name || req.user?.email || 'SuperAdmin'
    await AuditLog.create([{
      adminId,
      operatorName,
      action: 'PAYMENT_GATEWAY_DEFAULT_CHANGED',
      target: `Gateway: ${gateway.name}`,
      details: {
        gatewayId: gateway._id,
        name: gateway.name
      },
      result: 'success',
      ipAddress: req.ip || req.headers?.['x-forwarded-for'],
      userAgent: req.headers?.['user-agent']
    }], { session: mutationSession })
    const updated = await queryWithSession(PaymentGateway.findById(id), mutationSession)
    await mutationSession.commitTransaction()
    mutationFinished = true

    res.json({ success: true, data: sanitizePaymentGateway(updated) })
  } catch (error) {
    if (mutationSession && !mutationFinished) {
      try {
        await mutationSession.abortTransaction()
      } catch (_) {}
      mutationFinished = true
    }
    res.status(400).json({ success: false, message: error.message })
  } finally {
    if (mutationSession) {
      if (!mutationFinished) {
        try {
          await mutationSession.abortTransaction()
        } catch (_) {}
      }
      await mutationSession.endSession()
    }
  }
}

/**
 * POST /api/admin/payment-gateways/:id/test-connection
 * SuperAdmin-only endpoint to test gateway connectivity server-side.
 * Returns only safe success/error messages; never returns keys, secrets, or auth headers.
 */
const testGatewayConnection = async (req, res) => {
  try {
    const { id } = req.params
    const gateway = await loadGatewayForMutation(id, null)
    if (!gateway) {
      return res
        .status(404)
        .json({ success: false, message: 'Payment gateway not found' })
    }

    const hydrated = paymentGatewayService._hydrateGatewayCredentials(gateway)
    const adapter = paymentGatewayService.getAdapterInstance(hydrated)

    let result = null
    try {
      result = await adapter.testConnection()
    } catch (adapterErr) {
      result = {
        success: false,
        message:
          adapterErr.message || 'Connection test threw an unhandled error'
      }
    }

    const nextHealthCheck = {
      status: result.success ? 'online' : 'offline',
      checkedAt: new Date(),
      message: result.message ||
        (result.success ? 'Connection successful' : 'Connection failed')
    }
    gateway.lastHealthCheck = nextHealthCheck
    await gateway.save()

    const adminId = req.user?._id || req.user?.id
    const operatorName = req.user?.name || req.user?.email || 'SuperAdmin'
    await logAction(
      adminId,
      operatorName,
      'PAYMENT_GATEWAY_TEST_CONNECTION',
      `Gateway: ${gateway.name}`,
      {
        gatewayId: gateway._id,
        name: gateway.name,
        healthStatus: gateway.lastHealthCheck.status
      },
      result.success ? 'success' : 'failure',
      req
    )

    res.json({
      success: result.success,
      message: result.message,
      lastHealthCheck: gateway.lastHealthCheck
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

/**
 * POST /api/admin/payment-gateways/:id/replace-monnify-merchant
 * Rebinds the canonical Monnify gateway to a new sandbox merchant only after
 * reauthentication, candidate authentication, and historical-account archival.
 */
const replaceMonnifyMerchant = async (req, res) => {
  let mutationSession = null
  let mutationFinished = false
  try {
    const { id } = req.params
    const publicKey = String(req.body?.publicKey || '').trim()
    const secretKey = String(req.body?.secretKey || '').trim()
    const webhookSecret = String(req.body?.webhookSecret || '').trim() || secretKey
    const contractCode = String(req.body?.contractCode || '').trim()
    const environment = String(req.body?.environment || 'test').trim().toLowerCase()
    if (!['test', 'live'].includes(environment)) {
      return res.status(400).json({
        success: false,
        code: 'PAYMENT_GATEWAY_ENVIRONMENT_INVALID',
        message: "Environment must be 'test' or 'live'"
      })
    }
    const baseUrl = req.body?.baseUrl === undefined
      ? MONNIFY_BASE_URLS[environment]
      : String(req.body.baseUrl).trim()
    if (baseUrl !== MONNIFY_BASE_URLS[environment]) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_API_BASE_ENVIRONMENT_MISMATCH',
        message: `Monnify ${environment} must use the exact API base ${MONNIFY_BASE_URLS[environment]}.`
      })
    }

    const requiredConfirmation = MONNIFY_REPLACEMENT_CONFIRMATIONS[environment]
    if (req.body?.confirmation !== requiredConfirmation) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_MERCHANT_REPLACEMENT_CONFIRMATION_REQUIRED',
        message: 'Explicit Monnify merchant replacement confirmation is required.',
        details: { requiredConfirmation }
      })
    }
    if (
      !publicKey || !secretKey || !contractCode ||
      [publicKey, secretKey, webhookSecret].some(value => isEncrypted(value)) ||
      publicKey.length > 500 || secretKey.length > 500 ||
      webhookSecret.length > 500 || contractCode.length > 100
    ) {
      return res.status(400).json({
        success: false,
        code: 'MONNIFY_MERCHANT_CONFIGURATION_INVALID',
        message: 'New Monnify API key, secret key, and contract code are required.'
      })
    }

    const admin = await reauthenticateSuperAdmin(req)
    let gateway = await loadGatewayForMutation(id, null)
    if (!gateway) {
      return res.status(404).json({ success: false, message: 'Payment gateway not found' })
    }
    if (
      String(gateway.code || '').toLowerCase() !== 'monnify' ||
      String(gateway.adapterType || '').toLowerCase() !== 'monnify'
    ) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_MERCHANT_REPLACEMENT_GATEWAY_INVALID',
        message: 'Merchant replacement is only available for the canonical Monnify gateway.'
      })
    }
    if (gateway.isDefault) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_MERCHANT_REPLACEMENT_DEFAULT_LOCKED',
        message: 'Monnify cannot be replaced while it is the platform default gateway.'
      })
    }
    if (gateway.status !== 'inactive') {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_MERCHANT_REPLACEMENT_REQUIRES_INACTIVE',
        message: 'Deactivate Monnify and allow in-flight payments to drain before replacing its merchant.'
      })
    }

    if (retainedMonnifySigningSecrets(gateway).includes(webhookSecret)) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_WEBHOOK_SECRET_REUSE_FORBIDDEN',
        message: 'The replacement merchant must use a webhook secret distinct from every retained Monnify verification context.'
      })
    }

    const unresolvedFilter = {
      provider: gateway.code,
      status: {
        $in: ['pending', 'processing', 'settlement_pending', 'reconciliation_required']
      }
    }
    const unresolvedPayments = await TransactionStatus.countDocuments(unresolvedFilter)
    if (unresolvedPayments > 0) {
      return res.status(409).json({
        success: false,
        code: 'PAYMENT_GATEWAY_UNRESOLVED_TRANSACTIONS',
        message: `Cannot replace the Monnify merchant while ${unresolvedPayments} payment(s) remain unresolved.`,
        details: { unresolvedTransactions: unresolvedPayments }
      })
    }

    const currentMetadata = gateway.metadata instanceof Map
      ? Object.fromEntries(gateway.metadata)
      : { ...(gateway.metadata || {}) }
    const candidate = {
      ...paymentGatewayService._hydrateGatewayCredentials(
        paymentGatewayService._snapshotGatewayConfig(gateway)
      ),
      _id: gateway._id,
      gatewayId: String(gateway._id),
      code: 'monnify',
      adapterType: 'monnify',
      status: 'inactive',
      environment,
      publicKey,
      secretKey,
      webhookSecret,
      baseUrl,
      metadata: { ...currentMetadata, contractCode }
    }
    const connection = await paymentGatewayService
      .getAdapterInstance(candidate)
      .testConnection()
    if (!connection?.success) {
      return res.status(422).json({
        success: false,
        code: 'MONNIFY_MERCHANT_VALIDATION_FAILED',
        message: `The new Monnify ${environment} credentials could not be authenticated. No configuration was changed.`
      })
    }

    mutationSession = await mongoose.startSession()
    mutationSession.startTransaction()
    gateway = await loadGatewayForMutation(id, mutationSession)
    if (!gateway) {
      return res.status(404).json({ success: false, message: 'Payment gateway not found' })
    }
    if (
      String(gateway.code || '').toLowerCase() !== 'monnify' ||
      String(gateway.adapterType || '').toLowerCase() !== 'monnify' ||
      gateway.isDefault ||
      gateway.status !== 'inactive'
    ) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_MERCHANT_REPLACEMENT_CONFLICT',
        message: 'The Monnify gateway changed while replacement was being validated. Please retry.'
      })
    }
    if (retainedMonnifySigningSecrets(gateway).includes(webhookSecret)) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_WEBHOOK_SECRET_REUSE_FORBIDDEN',
        message: 'The replacement merchant must use a webhook secret distinct from every retained Monnify verification context.'
      })
    }
    const refreshedMetadata = gateway.metadata instanceof Map
      ? Object.fromEntries(gateway.metadata)
      : { ...(gateway.metadata || {}) }
    const unresolvedAfterValidation = await queryWithSession(
      TransactionStatus.countDocuments(unresolvedFilter),
      mutationSession
    )
    if (unresolvedAfterValidation > 0) {
      return res.status(409).json({
        success: false,
        code: 'PAYMENT_GATEWAY_UNRESOLVED_TRANSACTIONS',
        message: `Cannot replace the Monnify merchant while ${unresolvedAfterValidation} payment(s) remain unresolved.`
      })
    }

    const previousVersion = Number(gateway.virtualAccountMutationVersion || 0)
    const versionFilter = {
      _id: id,
      ...(previousVersion === 0
        ? {
            $or: [
              { virtualAccountMutationVersion: 0 },
              { virtualAccountMutationVersion: { $exists: false } }
            ]
          }
        : { virtualAccountMutationVersion: previousVersion })
    }
    const fence = await PaymentGateway.updateOne(
      versionFilter,
      { $inc: { virtualAccountMutationVersion: 1 } },
      { session: mutationSession }
    )
    if (!mutationMatched(fence)) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_MERCHANT_REPLACEMENT_CONFLICT',
        message: 'The Monnify gateway changed concurrently. Please retry.'
      })
    }

    const previousSnapshot = monnifyHistoricalSnapshot(gateway)
    const archived = await archiveMonnifyReservedAccountContexts(
      gateway,
      previousSnapshot,
      mutationSession
    )
    if (hasUsableMonnifySigningSecret(previousSnapshot)) {
      appendWebhookVerificationSnapshot(gateway, previousSnapshot)
    }

    gateway.publicKey = publicKey
    gateway.secretKey = encryptSecret(secretKey)
    gateway.webhookSecret = encryptSecret(webhookSecret)
    gateway.baseUrl = baseUrl
    gateway.environment = environment
    delete refreshedMetadata.checkoutValidation
    delete refreshedMetadata.customerFundingEligibility
    gateway.metadata = {
      ...refreshedMetadata,
      contractCode,
      administrativeSandboxOnly: true
    }
    gateway.markModified('metadata')
    gateway.status = 'inactive'
    gateway.virtualAccountMutationVersion = previousVersion + 1
    gateway.lastHealthCheck = {
      status: 'online',
      checkedAt: new Date(),
      message: `Candidate Monnify ${environment} credentials authenticated; customer-funding validation required`
    }
    await gateway.save({ session: mutationSession })
    const adminId = req.user?._id || req.user?.id
    const operatorName = admin.name || req.user?.name || 'SuperAdmin'
    await AuditLog.create([{
      adminId,
      operatorName,
      action: 'MONNIFY_MERCHANT_REPLACED',
      target: `Gateway: ${gateway.name}`,
      details: {
        gatewayId: gateway._id,
        code: gateway.code,
        environment: gateway.environment,
        targetEnvironment: environment,
        status: gateway.status,
        previousReservedAccountUsers: archived.users,
        newlyArchivedReservedAccounts: archived.archivedAccounts,
        defaultGatewayChanged: false
      },
      result: 'success',
      ipAddress: req.ip || req.headers?.['x-forwarded-for'],
      userAgent: req.headers?.['user-agent']
    }], { session: mutationSession })
    await mutationSession.commitTransaction()
    mutationFinished = true

    return res.json({
      success: true,
      data: sanitizePaymentGateway(gateway),
      diagnostics: {
        candidateAuthenticated: true,
        historicalReservedAccountUsers: archived.users,
        newlyArchivedReservedAccounts: archived.archivedAccounts,
        defaultGatewayChanged: false
      }
    })
  } catch (error) {
    if (mutationSession && !mutationFinished) {
      try {
        await mutationSession.abortTransaction()
      } catch (_) {}
      mutationFinished = true
    }
    return res.status(error.statusCode || 400).json({
      success: false,
      ...(error.code ? { code: error.code } : {}),
      message: error.message
    })
  } finally {
    if (mutationSession) {
      if (!mutationFinished) {
        try {
          await mutationSession.abortTransaction()
        } catch (_) {}
      }
      await mutationSession.endSession()
    }
  }
}

/** Starts a pinned, permanently non-creditable validation checkout. */
const testMonnifyHostedCheckout = async (req, res) => {
  let mutationSession = null
  let mutationFinished = false
  let initializedRecovery = null
  try {
    const admin = await reauthenticateSuperAdmin(req)
    const gateway = await loadGatewayForMutation(req.params.id, null)
    if (!gateway) {
      return res.status(404).json({ success: false, message: 'Payment gateway not found' })
    }
    const environment = gateway.environment
    if (
      !isCanonicalMonnify(gateway) ||
      !['test', 'live'].includes(environment) ||
      String(gateway.baseUrl || '') !== MONNIFY_BASE_URLS[environment] ||
      gateway.isDefault ||
      !isAdministrativeSandboxOnly(gateway.metadata)
    ) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_VALIDATION_CHECKOUT_GATEWAY_INVALID',
        message: 'Validation checkout requires the canonical, non-default, admin-isolated Monnify gateway with the exact environment API base.'
      })
    }
    if (
      environment === 'live' &&
      req.body?.confirmation !== MONNIFY_CHECKOUT_CONFIRMATIONS.live
    ) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_LIVE_VALIDATION_CONFIRMATION_REQUIRED',
        message: 'Initializing a live Monnify validation checkout requires explicit confirmation.',
        details: { requiredConfirmation: MONNIFY_CHECKOUT_CONFIRMATIONS.live }
      })
    }
    if (gateway.status !== 'inactive') {
      return res.status(409).json({
        success: false,
        code: gateway.status === 'maintenance'
          ? 'MONNIFY_VALIDATION_CHECKOUT_MAINTENANCE'
          : 'MONNIFY_VALIDATION_CHECKOUT_REQUIRES_INACTIVE',
        message: gateway.status === 'maintenance'
          ? 'Leave maintenance mode before starting a validation checkout.'
          : 'The Monnify gateway must remain inactive during checkout validation.'
      })
    }

    const amount = Number(req.body?.amount)
    const amountKobo = Math.round(amount * 100)
    if (
      !Number.isFinite(amount) || amount < 50 || amount > 5000 ||
      !Number.isSafeInteger(amountKobo) ||
      Math.abs(amount * 100 - amountKobo) > 1e-7
    ) {
      return res.status(400).json({
        success: false,
        code: 'MONNIFY_VALIDATION_CHECKOUT_AMOUNT_INVALID',
        message: 'Validation checkout amount must be between N50 and N5,000 with at most two decimal places.'
      })
    }

    const markerVersion = configurationVersion(gateway)
    const leaseToken = crypto.randomBytes(32).toString('hex')
    const leaseStartedAt = new Date()
    const leaseExpiresAt = new Date(
      leaseStartedAt.getTime() + MONNIFY_CHECKOUT_INITIALIZATION_LEASE_MS
    )
    const versionClause = markerVersion === 0
      ? {
          $or: [
            { virtualAccountMutationVersion: 0 },
            { virtualAccountMutationVersion: { $exists: false } }
          ]
        }
      : { virtualAccountMutationVersion: markerVersion }
    const exactGatewayFilter = {
      _id: gateway._id,
      status: 'inactive',
      isDefault: false,
      environment,
      baseUrl: MONNIFY_BASE_URLS[environment],
      'metadata.administrativeSandboxOnly': true
    }
    const lease = await PaymentGateway.updateOne(
      {
        ...exactGatewayFilter,
        $and: [
          versionClause,
          {
            $or: [
              { 'metadata.checkoutValidation': { $exists: false } },
              { 'metadata.checkoutValidation.expiresAt': { $lte: leaseStartedAt } }
            ]
          }
        ]
      },
      {
        $set: {
          'metadata.checkoutValidation': {
            status: 'initializing',
            leaseToken,
            gatewayId: String(gateway._id),
            environment,
            configurationVersion: markerVersion,
            amountKobo,
            currency: 'NGN',
            startedAt: leaseStartedAt,
            expiresAt: leaseExpiresAt
          },
          lastHealthCheck: {
            status: 'unknown',
            checkedAt: leaseStartedAt,
            message: `Monnify ${environment} validation checkout initialization in progress`
          }
        },
        $unset: { 'metadata.customerFundingEligibility': 1 }
      }
    )
    if (!mutationMatched(lease)) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_VALIDATION_CHECKOUT_IN_PROGRESS',
        message: 'A validation checkout already exists or is being initialized for this Monnify configuration.'
      })
    }

    let result
    try {
      result = await paymentGatewayService.initializeFunding({
        gatewayCode: 'monnify',
        requiredGatewayId: String(gateway._id),
        requiredEnvironment: environment,
        requiredStatus: 'inactive',
        requiredMutationVersion: markerVersion,
        allowInactiveGateway: true,
        administrativeSandboxTest: true,
        administrativeValidationLeaseToken: leaseToken,
        user: {
          _id: admin._id,
          name: admin.name,
          email: admin.email,
          phone: admin.phone
        },
        amount,
        metadata: {
          administrativeSandboxTest: true,
          validationEnvironment: environment,
          configurationVersion: markerVersion
        }
      })
    } catch (error) {
      if (error.code === 'PAYMENT_INITIALIZATION_AMBIGUOUS' && error.reference) {
        const ambiguousAt = new Date()
        const ambiguousEvidence = {
          status: 'ambiguous',
          reference: error.reference,
          gatewayId: String(gateway._id),
          environment,
          configurationVersion: markerVersion,
          amountKobo,
          currency: 'NGN',
          initializedAt: ambiguousAt,
          expiresAt: new Date(
            ambiguousAt.getTime() + MONNIFY_CHECKOUT_EVIDENCE_TTL_MS
          )
        }
        const retained = await PaymentGateway.updateOne(
          {
            ...exactGatewayFilter,
            'metadata.checkoutValidation.status': 'initializing',
            'metadata.checkoutValidation.leaseToken': leaseToken
          },
          {
            $set: {
              'metadata.checkoutValidation': ambiguousEvidence,
              lastHealthCheck: {
                status: 'unknown',
                checkedAt: ambiguousAt,
                message: `Monnify ${environment} validation checkout initialization is ambiguous; verification required`
              }
            }
          }
        )
        if (!mutationMatched(retained)) {
          error.code = 'MONNIFY_VALIDATION_CHECKOUT_CONFIGURATION_CHANGED'
          error.statusCode = 409
        }
      } else {
        const definitive = error.gatewayInitializationOutcome === 'definitive_failure' ||
          error.cause?.gatewayInitializationOutcome === 'definitive_failure'
        const requestDispatched = error.requestDispatched ?? error.cause?.requestDispatched
        if (definitive && requestDispatched === false) {
          await PaymentGateway.updateOne(
            {
              _id: gateway._id,
              'metadata.checkoutValidation.status': 'initializing',
              'metadata.checkoutValidation.leaseToken': leaseToken
            },
            { $unset: { 'metadata.checkoutValidation': 1 } }
          )
        }
      }
      throw error
    }

    const initializedAt = new Date()
    const checkoutValidation = {
      status: 'initialized',
      reference: result.reference,
      gatewayId: String(gateway._id),
      environment,
      configurationVersion: markerVersion,
      amountKobo,
      currency: 'NGN',
      initializedAt,
      expiresAt: new Date(initializedAt.getTime() + MONNIFY_CHECKOUT_EVIDENCE_TTL_MS)
    }
    initializedRecovery = {
      exactGatewayFilter,
      leaseToken,
      reference: result.reference,
      gatewayId: String(gateway._id),
      environment,
      configurationVersion: markerVersion,
      amountKobo
    }
    mutationSession = await mongoose.startSession()
    mutationSession.startTransaction()
    const marker = await PaymentGateway.updateOne(
      {
        ...exactGatewayFilter,
        'metadata.checkoutValidation.status': 'initializing',
        'metadata.checkoutValidation.leaseToken': leaseToken
      },
      {
        $set: {
          'metadata.checkoutValidation': checkoutValidation,
          lastHealthCheck: {
            status: 'online',
            checkedAt: initializedAt,
            message: `Monnify ${environment} validation checkout initialized; payment verification required`
          }
        },
        $unset: { 'metadata.customerFundingEligibility': 1 }
      },
      { session: mutationSession }
    )
    if (!mutationMatched(marker)) {
      const error = new Error('The Monnify gateway changed during checkout initialization. It remains inactive and unvalidated.')
      error.statusCode = 409
      error.code = 'MONNIFY_VALIDATION_CHECKOUT_CONFIGURATION_CHANGED'
      error.status = 'pending'
      error.reference = result.reference
      throw error
    }

    await AuditLog.create([{
      adminId: req.user?._id || req.user?.id,
      operatorName: admin.name || req.user?.name || 'SuperAdmin',
      action: 'MONNIFY_VALIDATION_CHECKOUT_INITIALIZED',
      target: `Gateway: ${gateway.name}`,
      details: {
        gatewayId: gateway._id,
        reference: result.reference,
        amount,
        environment,
        configurationVersion: markerVersion,
        amountKobo,
        expiresAt: checkoutValidation.expiresAt,
        defaultGatewayChanged: false
      },
      result: 'success',
      ipAddress: req.ip || req.headers?.['x-forwarded-for'],
      userAgent: req.headers?.['user-agent']
    }], { session: mutationSession })
    await mutationSession.commitTransaction()
    mutationFinished = true

    return res.json({
      success: true,
      authorizationUrl: result.authorizationUrl,
      reference: result.reference,
      provider: result.provider,
      environment,
      configurationVersion: markerVersion,
      expiresAt: checkoutValidation.expiresAt
    })
  } catch (error) {
    if (mutationSession && !mutationFinished) {
      try {
        await mutationSession.abortTransaction()
      } catch (_) {}
      mutationFinished = true
    }
    if (initializedRecovery) {
      const ambiguousAt = new Date()
      try {
        await PaymentGateway.updateOne(
          {
            ...initializedRecovery.exactGatewayFilter,
            'metadata.checkoutValidation.status': 'initializing',
            'metadata.checkoutValidation.leaseToken': initializedRecovery.leaseToken
          },
          {
            $set: {
              'metadata.checkoutValidation': {
                status: 'ambiguous',
                reference: initializedRecovery.reference,
                gatewayId: initializedRecovery.gatewayId,
                environment: initializedRecovery.environment,
                configurationVersion: initializedRecovery.configurationVersion,
                amountKobo: initializedRecovery.amountKobo,
                currency: 'NGN',
                initializedAt: ambiguousAt,
                expiresAt: new Date(
                  ambiguousAt.getTime() + MONNIFY_CHECKOUT_EVIDENCE_TTL_MS
                )
              },
              lastHealthCheck: {
                status: 'unknown',
                checkedAt: ambiguousAt,
                message: `Monnify ${initializedRecovery.environment} validation checkout requires recovery verification`
              }
            }
          }
        )
      } catch (_) {}
      error.code = 'PAYMENT_INITIALIZATION_AMBIGUOUS'
      error.reference = initializedRecovery.reference
      error.status = 'pending'
      error.message = 'Monnify accepted the validation checkout, but local audit finalization was inconclusive. Verify the same reference before retrying.'
    }
    if (error.code === 'PAYMENT_INITIALIZATION_AMBIGUOUS') {
      return res.status(202).json({
        success: false,
        code: error.code,
        message: error.message,
        status: 'pending',
        reference: error.reference
      })
    }
    return res.status(error.statusCode || 400).json({
      success: false,
      ...(error.code ? { code: error.code } : {}),
      ...(error.reference
        ? { reference: error.reference, status: error.status || 'pending' }
        : {}),
      message: error.message
    })
  } finally {
    if (mutationSession) {
      if (!mutationFinished) {
        try {
          await mutationSession.abortTransaction()
        } catch (_) {}
      }
      await mutationSession.endSession()
    }
  }
}

/** Verifies the pinned checkout and explicitly removes customer isolation. */
const enableMonnifyCustomerFunding = async (req, res) => {
  let mutationSession = null
  let mutationFinished = false
  try {
    const reference = String(req.body?.reference || '').trim()
    if (!reference || reference.length > 200) {
      return res.status(400).json({
        success: false,
        code: 'MONNIFY_VALIDATION_REFERENCE_INVALID',
        message: 'A valid initialized checkout reference is required.'
      })
    }

    const gateway = await loadGatewayForMutation(req.params.id, null)
    if (!gateway) {
      return res.status(404).json({ success: false, message: 'Payment gateway not found' })
    }
    const environment = gateway.environment
    const requiredConfirmation = MONNIFY_ELIGIBILITY_CONFIRMATIONS[environment]
    if (!requiredConfirmation || req.body?.confirmation !== requiredConfirmation) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_CUSTOMER_FUNDING_CONFIRMATION_REQUIRED',
        message: 'Enabling Monnify customer funding requires environment-specific explicit confirmation.',
        details: { requiredConfirmation }
      })
    }
    const admin = await reauthenticateSuperAdmin(req)
    const assertGatewayEvidence = (candidate, at) => {
      const candidateEnvironment = candidate?.environment
      const candidateMetadata = plainMetadata(candidate)
      const candidateCheckout = candidateMetadata.checkoutValidation
      const candidateVersion = configurationVersion(candidate)
      const recoveringInitialization =
        candidateCheckout?.status === 'initializing' &&
        !candidateCheckout.reference &&
        Boolean(candidateCheckout.leaseToken)
      if (
        !isCanonicalMonnify(candidate) ||
        candidate.status !== 'inactive' ||
        candidate.isDefault ||
        candidateMetadata.administrativeSandboxOnly !== true ||
        !['test', 'live'].includes(candidateEnvironment) ||
        candidate.baseUrl !== MONNIFY_BASE_URLS[candidateEnvironment]
      ) {
        const error = new Error('Customer funding can only be enabled for the inactive, non-default, admin-isolated canonical Monnify gateway.')
        error.code = 'MONNIFY_CUSTOMER_FUNDING_GATEWAY_INVALID'
        error.statusCode = 409
        throw error
      }
      if (
        !candidateCheckout ||
        !['initialized', 'ambiguous', 'initializing'].includes(candidateCheckout.status) ||
        (!recoveringInitialization && candidateCheckout.reference !== reference) ||
        String(candidateCheckout.gatewayId || '') !== String(candidate._id) ||
        candidateCheckout.environment !== candidateEnvironment ||
        Number(candidateCheckout.configurationVersion) !== candidateVersion ||
        !Number.isSafeInteger(candidateCheckout.amountKobo) ||
        candidateCheckout.amountKobo <= 0 ||
        candidateCheckout.currency !== 'NGN'
      ) {
        const error = new Error('The initialized checkout evidence does not match the exact current Monnify configuration.')
        error.code = 'MONNIFY_CHECKOUT_EVIDENCE_MISMATCH'
        error.statusCode = 409
        throw error
      }
      const expiresAt = new Date(candidateCheckout.expiresAt)
      if (!expiresAt.getTime() || expiresAt <= at) {
        const error = new Error('The initialized Monnify checkout evidence has expired. Initialize a new validation checkout.')
        error.code = 'MONNIFY_CHECKOUT_EVIDENCE_EXPIRED'
        error.statusCode = 410
        throw error
      }
      return {
        environment: candidateEnvironment,
        metadata: candidateMetadata,
        checkout: candidateCheckout,
        version: candidateVersion,
        recoveringInitialization
      }
    }
    const loadTransaction = async session => {
      let query = TransactionStatus.findOne({ refId: reference })
      if (typeof query?.select === 'function') {
        query = query.select(
          '+gatewayConfigSnapshot +administrativeValidationLeaseToken +eligibilityVerificationLeaseToken +eligibilityVerificationLeaseExpiresAt'
        )
      }
      return queryWithSession(query, session)
    }
    const assertTransactionIdentity = (row, candidate, evidence) => {
      const snapshot = row?.gatewayConfigSnapshot || {}
      if (
        !row ||
        row.type !== 'gateway_test' ||
        String(row.userId || '') !== String(admin._id) ||
        String(row.provider || '').toLowerCase() !== 'monnify' ||
        String(row.gatewayId || '') !== String(candidate._id) ||
        row.refId !== reference ||
        row.amountKobo !== evidence.checkout.amountKobo ||
        String(row.expectedCurrency || '').toUpperCase() !== 'NGN' ||
        String(snapshot.gatewayId || '') !== String(candidate._id) ||
        String(snapshot.code || '').toLowerCase() !== 'monnify' ||
        String(snapshot.adapterType || '').toLowerCase() !== 'monnify' ||
        snapshot.environment !== evidence.environment ||
        Number(snapshot.configurationVersion) !== evidence.version ||
        (evidence.recoveringInitialization &&
          row.administrativeValidationLeaseToken !== evidence.checkout.leaseToken)
      ) {
        const error = new Error('The gateway-test transaction does not belong to the exact initialized Monnify configuration.')
        error.code = 'MONNIFY_GATEWAY_TEST_SNAPSHOT_MISMATCH'
        error.statusCode = 409
        throw error
      }
    }
    const initialEvidence = assertGatewayEvidence(gateway, new Date())
    let transaction = await loadTransaction(null)
    assertTransactionIdentity(transaction, gateway, initialEvidence)

    let verificationLeaseToken =
      transaction.eligibilityVerificationLeaseToken || null
    if (transaction.status === 'pending') {
      const leaseStartedAt = new Date()
      verificationLeaseToken = crypto.randomBytes(32).toString('hex')
      let leaseQuery = TransactionStatus.findOneAndUpdate(
        {
          _id: transaction._id,
          refId: reference,
          status: 'pending',
          type: 'gateway_test',
          provider: transaction.provider,
          gatewayId: transaction.gatewayId,
          $or: [
            {
              eligibilityVerificationLeaseExpiresAt: {
                $lte: leaseStartedAt
              }
            },
            {
              eligibilityVerificationLeaseToken: { $exists: false },
              eligibilityVerificationLeaseExpiresAt: { $exists: false }
            }
          ]
        },
        {
          $set: {
            eligibilityVerificationLeaseToken: verificationLeaseToken,
            eligibilityVerificationLeaseExpiresAt: new Date(
              leaseStartedAt.getTime() +
                MONNIFY_ELIGIBILITY_VERIFICATION_LEASE_MS
            )
          }
        },
        { new: true }
      )
      if (typeof leaseQuery?.select === 'function') {
        leaseQuery = leaseQuery.select(
          '+gatewayConfigSnapshot +administrativeValidationLeaseToken +eligibilityVerificationLeaseToken +eligibilityVerificationLeaseExpiresAt'
        )
      }
      transaction = await leaseQuery
      if (!transaction) {
        return res.status(202).json({
          success: false,
          code: 'MONNIFY_VALIDATION_VERIFICATION_IN_PROGRESS',
          status: 'processing',
          reference,
          retryAllowed: false,
          message: 'This Monnify validation payment is already being verified.'
        })
      }
      assertTransactionIdentity(transaction, gateway, initialEvidence)
    }

    const verification = await paymentGatewayService.verifyFunding(reference, {
      verificationLeaseToken
    })
    if (['pending', 'processing', 'settlement_pending'].includes(verification.status)) {
      return res.status(202).json({
        success: false,
        code: 'MONNIFY_VALIDATION_PAYMENT_PENDING',
        status: verification.status,
        reference,
        retryAllowed: false,
        message: verification.message || 'Monnify has not conclusively verified this validation payment.'
      })
    }
    const terminalProviderStatus = String(
      verification.providerStatus || ''
    ).trim().toUpperCase()
    if (
      verification.status === 'failed' &&
      MONNIFY_TERMINAL_VALIDATION_STATUSES.has(terminalProviderStatus)
    ) {
      mutationSession = await mongoose.startSession()
      mutationSession.startTransaction()
      const lockedGateway = await loadGatewayForMutation(req.params.id, mutationSession)
      if (!lockedGateway) {
        const error = new Error('Payment gateway not found')
        error.statusCode = 404
        throw error
      }

      const releasedAt = new Date()
      const lockedEvidence = assertGatewayEvidence(lockedGateway, releasedAt)
      transaction = await loadTransaction(mutationSession)
      assertTransactionIdentity(transaction, lockedGateway, lockedEvidence)
      if (
        transaction.status !== 'failed' ||
        !MONNIFY_TERMINAL_VALIDATION_STATUSES.has(
          String(transaction.providerPaymentStatus || '').toUpperCase()
        ) ||
        String(transaction.providerPaymentStatus || '').toUpperCase() !== terminalProviderStatus ||
        !(transaction.providerVerifiedAt instanceof Date) ||
        String(transaction.confirmedReference || '') !== reference
      ) {
        const error = new Error('Provider-confirmed terminal evidence is incomplete or no longer belongs to this validation attempt.')
        error.code = 'MONNIFY_VALIDATION_TERMINAL_EVIDENCE_INVALID'
        error.statusCode = 409
        throw error
      }

      const releasedTransaction = await TransactionStatus.updateOne(
        {
          _id: transaction._id,
          refId: reference,
          status: 'failed',
          type: 'gateway_test',
          provider: transaction.provider,
          eligibilityVerificationLeaseToken: verificationLeaseToken,
          providerPaymentStatus: terminalProviderStatus,
          confirmedReference: reference
        },
        {
          $set: { eligibilityAttemptReleasedAt: releasedAt },
          $unset: {
            eligibilityVerificationLeaseToken: 1,
            eligibilityVerificationLeaseExpiresAt: 1
          }
        },
        { session: mutationSession }
      )
      if (!mutationMatched(releasedTransaction)) {
        const error = new Error('The validation verification lease changed before terminal recovery completed.')
        error.code = 'MONNIFY_VALIDATION_TERMINAL_RELEASE_CONFLICT'
        error.statusCode = 409
        throw error
      }

      const releaseFilter = {
        _id: lockedGateway._id,
        status: 'inactive',
        isDefault: false,
        environment: lockedEvidence.environment,
        baseUrl: MONNIFY_BASE_URLS[lockedEvidence.environment],
        'metadata.administrativeSandboxOnly': true,
        'metadata.checkoutValidation.status': lockedEvidence.checkout.status,
        'metadata.checkoutValidation.gatewayId': String(lockedGateway._id),
        'metadata.checkoutValidation.environment': lockedEvidence.environment,
        'metadata.checkoutValidation.configurationVersion': lockedEvidence.version,
        'metadata.checkoutValidation.expiresAt': { $gt: releasedAt },
        ...(lockedEvidence.checkout.status === 'initializing'
          ? {
              'metadata.checkoutValidation.leaseToken': lockedEvidence.checkout.leaseToken,
              'metadata.checkoutValidation.reference': { $exists: false }
            }
          : { 'metadata.checkoutValidation.reference': reference }),
        ...(lockedEvidence.version === 0
          ? {
              $or: [
                { virtualAccountMutationVersion: 0 },
                { virtualAccountMutationVersion: { $exists: false } }
              ]
            }
          : { virtualAccountMutationVersion: lockedEvidence.version })
      }
      const released = await PaymentGateway.updateOne(
        releaseFilter,
        {
          $unset: {
            'metadata.checkoutValidation': 1,
            'metadata.customerFundingEligibility': 1
          },
          $set: {
            lastHealthCheck: {
              status: 'unknown',
              checkedAt: releasedAt,
              message: `Monnify ${lockedEvidence.environment} validation payment ${terminalProviderStatus.toLowerCase()}; a new validation checkout is permitted`
            }
          }
        },
        { session: mutationSession }
      )
      if (!mutationMatched(released)) {
        const error = new Error('The Monnify configuration or validation attempt changed before terminal recovery completed.')
        error.code = 'MONNIFY_VALIDATION_TERMINAL_RELEASE_CONFLICT'
        error.statusCode = 409
        throw error
      }

      await AuditLog.create([{
        adminId: req.user?._id || req.user?.id,
        operatorName: admin.name || req.user?.name || 'SuperAdmin',
        action: 'MONNIFY_VALIDATION_CHECKOUT_TERMINAL',
        target: `Gateway: ${lockedGateway.name}`,
        details: {
          gatewayId: lockedGateway._id,
          reference,
          environment: lockedEvidence.environment,
          configurationVersion: lockedEvidence.version,
          providerStatus: terminalProviderStatus,
          retryAllowed: true,
          defaultGatewayChanged: false
        },
        result: 'warning',
        ipAddress: req.ip || req.headers?.['x-forwarded-for'],
        userAgent: req.headers?.['user-agent']
      }], { session: mutationSession })
      await mutationSession.commitTransaction()
      mutationFinished = true

      return res.status(422).json({
        success: false,
        code: 'MONNIFY_VALIDATION_PAYMENT_TERMINAL',
        status: 'failed',
        providerStatus: terminalProviderStatus,
        reference,
        attemptReleased: true,
        retryAllowed: true,
        message: `Monnify reports this validation payment as ${terminalProviderStatus}. The historical attempt was retained and a new validation checkout may be started explicitly.`
      })
    }
    if (verification.status !== 'success') {
      return res.status(422).json({
        success: false,
        code: 'MONNIFY_VALIDATION_PAYMENT_NOT_SUCCESSFUL',
        status: verification.status,
        reference,
        retryAllowed: false,
        message: verification.message || 'Monnify did not verify this validation payment as successful.'
      })
    }

    mutationSession = await mongoose.startSession()
    mutationSession.startTransaction()
    const lockedGateway = await loadGatewayForMutation(req.params.id, mutationSession)
    if (!lockedGateway) {
      const error = new Error('Payment gateway not found')
      error.statusCode = 404
      throw error
    }
    const verifiedAt = new Date()
    const lockedEvidence = assertGatewayEvidence(lockedGateway, verifiedAt)
    transaction = await loadTransaction(mutationSession)
    assertTransactionIdentity(transaction, lockedGateway, lockedEvidence)
    if (
      transaction.status !== 'success' ||
      String(transaction.confirmedProvider || '').toLowerCase() !== 'monnify' ||
      transaction.confirmedReference !== reference ||
      transaction.confirmedAmountKobo !== lockedEvidence.checkout.amountKobo ||
      String(transaction.confirmedCurrency || '').toUpperCase() !== 'NGN' ||
      !String(transaction.confirmedProviderRef || '').trim()
    ) {
      const error = new Error('The settled gateway-test evidence is incomplete or does not match the initialized checkout.')
      error.code = 'MONNIFY_VALIDATION_SETTLEMENT_EVIDENCE_INVALID'
      error.statusCode = 409
      throw error
    }

    const { leaseToken: _leaseToken, ...checkoutEvidence } = lockedEvidence.checkout
    const verifiedCheckout = {
      ...checkoutEvidence,
      status: 'verified',
      reference,
      verifiedAt,
      provider: 'monnify',
      providerTransactionId: String(transaction.confirmedProviderRef)
    }
    const eligibility = {
      status: 'eligible',
      reference,
      gatewayId: String(lockedGateway._id),
      environment: lockedEvidence.environment,
      configurationVersion: lockedEvidence.version,
      amountKobo: lockedEvidence.checkout.amountKobo,
      currency: 'NGN',
      provider: 'monnify',
      providerTransactionId: String(transaction.confirmedProviderRef),
      verifiedAt
    }
    const enabled = await PaymentGateway.updateOne(
      {
        _id: lockedGateway._id,
        status: 'inactive',
        isDefault: false,
        environment: lockedEvidence.environment,
        baseUrl: MONNIFY_BASE_URLS[lockedEvidence.environment],
        'metadata.administrativeSandboxOnly': true,
        'metadata.checkoutValidation.status': lockedEvidence.checkout.status,
        ...(lockedEvidence.checkout.status === 'initializing'
          ? {
              'metadata.checkoutValidation.leaseToken': lockedEvidence.checkout.leaseToken,
              'metadata.checkoutValidation.reference': { $exists: false }
            }
          : { 'metadata.checkoutValidation.reference': reference }),
        'metadata.checkoutValidation.gatewayId': String(lockedGateway._id),
        'metadata.checkoutValidation.environment': lockedEvidence.environment,
        'metadata.checkoutValidation.configurationVersion': lockedEvidence.version,
        'metadata.checkoutValidation.expiresAt': { $gt: verifiedAt },
        ...(lockedEvidence.version === 0
          ? {
              $or: [
                { virtualAccountMutationVersion: 0 },
                { virtualAccountMutationVersion: { $exists: false } }
              ]
            }
          : { virtualAccountMutationVersion: lockedEvidence.version })
      },
      {
        $set: {
          'metadata.administrativeSandboxOnly': false,
          'metadata.checkoutValidation': verifiedCheckout,
          'metadata.customerFundingEligibility': eligibility
        }
      },
      { session: mutationSession }
    )
    if (!mutationMatched(enabled)) {
      const error = new Error('The Monnify configuration or checkout evidence changed before customer funding could be enabled.')
      error.code = 'MONNIFY_CUSTOMER_FUNDING_ENABLE_CONFLICT'
      error.statusCode = 409
      throw error
    }

    await AuditLog.create([{
      adminId: req.user?._id || req.user?.id,
      operatorName: admin.name || req.user?.name || 'SuperAdmin',
      action: 'MONNIFY_CUSTOMER_FUNDING_ENABLED',
      target: `Gateway: ${lockedGateway.name}`,
      details: {
        gatewayId: lockedGateway._id,
        reference,
        environment: lockedEvidence.environment,
        configurationVersion: lockedEvidence.version,
        providerTransactionId: eligibility.providerTransactionId,
        status: lockedGateway.status,
        defaultGatewayChanged: false
      },
      result: 'success',
      ipAddress: req.ip || req.headers?.['x-forwarded-for'],
      userAgent: req.headers?.['user-agent']
    }], { session: mutationSession })
    await mutationSession.commitTransaction()
    mutationFinished = true

    lockedGateway.metadata = {
      ...lockedEvidence.metadata,
      administrativeSandboxOnly: false,
      checkoutValidation: verifiedCheckout,
      customerFundingEligibility: eligibility
    }

    return res.json({
      success: true,
      data: sanitizePaymentGateway(lockedGateway),
      eligibility
    })
  } catch (error) {
    if (mutationSession && !mutationFinished) {
      try {
        await mutationSession.abortTransaction()
      } catch (_) {}
      mutationFinished = true
    }
    const transactionConflict =
      error?.code === 112 ||
      error?.codeName === 'WriteConflict' ||
      error?.errorLabels?.includes?.('TransientTransactionError') ||
      error?.errorLabels?.includes?.('UnknownTransactionCommitResult')
    return res.status(transactionConflict ? 409 : (error.statusCode || 400)).json({
      success: false,
      ...(transactionConflict
        ? {
            code: 'MONNIFY_VALIDATION_TRANSACTION_CONFLICT',
            refreshRequired: true
          }
        : (error.code ? { code: error.code } : {})),
      message: transactionConflict
        ? 'The validation state changed while the result was being saved. Refresh the gateway state before continuing.'
        : error.message
    })
  } finally {
    if (mutationSession) {
      if (!mutationFinished) {
        try {
          await mutationSession.abortTransaction()
        } catch (_) {}
      }
      await mutationSession.endSession()
    }
  }
}

/** Freshly verifies and recovers an exact TEST gateway payment from manual review. */
const recoverMonnifyGatewayTest = async (req, res) => {
  try {
    const reference = String(req.body?.reference || '').trim()
    const note = String(req.body?.note || '').trim()
    if (!reference || reference.length > 200) {
      return res.status(400).json({
        success: false,
        code: 'MONNIFY_GATEWAY_TEST_RECOVERY_REFERENCE_INVALID',
        message: 'A valid gateway-test payment reference is required.'
      })
    }
    if (note.length > 500) {
      return res.status(400).json({
        success: false,
        code: 'MONNIFY_GATEWAY_TEST_RECOVERY_NOTE_INVALID',
        message: 'Recovery note cannot exceed 500 characters.'
      })
    }
    if (
      req.body?.confirmation !== MONNIFY_GATEWAY_TEST_RECOVERY_CONFIRMATION
    ) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_GATEWAY_TEST_RECOVERY_CONFIRMATION_REQUIRED',
        message: 'Recovering a TEST Monnify gateway payment requires explicit confirmation.',
        details: {
          requiredConfirmation: MONNIFY_GATEWAY_TEST_RECOVERY_CONFIRMATION
        }
      })
    }

    const admin = await reauthenticateSuperAdmin(req)
    const result = await paymentGatewayService.recoverGatewayTestReconciliation({
      gatewayId: req.params.id,
      reference,
      adminId: req.user?._id || req.user?.id,
      operatorName: admin.name || req.user?.name || 'SuperAdmin',
      note,
      ipAddress: req.ip || req.headers?.['x-forwarded-for'],
      userAgent: req.headers?.['user-agent']
    })
    if (result.status === 'processing') {
      return res.status(202).json({
        ...result,
        code: 'MONNIFY_GATEWAY_TEST_RECOVERY_IN_PROGRESS'
      })
    }
    return res.json({
      ...result,
      code: result.alreadyRecovered
        ? 'MONNIFY_GATEWAY_TEST_ALREADY_RECOVERED'
        : 'MONNIFY_GATEWAY_TEST_RECOVERED',
      message: result.alreadyRecovered
        ? 'This gateway-test payment was already recovered. Continue with Check Eligibility.'
        : 'The paid gateway-test transaction was recovered without wallet credit. Continue with Check Eligibility.'
    })
  } catch (error) {
    const transactionConflict =
      error?.code === 112 ||
      error?.codeName === 'WriteConflict' ||
      error?.errorLabels?.includes?.('TransientTransactionError') ||
      error?.errorLabels?.includes?.('UnknownTransactionCommitResult')
    const providerStatus = String(error?.providerStatus || '').toUpperCase()
    return res.status(transactionConflict ? 409 : (error.statusCode || 400)).json({
      success: false,
      code: transactionConflict
        ? 'MONNIFY_GATEWAY_TEST_RECOVERY_TRANSACTION_CONFLICT'
        : (error.code || 'MONNIFY_GATEWAY_TEST_RECOVERY_FAILED'),
      ...(transactionConflict ? { refreshRequired: true } : {}),
      ...(['PAID', 'PENDING', 'FAILED', 'EXPIRED', 'CANCELLED', 'UNKNOWN'].includes(providerStatus)
        ? { providerStatus }
        : {}),
      message: transactionConflict
        ? 'The recovery state changed while evidence was being saved. Refresh before retrying.'
        : error.message
    })
  }
}

/**
 * DELETE /api/admin/payment-gateways/:id
 * Retained for API compatibility, but persisted gateway configurations are
 * permanent financial records and must be deactivated instead of deleted.
 */
const deleteGateway = async (req, res) => {
  try {
    const { id } = req.params
    const gateway = await loadGatewayForMutation(id, null)
    if (!gateway) {
      return res
        .status(404)
        .json({ success: false, message: 'Payment gateway not found' })
    }

    return res.status(409).json({
      success: false,
      code: 'PAYMENT_GATEWAY_HARD_DELETE_DISABLED',
      message: `Payment gateway '${gateway.name}' is a permanent financial configuration record. Deactivate it to stop new payments while preserving historical verification and reconciliation.`,
      allowedAction: {
        method: 'PATCH',
        path: `/api/admin/payment-gateways/${gateway._id}/status`,
        status: 'inactive'
      }
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

/**
 * GET /api/admin/payment-gateways/reconciliation
 * Returns funding transactions in an intermediate or reconciliation-required state.
 * Read-only visibility for operational audits.
 */
const getReconciliationTransactions = async (req, res) => {
  try {
    const issues = await TransactionStatus.find({
      status: {
        $in: ['processing', 'settlement_pending', 'reconciliation_required']
      }
    })
      .sort({ updatedAt: -1 })
      .limit(100)
      .populate('userId', 'name email phone')
      .lean()

    const formatted = issues.map(tx => {
      const lastUpdated = tx.updatedAt || tx.createdAt || new Date()
      const elapsedMs = Date.now() - new Date(lastUpdated).getTime()
      const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / (1000 * 60)))

      return {
        _id: tx._id,
        reference: tx.refId,
        gateway: tx.provider || 'unknown',
        gatewayId: tx.gatewayId || null,
        type: tx.type,
        status: tx.status,
        recoveryAvailable:
          tx.status === 'reconciliation_required' &&
          tx.type === 'gateway_test' &&
          String(tx.provider || '').toLowerCase() === 'monnify' &&
          Boolean(tx.gatewayId),
        user: tx.userId
          ? {
              _id: tx.userId._id,
              name: tx.userId.name || 'User',
              email: tx.userId.email || '',
              phone: tx.userId.phone || ''
            }
          : null,
        expectedAmount: Number.isSafeInteger(tx.amountKobo)
          ? tx.amountKobo / 100
          : tx.amount,
        confirmedAmount: tx.confirmedAmountKobo
          ? tx.confirmedAmountKobo / 100
          : null,
        expectedCurrency: tx.expectedCurrency || null,
        confirmedCurrency: tx.confirmedCurrency || null,
        confirmedProviderRef: tx.confirmedProviderRef || null,
        reconciliationReason: tx.reconciliationReason || null,
        elapsedMinutes,
        createdAt: tx.createdAt,
        updatedAt: tx.updatedAt
      }
    })

    res.json({
      success: true,
      data: formatted,
      count: formatted.length
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

/**
 * GET /api/admin/payment-gateways/capabilities
 * Returns the safe adapter capability registry — adapter codes, labels, supported channels,
 * credential field descriptors, and metadata field descriptors.
 * Does NOT expose any credentials, secrets, or configured values.
 * Accessible to admin and superAdmin.
 */
const getAdapterCapabilities = async (req, res) => {
  try {
    res.json({
      success: true,
      data: getPublicCapabilities()
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

/**
 * GET /api/wallet/funding-methods
 * Client-facing endpoint returning all active payment gateways and enabled channels.
 */
const getFundingMethods = async (req, res) => {
  try {
    const activeGateways = await paymentGatewayService.getActiveGateways()
    const sanitized = activeGateways.map(g =>
      sanitizePaymentGatewayForClient(g)
    )
    res.json({ success: true, data: sanitized })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

/**
 * POST /api/admin/payment-gateways/reconciliation/resolve
 * SuperAdmin-only writable reconciliation: settles a TransactionStatus stuck in
 * 'processing' (the finalizeFundingCredit crash window) to 'success' with
 * exactly-once credit / share fulfillment. Non-processing records, mismatched
 * amounts, and non-whole-share investments are rejected for manual review.
 */
const resolveReconciliationTransaction = async (req, res) => {
  const { reference, note } = req.body || {}
  if (!reference) {
    return res
      .status(400)
      .json({ success: false, message: 'reference is required' })
  }

  const adminId = req.user?._id || req.user?.id
  const operatorName = req.user?.name || req.user?.email || 'SuperAdmin'

  try {
    const result = await paymentGatewayService.adminSettleProcessing({
      refId: reference,
      adminId,
      note: note || ''
    })

    try {
      await logAction(
        adminId,
        operatorName,
        'PAYMENT_GATEWAY_RECONCILIATION_RESOLVED',
        `Reference ${reference} settled to success`,
        {
          reference,
          status: result.status,
          credited: result.credited,
          type: result.type,
          amount: result.amount || null
        },
        result.settled ? 'success' : 'warning',
        req
      )
    } catch (auditErr) {
      console.error('[Admin Reconciliation Audit Error]', auditErr.message)
    }

    return res.json({ success: true, ...result })
  } catch (err) {
    console.error('[Admin Reconciliation Resolve Error]', err.message)
    try {
      await logAction(
        adminId,
        operatorName,
        'PAYMENT_GATEWAY_RECONCILIATION_RESOLVE_FAILED',
        `Reference ${reference} settlement rejected`,
        { reference, error: err.message },
        'failure',
        req
      )
    } catch (auditErr) {
      console.error('[Admin Reconciliation Audit Error]', auditErr.message)
    }
    return res.status(400).json({ success: false, message: err.message })
  }
}

module.exports = {
  getAllGateways,
  getGatewayById,
  getAdapterCapabilities,
  createGateway,
  updateGateway,
  updateGatewayStatus,
  setDefaultGateway,
  testGatewayConnection,
  replaceMonnifyMerchant,
  testMonnifyHostedCheckout,
  enableMonnifyCustomerFunding,
  recoverMonnifyGatewayTest,
  deleteGateway,
  getReconciliationTransactions,
  resolveReconciliationTransaction,
  getFundingMethods
}
