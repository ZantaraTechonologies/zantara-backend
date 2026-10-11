'use strict'

const mongoose = require('mongoose')
const PaymentGateway = require('../models/PaymentGateway')
const TransactionStatus = require('../models/TransactionStatus')
const WebhookEvent = require('../models/WebhookEvent')
const User = require('../models/User')
const paymentGatewayService = require('../services/paymentGateway.service')
const {
  sanitizePaymentGateway,
  sanitizePaymentGatewayForClient
} = require('../utils/paymentGatewaySerializer')
const { encryptSecret, isEncrypted } = require('../utils/crypto')
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

const queryWithSession = (query, session) =>
  session && typeof query?.session === 'function'
    ? query.session(session)
    : query

const mutationMatched = result =>
  Number(result?.matchedCount ?? result?.n ?? 0) === 1

async function loadGatewayForMutation (id, session) {
  let query = PaymentGateway.findById(id)
  if (typeof query?.select === 'function') {
    query = query.select(
      '+webhookVerificationSnapshots +virtualAccountMutationVersion'
    )
  }
  return queryWithSession(query, session)
}

function requiresGatewayMutationFence (gateway, body = {}) {
  const nonBlank = value => typeof value === 'string' && value.trim() !== ''
  return (
    (body.adapterType !== undefined &&
      String(body.adapterType).toLowerCase() !==
        String(gateway.adapterType || '').toLowerCase()) ||
    (body.baseUrl !== undefined &&
      body.baseUrl.trim() !== String(gateway.baseUrl || '')) ||
    (body.publicKey !== undefined &&
      body.publicKey.trim() !== String(gateway.publicKey || '')) ||
    nonBlank(body.secretKey) ||
    nonBlank(body.webhookSecret) ||
    (body.environment !== undefined &&
      body.environment !== gateway.environment) ||
    body.metadata !== undefined
  )
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
  if (String(gateway.code || '').toLowerCase() === 'monnify') {
    return {
      $or: [
        { virtualAccounts: { $elemMatch: { provider: 'monnify' } } },
        {
          virtualAccounts: {
            $elemMatch: {
              provider: { $exists: false },
              accountNumber: { $exists: true }
            }
          }
        }
      ]
    }
  }
  if (adapterType === 'monnify') {
    return {
      virtualAccounts: {
        $elemMatch: {
          provider: 'monnify',
          gatewayId: String(gateway._id)
        }
      }
    }
  }
  return null
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
    const gateway = await PaymentGateway.findById(id)
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
      environment: environment === 'live' ? 'live' : 'test',
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

    if (requiresGatewayMutationFence(gateway, req.body)) {
      mutationSession = await mongoose.startSession()
      mutationSession.startTransaction()
      gateway = await loadGatewayForMutation(id, mutationSession)
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
      gateway.virtualAccountMutationVersion =
        Number(gateway.virtualAccountMutationVersion || 0) + 1
    }

    let isSecretRotated = false
    let isWebhookRotated = false
    let isEnvChanged = false
    let isStatusChanged = false
    const previousEnv = gateway.environment
    const previousStatus = gateway.status
    const currentAdapter = String(gateway.adapterType || '').toLowerCase()
    const requestedAdapter = adapterType
      ? String(adapterType).toLowerCase()
      : currentAdapter
    const isPaystack = currentAdapter === 'paystack'
    const paystackVerificationChanged =
      isPaystack &&
      ((secretKey &&
        typeof secretKey === 'string' &&
        secretKey.trim() !== '') ||
        (webhookSecret &&
          typeof webhookSecret === 'string' &&
          webhookSecret.trim() !== '') ||
        (baseUrl !== undefined &&
          baseUrl.trim() !== String(gateway.baseUrl || '')) ||
        (environment && environment !== gateway.environment))
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

    const verificationConfigChanged =
      (adapterType && adapterType.toLowerCase() !== gateway.adapterType) ||
      baseUrl !== undefined ||
      publicKey !== undefined ||
      (secretKey && typeof secretKey === 'string' && secretKey.trim() !== '') ||
      (webhookSecret &&
        typeof webhookSecret === 'string' &&
        webhookSecret.trim() !== '') ||
      (environment && environment !== gateway.environment) ||
      metadata !== undefined
    if (verificationConfigChanged) {
      // Recent pending payments remain protected because they may still complete.
      // Old pending attempts are treated as abandoned for gateway-configuration
      // purposes, but remain in the database for audit and possible late provider
      // reconciliation. Transactions that have entered processing, settlement,
      // or reconciliation-required states always remain blocking.
      const pendingPaymentCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)

      const unresolvedPayments = await queryWithSession(
        TransactionStatus.countDocuments({
          provider: gateway.code,
          $or: [
            {
              status: {
                $in: [
                  'processing',
                  'settlement_pending',
                  'reconciliation_required'
                ]
              }
            },
            {
              status: 'pending',
              createdAt: { $gte: pendingPaymentCutoff }
            }
          ]
        }),
        mutationSession
      )

      if (unresolvedPayments > 0) {
        return res.status(409).json({
          success: false,
          message: `Cannot change gateway verification settings while ${unresolvedPayments} payment(s) remain unresolved.`
        })
      }
    }

    if (paystackVerificationChanged) {
      const snapshot = paymentGatewayService._snapshotGatewayConfig(gateway)
      const hydratedSnapshot =
        paymentGatewayService._hydrateGatewayCredentials(snapshot)
      const unreadableSecret =
        !hydratedSnapshot.secretKey || isEncrypted(hydratedSnapshot.secretKey)
      const unreadableWebhookSecret =
        snapshot.webhookSecret &&
        (!hydratedSnapshot.webhookSecret ||
          isEncrypted(hydratedSnapshot.webhookSecret))
      if (
        paystackDvaUsers > 0 &&
        (unreadableSecret || unreadableWebhookSecret)
      ) {
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
      const nextWebhookSecret =
        webhookSecret &&
        typeof webhookSecret === 'string' &&
        webhookSecret.trim() !== ''
          ? webhookSecret.trim()
          : hydratedSnapshot.webhookSecret
      const currentSigningSecret =
        hydratedSnapshot.webhookSecret || hydratedSnapshot.secretKey
      const nextSigningSecret = nextWebhookSecret || nextSecretKey
      const apiContextChanged =
        nextSecretKey !== hydratedSnapshot.secretKey ||
        (baseUrl !== undefined &&
          baseUrl.trim() !== String(hydratedSnapshot.baseUrl || '')) ||
        (environment && environment !== hydratedSnapshot.environment)
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
      gateway.webhookVerificationSnapshots = [
        ...(Array.isArray(gateway.webhookVerificationSnapshots)
          ? gateway.webhookVerificationSnapshots
          : []),
        snapshot
      ]
      gateway.markModified('webhookVerificationSnapshots')
    }

    const virtualAccountConfigChanged =
      currentAdapter === 'monnify' &&
      ((adapterType && adapterType.toLowerCase() !== gateway.adapterType) ||
        baseUrl !== undefined ||
        publicKey !== undefined ||
        (environment && environment !== gateway.environment) ||
        metadata !== undefined)
    if (virtualAccountConfigChanged) {
      const virtualAccountUsers = await queryWithSession(
        User.countDocuments(virtualAccountReferenceFilter(gateway)),
        mutationSession
      )
      if (virtualAccountUsers > 0) {
        return res.status(409).json({
          success: false,
          message: `Cannot change Monnify account routing while ${virtualAccountUsers} user(s) have reserved accounts.`
        })
      }
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
      gateway.adapterType = adapterType.toLowerCase()
    }

    if (baseUrl !== undefined) gateway.baseUrl = baseUrl.trim()
    if (publicKey !== undefined) gateway.publicKey = publicKey.trim()
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

    if (metadata && typeof metadata === 'object') {
      gateway.metadata = { ...(gateway.metadata || {}), ...metadata }
      gateway.markModified('metadata')
    }

    // Credentials Rotation: Update ONLY if non-empty string provided.
    // Blank string or undefined means "retain current configured secret".
    if (secretKey && typeof secretKey === 'string' && secretKey.trim() !== '') {
      gateway.secretKey = isEncrypted(secretKey.trim())
        ? secretKey.trim()
        : encryptSecret(secretKey.trim())
      isSecretRotated = true
    }

    if (
      webhookSecret &&
      typeof webhookSecret === 'string' &&
      webhookSecret.trim() !== ''
    ) {
      gateway.webhookSecret = isEncrypted(webhookSecret.trim())
        ? webhookSecret.trim()
        : encryptSecret(webhookSecret.trim())
      isWebhookRotated = true
    }

    // Environment Switch Tracking
    if (environment && environment !== gateway.environment) {
      if (!['test', 'live'].includes(environment)) {
        return res.status(400).json({
          success: false,
          message: "Environment must be 'test' or 'live'"
        })
      }
      gateway.environment = environment
      isEnvChanged = true
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
      if (gateway.status !== 'active') {
        return res.status(400).json({
          success: false,
          message: `Cannot set gateway '${gateway.name}' as default because it is not active. Please activate it first.`
        })
      }
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

    if (isSecretRotated || isWebhookRotated) {
      await logAction(
        adminId,
        operatorName,
        'PAYMENT_GATEWAY_CREDENTIALS_ROTATED',
        `Gateway: ${gateway.name}`,
        {
          gatewayId: gateway._id,
          name: gateway.name,
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

    const gateway = await PaymentGateway.findById(id)
    if (!gateway) {
      return res
        .status(404)
        .json({ success: false, message: 'Payment gateway not found' })
    }

    const oldStatus = gateway.status
    gateway.status = status

    if (status !== 'active' && gateway.isDefault) {
      gateway.isDefault = false
    }

    await gateway.save()

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
    const gateway = await PaymentGateway.findById(id)
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

    gateway.lastHealthCheck = {
      status: result.success ? 'online' : 'offline',
      checkedAt: new Date(),
      message:
        result.message ||
        (result.success ? 'Connection successful' : 'Connection failed')
    }
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
  deleteGateway,
  getReconciliationTransactions,
  resolveReconciliationTransaction,
  getFundingMethods
}
