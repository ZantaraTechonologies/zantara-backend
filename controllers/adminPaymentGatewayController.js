'use strict'

const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const PaymentGateway = require('../models/PaymentGateway')
const TransactionStatus = require('../models/TransactionStatus')
const WebhookEvent = require('../models/WebhookEvent')
const User = require('../models/User')
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

const MONNIFY_SANDBOX_BASE_URL = 'https://sandbox.monnify.com'
const MONNIFY_REPLACEMENT_CONFIRMATION = 'replace-monnify-merchant'
const MONNIFY_CHECKOUT_VALIDATED_MESSAGE =
  'Monnify sandbox hosted checkout initialized successfully'

async function loadGatewayForMutation (id, session) {
  let query = PaymentGateway.findById(id)
  if (typeof query?.select === 'function') {
    query = query.select(
      '+webhookVerificationSnapshots +virtualAccountMutationVersion'
    )
  }
  return queryWithSession(query, session)
}

function validateGatewayUpdatePlan (gateway, changePlan, body) {
  const nextStatus = body.status === undefined ? gateway.status : body.status
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
    body.isDefault === true &&
    isAdministrativeSandboxOnly(changePlan.next.metadata)
  ) {
    return administrativeSandboxDefaultError()
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
    changePlan.currentAdapter === 'monnify' &&
    changePlan.metadataChanges.includes('administrativeSandboxOnly')
  ) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'MONNIFY_SANDBOX_ISOLATION_IMMUTABLE',
        message: 'Monnify administrative sandbox isolation cannot be changed through ordinary gateway updates.'
      }
    }
  }
  if (
    changePlan.currentAdapter === 'monnify' &&
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
    changePlan.currentAdapter === 'monnify' &&
    gateway.status !== 'active' &&
    nextStatus === 'active' &&
    changePlan.next.environment === 'test' &&
    (
      changePlan.verificationChanges.length > 0 ||
      gateway.lastHealthCheck?.status !== 'online' ||
      gateway.lastHealthCheck?.message !== MONNIFY_CHECKOUT_VALIDATED_MESSAGE
    )
  ) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'MONNIFY_SANDBOX_CHECKOUT_VALIDATION_REQUIRED',
        message:
          'Initialize a successful SuperAdmin Monnify sandbox checkout before activating this gateway.'
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

    const normalizedCode = code.toLowerCase().trim()
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

    const gateway = await PaymentGateway.create({
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
      baseUrl: baseUrl.trim(),
      supportedChannels,
      metadata: metadata || {}
    })

    if (isDefault && status === 'active') {
      await PaymentGateway.setDefault(gateway._id)
      gateway.isDefault = true
    }

    // Audit Logging (NEVER logging credentials)
    const adminId = req.user?._id || req.user?.id
    const operatorName = req.user?.name || req.user?.email || 'SuperAdmin'
    await logAction(
      adminId,
      operatorName,
      'PAYMENT_GATEWAY_CREATED',
      `Gateway: ${gateway.name}`,
      {
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
      'success',
      req
    )

    res
      .status(201)
      .json({ success: true, data: sanitizePaymentGateway(gateway) })
  } catch (error) {
    res.status(400).json({ success: false, message: error.message })
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
      changePlan.currentAdapter === 'monnify' &&
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

    if (changePlan.requiresMutationFence) {
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
      currentAdapter === 'monnify' &&
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

    if (currentAdapter === 'monnify' && changePlan.verificationChanges.length > 0) {
      gateway.lastHealthCheck = {
        status: 'unknown',
        checkedAt: new Date(),
        message: 'Monnify hosted checkout validation is required after configuration changes'
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

    if (mutationSession) {
      await mutationSession.commitTransaction()
      mutationFinished = true
    }

    // Audit Logging
    const adminId = req.user?._id || req.user?.id
    const operatorName = req.user?.name || req.user?.email || 'SuperAdmin'

    if (isPublicKeyRotated || isSecretRotated || isWebhookRotated) {
      await logAction(
        adminId,
        operatorName,
        'PAYMENT_GATEWAY_CREDENTIALS_ROTATED',
        `Gateway: ${gateway.name}`,
        {
          gatewayId: gateway._id,
          name: gateway.name,
          publicKeyUpdated: isPublicKeyRotated,
          secretKeyUpdated: isSecretRotated,
          webhookSecretUpdated: isWebhookRotated
        },
        'success',
        req
      )
    }

    if (isEnvChanged) {
      await logAction(
        adminId,
        operatorName,
        'PAYMENT_GATEWAY_ENVIRONMENT_CHANGED',
        `Gateway: ${gateway.name}`,
        {
          gatewayId: gateway._id,
          name: gateway.name,
          previousEnv,
          newEnv: gateway.environment
        },
        'success',
        req
      )
    }

    if (isStatusChanged) {
      await logAction(
        adminId,
        operatorName,
        'PAYMENT_GATEWAY_STATUS_CHANGED',
        `Gateway: ${gateway.name}`,
        {
          gatewayId: gateway._id,
          name: gateway.name,
          previousStatus,
          newStatus: gateway.status
        },
        'success',
        req
      )
    }

    await logAction(
      adminId,
      operatorName,
      'PAYMENT_GATEWAY_UPDATED',
      `Gateway: ${gateway.name}`,
      {
        gatewayId: gateway._id,
        name: gateway.name,
        status: gateway.status,
        environment: gateway.environment,
        isDefault: gateway.isDefault
      },
      'success',
      req
    )

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

    const gateway = await loadGatewayForMutation(id, null)
    if (!gateway) {
      return res
        .status(404)
        .json({ success: false, message: 'Payment gateway not found' })
    }

    const changePlan = buildGatewayChangePlan(gateway, { status })
    const validation = validateGatewayUpdatePlan(gateway, changePlan, { status })
    if (validation) return res.status(validation.status).json(validation.body)

    const oldStatus = gateway.status
    const isMonnifySandboxActivation =
      String(gateway.adapterType || '').toLowerCase() === 'monnify' &&
      gateway.environment === 'test' &&
      oldStatus !== 'active' &&
      status === 'active'
    if (isMonnifySandboxActivation) {
      const version = Number(gateway.virtualAccountMutationVersion || 0)
      const activated = await PaymentGateway.updateOne(
        {
          _id: gateway._id,
          status: oldStatus,
          environment: 'test',
          'lastHealthCheck.status': 'online',
          'lastHealthCheck.message': MONNIFY_CHECKOUT_VALIDATED_MESSAGE,
          ...(version === 0
            ? {
                $or: [
                  { virtualAccountMutationVersion: 0 },
                  { virtualAccountMutationVersion: { $exists: false } }
                ]
              }
            : { virtualAccountMutationVersion: version })
        },
        { $set: { status: 'active' } }
      )
      if (!mutationMatched(activated)) {
        return res.status(409).json({
          success: false,
          code: 'MONNIFY_SANDBOX_CHECKOUT_VALIDATION_REQUIRED',
          message: 'The validated Monnify configuration changed before activation. Initialize another sandbox checkout.'
        })
      }
      gateway.status = 'active'
    } else {
      gateway.status = status
      if (status !== 'active' && gateway.isDefault) {
        gateway.isDefault = false
      }
      await gateway.save()
    }

    const adminId = req.user?._id || req.user?.id
    const operatorName = req.user?.name || req.user?.email || 'SuperAdmin'
    await logAction(
      adminId,
      operatorName,
      'PAYMENT_GATEWAY_STATUS_CHANGED',
      `Gateway: ${gateway.name}`,
      {
        gatewayId: gateway._id,
        name: gateway.name,
        oldStatus,
        newStatus: status,
        isDefault: gateway.isDefault
      },
      'success',
      req
    )

    res.json({ success: true, data: sanitizePaymentGateway(gateway) })
  } catch (error) {
    res.status(400).json({ success: false, message: error.message })
  }
}

/**
 * POST /api/admin/payment-gateways/:id/set-default
 * SuperAdmin-only endpoint to designate a gateway as the platform default.
 * Enforces: Gateway must be active. Uses concurrency-safe PaymentGateway.setDefault().
 */
const setDefaultGateway = async (req, res) => {
  try {
    const { id } = req.params
    const gateway = await PaymentGateway.findById(id)
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

    await PaymentGateway.setDefault(gateway._id)
    const updated = await PaymentGateway.findById(id)

    const adminId = req.user?._id || req.user?.id
    const operatorName = req.user?.name || req.user?.email || 'SuperAdmin'
    await logAction(
      adminId,
      operatorName,
      'PAYMENT_GATEWAY_DEFAULT_CHANGED',
      `Gateway: ${gateway.name}`,
      {
        gatewayId: gateway._id,
        name: gateway.name
      },
      'success',
      req
    )

    res.json({ success: true, data: sanitizePaymentGateway(updated) })
  } catch (error) {
    res.status(400).json({ success: false, message: error.message })
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

    const preserveCheckoutValidation =
      result.success &&
      String(gateway.adapterType || '').toLowerCase() === 'monnify' &&
      gateway.environment === 'test' &&
      gateway.lastHealthCheck?.status === 'online' &&
      gateway.lastHealthCheck?.message === MONNIFY_CHECKOUT_VALIDATED_MESSAGE
    const nextHealthCheck = {
      status: result.success ? 'online' : 'offline',
      checkedAt: new Date(),
      message: preserveCheckoutValidation
        ? MONNIFY_CHECKOUT_VALIDATED_MESSAGE
        : result.message ||
          (result.success ? 'Connection successful' : 'Connection failed')
    }
    if (preserveCheckoutValidation) {
      const version = Number(gateway.virtualAccountMutationVersion || 0)
      const preserved = await PaymentGateway.updateOne(
        {
          _id: gateway._id,
          environment: 'test',
          'lastHealthCheck.status': 'online',
          'lastHealthCheck.message': MONNIFY_CHECKOUT_VALIDATED_MESSAGE,
          ...(version === 0
            ? {
                $or: [
                  { virtualAccountMutationVersion: 0 },
                  { virtualAccountMutationVersion: { $exists: false } }
                ]
              }
            : { virtualAccountMutationVersion: version })
        },
        { $set: { lastHealthCheck: nextHealthCheck } }
      )
      if (!mutationMatched(preserved)) {
        return res.status(409).json({
          success: false,
          code: 'PAYMENT_GATEWAY_CONFIGURATION_CHANGED',
          message: 'The gateway configuration changed during connection testing. Retry against the current configuration.'
        })
      }
      gateway.lastHealthCheck = nextHealthCheck
    } else {
      gateway.lastHealthCheck = nextHealthCheck
      await gateway.save()
    }

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

    if (req.body?.confirmation !== MONNIFY_REPLACEMENT_CONFIRMATION) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_MERCHANT_REPLACEMENT_CONFIRMATION_REQUIRED',
        message: 'Explicit Monnify merchant replacement confirmation is required.',
        details: { requiredConfirmation: MONNIFY_REPLACEMENT_CONFIRMATION }
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
      environment: 'test',
      publicKey,
      secretKey,
      webhookSecret,
      baseUrl: MONNIFY_SANDBOX_BASE_URL,
      metadata: { ...currentMetadata, contractCode }
    }
    const connection = await paymentGatewayService
      .getAdapterInstance(candidate)
      .testConnection()
    if (!connection?.success) {
      return res.status(422).json({
        success: false,
        code: 'MONNIFY_MERCHANT_VALIDATION_FAILED',
        message: 'The new Monnify sandbox credentials could not be authenticated. No configuration was changed.'
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
    gateway.baseUrl = MONNIFY_SANDBOX_BASE_URL
    gateway.environment = 'test'
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
      message: 'Candidate Monnify sandbox credentials authenticated; hosted checkout validation required'
    }
    await gateway.save({ session: mutationSession })
    await mutationSession.commitTransaction()
    mutationFinished = true

    const adminId = req.user?._id || req.user?.id
    const operatorName = admin.name || req.user?.name || 'SuperAdmin'
    await logAction(
      adminId,
      operatorName,
      'MONNIFY_MERCHANT_REPLACED',
      `Gateway: ${gateway.name}`,
      {
        gatewayId: gateway._id,
        code: gateway.code,
        environment: gateway.environment,
        status: gateway.status,
        previousReservedAccountUsers: archived.users,
        newlyArchivedReservedAccounts: archived.archivedAccounts,
        defaultGatewayChanged: false
      },
      'success',
      req
    )

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

/**
 * POST /api/admin/payment-gateways/:id/test-monnify-checkout
 * Starts one sandbox checkout for the reauthenticated SuperAdmin without
 * changing the gateway default or exposing gateway selection to wallet clients.
 */
const testMonnifyHostedCheckout = async (req, res) => {
  try {
    const admin = await reauthenticateSuperAdmin(req)
    const gateway = await loadGatewayForMutation(req.params.id, null)
    if (!gateway) {
      return res.status(404).json({ success: false, message: 'Payment gateway not found' })
    }
    if (
      String(gateway.code || '').toLowerCase() !== 'monnify' ||
      String(gateway.adapterType || '').toLowerCase() !== 'monnify' ||
      gateway.environment !== 'test' ||
      String(gateway.baseUrl || '').replace(/\/+$/, '') !== MONNIFY_SANDBOX_BASE_URL
    ) {
      return res.status(409).json({
        success: false,
        code: 'MONNIFY_SANDBOX_CHECKOUT_GATEWAY_INVALID',
        message: 'Hosted checkout testing is restricted to the Monnify sandbox gateway.'
      })
    }
    if (gateway.status !== 'inactive') {
      return res.status(409).json({
        success: false,
        code: gateway.status === 'maintenance'
          ? 'MONNIFY_SANDBOX_CHECKOUT_MAINTENANCE'
          : 'MONNIFY_SANDBOX_CHECKOUT_REQUIRES_INACTIVE',
        message: gateway.status === 'maintenance'
          ? 'Leave maintenance mode before starting a hosted checkout test.'
          : 'The Monnify sandbox gateway must remain inactive during checkout validation.'
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
        code: 'MONNIFY_SANDBOX_CHECKOUT_AMOUNT_INVALID',
        message: 'Sandbox checkout amount must be between N50 and N5,000 with at most two decimal places.'
      })
    }

    const result = await paymentGatewayService.initializeFunding({
      gatewayCode: 'monnify',
      requiredGatewayId: String(gateway._id),
      requiredEnvironment: 'test',
      requiredStatus: 'inactive',
      requiredMutationVersion: Number(gateway.virtualAccountMutationVersion || 0),
      allowInactiveGateway: true,
      administrativeSandboxTest: true,
      user: {
        _id: admin._id,
        name: admin.name,
        email: admin.email,
        phone: admin.phone
      },
      amount,
      metadata: { administrativeSandboxTest: true }
    })

    const markerVersion = Number(gateway.virtualAccountMutationVersion || 0)
    const marker = await PaymentGateway.updateOne(
      {
        _id: gateway._id,
        status: 'inactive',
        environment: 'test',
        baseUrl: gateway.baseUrl,
        ...(markerVersion === 0
          ? {
              $or: [
                { virtualAccountMutationVersion: 0 },
                { virtualAccountMutationVersion: { $exists: false } }
              ]
            }
          : { virtualAccountMutationVersion: markerVersion })
      },
      {
        $set: {
          lastHealthCheck: {
            status: 'online',
            checkedAt: new Date(),
            message: MONNIFY_CHECKOUT_VALIDATED_MESSAGE
          }
        }
      }
    )
    if (!mutationMatched(marker)) {
      const error = new Error('The Monnify gateway changed during checkout initialization. It remains inactive and unvalidated.')
      error.statusCode = 409
      error.code = 'MONNIFY_SANDBOX_CHECKOUT_CONFIGURATION_CHANGED'
      error.status = 'pending'
      error.reference = result.reference
      throw error
    }

    await logAction(
      req.user?._id || req.user?.id,
      admin.name || req.user?.name || 'SuperAdmin',
      'MONNIFY_SANDBOX_CHECKOUT_INITIALIZED',
      `Gateway: ${gateway.name}`,
      {
        gatewayId: gateway._id,
        reference: result.reference,
        amount,
        environment: 'test',
        defaultGatewayChanged: false
      },
      'success',
      req
    )

    return res.json({
      success: true,
      authorizationUrl: result.authorizationUrl,
      reference: result.reference,
      provider: result.provider,
      environment: 'test'
    })
  } catch (error) {
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
  }
}

/**
 * DELETE /api/admin/payment-gateways/:id
 * SuperAdmin-only endpoint to remove a gateway.
 * SAFETY RULE: Prevents deletion if any historical transactions or webhooks reference this gateway code.
 */
const deleteGateway = async (req, res) => {
  let mutationSession = null
  let mutationFinished = false
  try {
    const { id } = req.params
    mutationSession = await mongoose.startSession()
    mutationSession.startTransaction()
    const gateway = await loadGatewayForMutation(id, mutationSession)
    if (!gateway) {
      return res
        .status(404)
        .json({ success: false, message: 'Payment gateway not found' })
    }

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

    const referenceFilter = virtualAccountReferenceFilter(gateway)
    const txCount = await queryWithSession(
      TransactionStatus.countDocuments({ provider: gateway.code }),
      mutationSession
    )
    const whCount = await queryWithSession(
      WebhookEvent.countDocuments({ provider: gateway.code }),
      mutationSession
    )
    const virtualAccountUsers = referenceFilter
      ? await queryWithSession(
          User.countDocuments(referenceFilter),
          mutationSession
        )
      : 0

    if (txCount > 0 || whCount > 0 || virtualAccountUsers > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete gateway '${gateway.name}' because it is bound to historical financial records (${txCount} transactions, ${whCount} webhooks, ${virtualAccountUsers} virtual-account users). Deactivate the gateway instead.`
      })
    }

    await PaymentGateway.findByIdAndDelete(id, { session: mutationSession })
    await mutationSession.commitTransaction()
    mutationFinished = true

    const adminId = req.user?._id || req.user?.id
    const operatorName = req.user?.name || req.user?.email || 'SuperAdmin'
    await logAction(
      adminId,
      operatorName,
      'PAYMENT_GATEWAY_DELETED',
      `Gateway: ${gateway.name}`,
      {
        gatewayId: gateway._id,
        name: gateway.name,
        code: gateway.code
      },
      'success',
      req
    )

    res.json({
      success: true,
      message: `Gateway '${gateway.name}' deleted successfully.`
    })
  } catch (error) {
    if (mutationSession && !mutationFinished) {
      try {
        await mutationSession.abortTransaction()
      } catch (_) {}
      mutationFinished = true
    }
    res.status(500).json({ success: false, message: error.message })
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
        status: tx.status,
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
  deleteGateway,
  getReconciliationTransactions,
  resolveReconciliationTransaction,
  getFundingMethods
}
