'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const bcrypt = require('bcryptjs')
const mongoose = require('mongoose')
const PaymentGateway = require('../models/PaymentGateway')
const TransactionStatus = require('../models/TransactionStatus')
const Transaction = require('../models/Transaction')
const WalletLedger = require('../models/WalletLedger')
const User = require('../models/User')
const AuditLog = require('../models/AuditLog')
const controller = require('../controllers/adminPaymentGatewayController')
const walletFundingController = require('../controllers/walletFundingController')
const paymentGatewayService = require('../services/paymentGateway.service')
const walletService = require('../services/wallet.service')
const notificationService = require('../services/notification.service')
const {
  VirtualAccountService,
  MongoVirtualAccountRepository
} = require('../services/virtualAccount.service')
const { decryptSecret, encryptSecret } = require('../utils/crypto')

function queryResult (value) {
  return {
    select () { return this },
    session () { return this },
    then (resolve, reject) { return Promise.resolve(value).then(resolve, reject) }
  }
}

function response () {
  return {
    statusCode: 200,
    body: null,
    status (code) { this.statusCode = code; return this },
    json (body) { this.body = body; return this }
  }
}

function transactionSession (state = {}) {
  return {
    startTransaction () { state.started = true },
    async commitTransaction () { state.committed = true },
    async abortTransaction () { state.aborted = true },
    async endSession () { state.ended = true }
  }
}

function request (gateway, body = {}) {
  return {
    params: { id: gateway._id },
    body,
    user: { id: 'admin-monnify-replacement', name: 'Test SuperAdmin' },
    headers: {},
    ip: '127.0.0.1'
  }
}

function gatewayFixture () {
  return {
    _id: 'gateway-monnify',
    name: 'Monnify',
    code: 'monnify',
    adapterType: 'monnify',
    status: 'inactive',
    environment: 'test',
    isDefault: false,
    priority: 2,
    publicKey: 'MK_OLD',
    secretKey: encryptSecret('old-secret'),
    webhookSecret: encryptSecret('old-webhook'),
    baseUrl: 'https://sandbox.monnify.com',
    supportedChannels: ['card', 'bank_transfer'],
    metadata: {
      contractCode: '1111111111',
      label: 'Existing',
      administrativeSandboxOnly: true
    },
    webhookVerificationSnapshots: [],
    virtualAccountMutationVersion: 3,
    markModified () {},
    async save () { return this }
  }
}

function approveGatewayForCustomerFunding (gateway) {
  const reference = 'MNFY_APPROVED_TEST'
  const providerTransactionId = 'MNFY_APPROVED_PROVIDER_TX'
  const version = Number(gateway.virtualAccountMutationVersion || 0)
  gateway.metadata = {
    ...gateway.metadata,
    administrativeSandboxOnly: false,
    checkoutValidation: {
      status: 'verified',
      reference,
      gatewayId: gateway._id,
      environment: gateway.environment,
      configurationVersion: version,
      amountKobo: 10000,
      currency: 'NGN',
      provider: 'monnify',
      providerTransactionId
    },
    customerFundingEligibility: {
      status: 'eligible',
      reference,
      gatewayId: gateway._id,
      environment: gateway.environment,
      configurationVersion: version,
      amountKobo: 10000,
      currency: 'NGN',
      provider: 'monnify',
      providerTransactionId
    }
  }
}

function replacementBody (overrides = {}) {
  return {
    publicKey: 'MK_NEW',
    secretKey: 'new-secret',
    webhookSecret: 'new-webhook',
    contractCode: '2222222222',
    currentPassword: 'correct-password',
    confirmation: 'replace-monnify-merchant',
    ...overrides
  }
}

function monnifyOwner (gateway, references) {
  return {
    _id: 'reserved-owner',
    virtualAccounts: references.map((accountReference, index) => ({
      provider: 'monnify',
      gatewayId: gateway._id,
      accountReference,
      accountNumber: `123456789${index}`,
      provisioningStatus: 'active',
      active: true,
      assigned: true,
      currency: 'NGN'
    })),
    virtualAccountGatewaySnapshots: new Map()
  }
}

function setMonnifyEnvironment (t, values = {}) {
  const keys = [
    'MONNIFY_API_KEY',
    'MONNIFY_SECRET_KEY',
    'MONNIFY_WEBHOOK_SECRET'
  ]
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key]
    else process.env[key] = values[key]
  }
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
}

async function executeReplacement (t, {
  gateway,
  owners = [],
  unresolvedPayments = 0,
  body = replacementBody(),
  auditFailure = false
}) {
  const password = await bcrypt.hash('correct-password', 4)
  const originals = {
    gatewayFindById: PaymentGateway.findById,
    gatewayUpdateOne: PaymentGateway.updateOne,
    txCount: TransactionStatus.countDocuments,
    userFindById: User.findById,
    userFind: User.find,
    userUpdateOne: User.updateOne,
    auditCreate: AuditLog.create,
    startSession: mongoose.startSession,
    getAdapterInstance: paymentGatewayService.getAdapterInstance
  }
  const snapshotUpdates = []
  let adapterCalls = 0
  let sessionStarted = false
  let committed = false
  let aborted = false
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.updateOne = async () => ({ matchedCount: 1 })
  TransactionStatus.countDocuments = async () => unresolvedPayments
  User.findById = () => queryResult({
    _id: 'admin-monnify-replacement',
    name: 'Test SuperAdmin',
    password,
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin']
  })
  User.find = () => queryResult(owners)
  User.updateOne = async (filter, update) => {
    snapshotUpdates.push({ filter, update })
    return { matchedCount: 1 }
  }
  AuditLog.create = async value => {
    if (auditFailure) throw new Error('replacement audit unavailable')
    return value
  }
  mongoose.startSession = async () => {
    sessionStarted = true
    return {
      startTransaction () {},
      async commitTransaction () { committed = true },
      async abortTransaction () { aborted = true },
      async endSession () {}
    }
  }
  paymentGatewayService.getAdapterInstance = () => {
    adapterCalls++
    return { async testConnection () { return { success: true } } }
  }
  t.after(() => {
    PaymentGateway.findById = originals.gatewayFindById
    PaymentGateway.updateOne = originals.gatewayUpdateOne
    TransactionStatus.countDocuments = originals.txCount
    User.findById = originals.userFindById
    User.find = originals.userFind
    User.updateOne = originals.userUpdateOne
    AuditLog.create = originals.auditCreate
    mongoose.startSession = originals.startSession
    paymentGatewayService.getAdapterInstance = originals.getAdapterInstance
  })

  const res = response()
  await controller.replaceMonnifyMerchant(request(gateway, body), res)
  return {
    res,
    snapshotUpdates,
    adapterCalls,
    sessionStarted,
    committed,
    aborted,
    realGetAdapterInstance: originals.getAdapterInstance
  }
}

async function executeEligibility (t, {
  verificationStatus = 'success',
  expiresAt = new Date(Date.now() + 60_000),
  gatewayEnvironment = 'test',
  checkoutEnvironment = gatewayEnvironment,
  snapshotEnvironment = gatewayEnvironment,
  checkoutStatus = 'initialized',
  checkoutHasReference = true,
  transactionLeaseToken = checkoutStatus === 'initializing' ? 'owned-lease' : undefined,
  auditFailure = false
} = {}) {
  const gateway = gatewayFixture()
  gateway.environment = gatewayEnvironment
  gateway.baseUrl = gatewayEnvironment === 'live'
    ? 'https://api.monnify.com'
    : 'https://sandbox.monnify.com'
  const reference = 'MNFY_VALIDATION_REFERENCE'
  gateway.metadata.checkoutValidation = {
    status: checkoutStatus,
    ...(checkoutHasReference ? { reference } : {}),
    ...(checkoutStatus === 'initializing' ? { leaseToken: 'owned-lease' } : {}),
    gatewayId: gateway._id,
    environment: checkoutEnvironment,
    configurationVersion: 3,
    amountKobo: 10000,
    currency: 'NGN',
    initializedAt: new Date(Date.now() - 1000),
    expiresAt
  }
  const transaction = {
    refId: reference,
    userId: 'admin-monnify-replacement',
    type: 'gateway_test',
    status: 'pending',
    provider: 'monnify',
    gatewayId: gateway._id,
    amountKobo: 10000,
    expectedCurrency: 'NGN',
    ...(transactionLeaseToken ? { administrativeValidationLeaseToken: transactionLeaseToken } : {}),
    gatewayConfigSnapshot: {
      gatewayId: gateway._id,
      code: 'monnify',
      adapterType: 'monnify',
      environment: snapshotEnvironment,
      configurationVersion: 3
    }
  }
  const password = await bcrypt.hash('correct-password', 4)
  const originals = {
    gatewayFindById: PaymentGateway.findById,
    gatewayUpdateOne: PaymentGateway.updateOne,
    txFindOne: TransactionStatus.findOne,
    userFindById: User.findById,
    auditCreate: AuditLog.create,
    verifyFunding: paymentGatewayService.verifyFunding,
    startSession: mongoose.startSession
  }
  let gatewayUpdate
  let verificationCalls = 0
  let committed = false
  let aborted = false
  let auditWrite
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.updateOne = async (filter, update) => {
    gatewayUpdate = { filter, update }
    return { matchedCount: 1 }
  }
  TransactionStatus.findOne = () => queryResult(transaction)
  User.findById = () => queryResult({
    _id: 'admin-monnify-replacement',
    name: 'Test SuperAdmin',
    password,
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin']
  })
  AuditLog.create = async (value, options) => {
    auditWrite = { value, options }
    if (auditFailure) throw new Error('audit unavailable')
    return value
  }
  const session = {
    startTransaction () {},
    async commitTransaction () { committed = true },
    async abortTransaction () { aborted = true },
    async endSession () {}
  }
  mongoose.startSession = async () => session
  paymentGatewayService.verifyFunding = async () => {
    verificationCalls++
    if (verificationStatus === 'success') {
      Object.assign(transaction, {
        status: 'success',
        confirmedProvider: 'monnify',
        confirmedReference: reference,
        confirmedAmountKobo: 10000,
        confirmedCurrency: 'NGN',
        confirmedProviderRef: 'MNFY_PROVIDER_TRANSACTION'
      })
    }
    return { status: verificationStatus, reference }
  }
  t.after(() => {
    PaymentGateway.findById = originals.gatewayFindById
    PaymentGateway.updateOne = originals.gatewayUpdateOne
    TransactionStatus.findOne = originals.txFindOne
    User.findById = originals.userFindById
    AuditLog.create = originals.auditCreate
    paymentGatewayService.verifyFunding = originals.verifyFunding
    mongoose.startSession = originals.startSession
  })

  const res = response()
  await controller.enableMonnifyCustomerFunding(request(gateway, {
    reference,
    currentPassword: 'correct-password',
    confirmation: gatewayEnvironment === 'live'
      ? 'enable-monnify-live-customer-funding'
      : 'enable-monnify-test-customer-funding'
  }), res)
  return {
    res,
    gateway,
    transaction,
    gatewayUpdate,
    verificationCalls,
    auditWrite,
    committed,
    aborted,
    session
  }
}

test('confirmed Monnify replacement archives old account context and preserves gateway identity/default', async t => {
  const gateway = gatewayFixture()
  const password = await bcrypt.hash('correct-password', 4)
  const admin = {
    _id: 'admin-monnify-replacement',
    name: 'Test SuperAdmin',
    email: 'admin@example.test',
    phone: '08000000000',
    password,
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin']
  }
  const owner = {
    _id: 'reserved-owner',
    virtualAccounts: [{
      provider: 'monnify',
      gatewayId: gateway._id,
      accountReference: 'VIRTUAL_507f1f77bcf86cd799439011',
      accountNumber: '1234567890',
      provisioningStatus: 'active',
      active: true,
      assigned: true,
      currency: 'NGN'
    }],
    virtualAccountGatewaySnapshots: new Map()
  }
  const originals = {
    gatewayFindById: PaymentGateway.findById,
    gatewayUpdateOne: PaymentGateway.updateOne,
    txCount: TransactionStatus.countDocuments,
    userFindById: User.findById,
    userFind: User.find,
    userUpdateOne: User.updateOne,
    auditCreate: AuditLog.create,
    startSession: mongoose.startSession,
    getAdapterInstance: paymentGatewayService.getAdapterInstance
  }
  let candidate
  let snapshotUpdate
  let committed = false
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.updateOne = async filter => {
    assert.equal(filter.virtualAccountMutationVersion, 3)
    return { matchedCount: 1 }
  }
  TransactionStatus.countDocuments = async () => 0
  User.findById = () => queryResult(admin)
  User.find = () => queryResult([owner])
  User.updateOne = async (filter, update, options) => {
    snapshotUpdate = { filter, update, options }
    return { matchedCount: 1 }
  }
  AuditLog.create = async value => value
  mongoose.startSession = async () => ({
    startTransaction () {},
    async commitTransaction () { committed = true },
    async abortTransaction () {},
    async endSession () {}
  })
  paymentGatewayService.getAdapterInstance = config => {
    candidate = config
    return { async testConnection () { return { success: true } } }
  }
  t.after(() => {
    PaymentGateway.findById = originals.gatewayFindById
    PaymentGateway.updateOne = originals.gatewayUpdateOne
    TransactionStatus.countDocuments = originals.txCount
    User.findById = originals.userFindById
    User.find = originals.userFind
    User.updateOne = originals.userUpdateOne
    AuditLog.create = originals.auditCreate
    mongoose.startSession = originals.startSession
    paymentGatewayService.getAdapterInstance = originals.getAdapterInstance
  })

  const res = response()
  await controller.replaceMonnifyMerchant(request(gateway, replacementBody()), res)

  assert.equal(res.statusCode, 200)
  assert.equal(committed, true)
  assert.equal(candidate.environment, 'test')
  assert.equal(candidate.baseUrl, 'https://sandbox.monnify.com')
  assert.equal(candidate.metadata.contractCode, '2222222222')
  assert.equal(gateway._id, 'gateway-monnify')
  assert.equal(gateway.code, 'monnify')
  assert.equal(gateway.isDefault, false)
  assert.equal(gateway.status, 'inactive')
  assert.equal(gateway.metadata.administrativeSandboxOnly, true)
  assert.equal(gateway.virtualAccountMutationVersion, 4)
  assert.equal(decryptSecret(gateway.secretKey), 'new-secret')
  assert.equal(decryptSecret(gateway.webhookSecret), 'new-webhook')
  assert.equal(gateway.webhookVerificationSnapshots.length, 1)
  assert.equal(
    decryptSecret(gateway.webhookVerificationSnapshots[0].secretKey),
    'old-secret'
  )
  const snapshotPath = 'virtualAccountGatewaySnapshots.VIRTUAL_507f1f77bcf86cd799439011'
  assert.equal(
    decryptSecret(snapshotUpdate.update.$set[snapshotPath].secretKey),
    'old-secret'
  )
  assert.equal(res.body.diagnostics.defaultGatewayChanged, false)
})

test('live Monnify replacement requires live confirmation and exact live API base', async t => {
  const gateway = gatewayFixture()
  const rejected = await executeReplacement(t, {
    gateway,
    body: replacementBody({ environment: 'live' })
  })
  assert.equal(rejected.res.statusCode, 409)
  assert.equal(
    rejected.res.body.details.requiredConfirmation,
    'replace-monnify-live-merchant'
  )
})

test('confirmed live Monnify replacement remains inactive, non-default, and admin-isolated', async t => {
  const gateway = gatewayFixture()
  const result = await executeReplacement(t, {
    gateway,
    body: replacementBody({
      environment: 'live',
      baseUrl: 'https://api.monnify.com',
      confirmation: 'replace-monnify-live-merchant'
    })
  })

  assert.equal(result.res.statusCode, 200)
  assert.equal(gateway.environment, 'live')
  assert.equal(gateway.baseUrl, 'https://api.monnify.com')
  assert.equal(gateway.status, 'inactive')
  assert.equal(gateway.isDefault, false)
  assert.equal(gateway.metadata.administrativeSandboxOnly, true)
})

test('replacement audit failure aborts the merchant replacement transaction', async t => {
  const result = await executeReplacement(t, {
    gateway: gatewayFixture(),
    auditFailure: true
  })

  assert.equal(result.res.statusCode, 400)
  assert.match(result.res.body.message, /replacement audit unavailable/)
  assert.equal(result.committed, false)
  assert.equal(result.aborted, true)
})

test('replacement uses the old API secret when the optional webhook secret was never configured', async t => {
  setMonnifyEnvironment(t)
  const gateway = gatewayFixture()
  gateway.webhookSecret = ''
  const owner = monnifyOwner(gateway, ['VIRTUAL_507f1f77bcf86cd799439011'])

  const result = await executeReplacement(t, { gateway, owners: [owner] })

  assert.equal(result.res.statusCode, 200)
  assert.equal(result.snapshotUpdates.length, 1)
  assert.equal(gateway.webhookVerificationSnapshots.length, 1)
  assert.equal(gateway.webhookVerificationSnapshots[0].webhookSecret, '')
  assert.equal(
    decryptSecret(gateway.webhookVerificationSnapshots[0].secretKey),
    'old-secret'
  )

  paymentGatewayService.getAdapterInstance = result.realGetAdapterInstance
  const rawBody = Buffer.from('{"eventType":"SUCCESSFUL_TRANSACTION"}')
  const oldSignature = require('node:crypto')
    .createHmac('sha512', 'old-secret')
    .update(rawBody)
    .digest('hex')
  const newSignature = require('node:crypto')
    .createHmac('sha512', 'new-webhook')
    .update(rawBody)
    .digest('hex')
  const hydrated = paymentGatewayService._hydrateGatewayCredentials(gateway)
  const oldContext = paymentGatewayService._selectWebhookGateway(
    hydrated,
    { 'monnify-signature': oldSignature },
    rawBody
  )
  const newContext = paymentGatewayService._selectWebhookGateway(
    hydrated,
    { 'monnify-signature': newSignature },
    rawBody
  )
  assert.equal(oldContext.matched, true)
  assert.equal(oldContext.gateway.secretKey, 'old-secret')
  assert.equal(newContext.matched, true)
  assert.equal(newContext.gateway.secretKey, 'new-secret')
})

test('replacement archives an exact-match legacy environment signing context for reserved accounts', async t => {
  setMonnifyEnvironment(t, {
    MONNIFY_API_KEY: 'MK_OLD',
    MONNIFY_SECRET_KEY: 'legacy-old-secret'
  })
  const gateway = gatewayFixture()
  gateway.secretKey = ''
  gateway.webhookSecret = ''
  const owner = monnifyOwner(gateway, [
    'VIRTUAL_507f1f77bcf86cd799439011',
    'VIRTUAL_507f1f77bcf86cd799439012',
    'VIRTUAL_507f1f77bcf86cd799439013'
  ])

  const result = await executeReplacement(t, { gateway, owners: [owner] })

  assert.equal(result.res.statusCode, 200)
  assert.equal(result.snapshotUpdates.length, 3)
  assert.equal(
    decryptSecret(gateway.webhookVerificationSnapshots[0].secretKey),
    'legacy-old-secret'
  )
  assert.equal(
    decryptSecret(gateway.webhookVerificationSnapshots[0].webhookSecret),
    'legacy-old-secret'
  )
})

test('replacement does not require an old signing credential when no historical dependency exists', async t => {
  setMonnifyEnvironment(t)
  const gateway = gatewayFixture()
  gateway.secretKey = ''
  gateway.webhookSecret = ''

  const result = await executeReplacement(t, { gateway })

  assert.equal(result.res.statusCode, 200)
  assert.equal(result.snapshotUpdates.length, 0)
  assert.equal(gateway.webhookVerificationSnapshots.length, 0)
})

test('unresolved Monnify payments still block replacement independently of reserved accounts', async t => {
  setMonnifyEnvironment(t)
  const gateway = gatewayFixture()
  gateway.secretKey = ''
  gateway.webhookSecret = ''

  const result = await executeReplacement(t, {
    gateway,
    unresolvedPayments: 2
  })

  assert.equal(result.res.statusCode, 409)
  assert.equal(result.res.body.code, 'PAYMENT_GATEWAY_UNRESOLVED_TRANSACTIONS')
  assert.equal(result.res.body.details.unresolvedTransactions, 2)
  assert.equal(result.adapterCalls, 0)
  assert.equal(result.sessionStarted, false)
})

test('active reserved accounts still fail closed without a provable old signing context', async t => {
  setMonnifyEnvironment(t, {
    MONNIFY_API_KEY: 'DIFFERENT_MERCHANT',
    MONNIFY_SECRET_KEY: 'unrelated-secret'
  })
  const gateway = gatewayFixture()
  gateway.secretKey = ''
  gateway.webhookSecret = ''
  const owner = monnifyOwner(gateway, ['VIRTUAL_507f1f77bcf86cd799439011'])

  const result = await executeReplacement(t, { gateway, owners: [owner] })

  assert.equal(result.res.statusCode, 409)
  assert.equal(result.res.body.code, 'PAYMENT_GATEWAY_WEBHOOK_HISTORY_UNAVAILABLE')
  assert.equal(gateway.publicKey, 'MK_OLD')
})

test('Monnify replacement rejects failed reauthentication before provider validation or writes', async t => {
  const gateway = gatewayFixture()
  const password = await bcrypt.hash('different-password', 4)
  const originals = {
    userFindById: User.findById,
    gatewayFindById: PaymentGateway.findById,
    startSession: mongoose.startSession,
    getAdapterInstance: paymentGatewayService.getAdapterInstance
  }
  let adapterCalled = false
  let sessionStarted = false
  User.findById = () => queryResult({
    _id: 'admin-monnify-replacement',
    password,
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin']
  })
  PaymentGateway.findById = () => queryResult(gateway)
  mongoose.startSession = async () => {
    sessionStarted = true
    throw new Error('must not start')
  }
  paymentGatewayService.getAdapterInstance = () => {
    adapterCalled = true
    return { async testConnection () { return { success: true } } }
  }
  t.after(() => {
    User.findById = originals.userFindById
    PaymentGateway.findById = originals.gatewayFindById
    mongoose.startSession = originals.startSession
    paymentGatewayService.getAdapterInstance = originals.getAdapterInstance
  })

  const res = response()
  await controller.replaceMonnifyMerchant(request(gateway, replacementBody()), res)

  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'SUPERADMIN_REAUTHENTICATION_FAILED')
  assert.equal(adapterCalled, false)
  assert.equal(sessionStarted, false)
})

test('Monnify replacement requires the gateway to be inactive before provider validation', async t => {
  const gateway = gatewayFixture()
  gateway.status = 'active'
  const password = await bcrypt.hash('correct-password', 4)
  const originals = {
    userFindById: User.findById,
    gatewayFindById: PaymentGateway.findById,
    getAdapterInstance: paymentGatewayService.getAdapterInstance
  }
  let adapterCalled = false
  User.findById = () => queryResult({
    _id: 'admin-monnify-replacement',
    password,
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin']
  })
  PaymentGateway.findById = () => queryResult(gateway)
  paymentGatewayService.getAdapterInstance = () => {
    adapterCalled = true
    return { async testConnection () { return { success: true } } }
  }
  t.after(() => {
    User.findById = originals.userFindById
    PaymentGateway.findById = originals.gatewayFindById
    paymentGatewayService.getAdapterInstance = originals.getAdapterInstance
  })

  const res = response()
  await controller.replaceMonnifyMerchant(request(gateway, replacementBody()), res)

  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'MONNIFY_MERCHANT_REPLACEMENT_REQUIRES_INACTIVE')
  assert.equal(adapterCalled, false)
})

test('Monnify replacement fails without mutation when candidate authentication fails', async t => {
  const gateway = gatewayFixture()
  const password = await bcrypt.hash('correct-password', 4)
  const originals = {
    userFindById: User.findById,
    gatewayFindById: PaymentGateway.findById,
    txCount: TransactionStatus.countDocuments,
    startSession: mongoose.startSession,
    getAdapterInstance: paymentGatewayService.getAdapterInstance
  }
  let sessionStarted = false
  User.findById = () => queryResult({
    _id: 'admin-monnify-replacement',
    password,
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin']
  })
  PaymentGateway.findById = () => queryResult(gateway)
  TransactionStatus.countDocuments = async () => 0
  mongoose.startSession = async () => {
    sessionStarted = true
    throw new Error('must not start')
  }
  paymentGatewayService.getAdapterInstance = () => ({
    async testConnection () { return { success: false, message: 'provider detail' } }
  })
  t.after(() => {
    User.findById = originals.userFindById
    PaymentGateway.findById = originals.gatewayFindById
    TransactionStatus.countDocuments = originals.txCount
    mongoose.startSession = originals.startSession
    paymentGatewayService.getAdapterInstance = originals.getAdapterInstance
  })

  const res = response()
  await controller.replaceMonnifyMerchant(request(gateway, replacementBody()), res)

  assert.equal(res.statusCode, 422)
  assert.equal(res.body.code, 'MONNIFY_MERCHANT_VALIDATION_FAILED')
  assert.equal(sessionStarted, false)
  assert.equal(gateway.publicKey, 'MK_OLD')
  assert.equal(decryptSecret(gateway.secretKey), 'old-secret')
})

test('Monnify replacement rejects reuse of a retained webhook signing secret', async t => {
  const gateway = gatewayFixture()
  const password = await bcrypt.hash('correct-password', 4)
  const originals = {
    userFindById: User.findById,
    gatewayFindById: PaymentGateway.findById,
    getAdapterInstance: paymentGatewayService.getAdapterInstance
  }
  let adapterCalled = false
  User.findById = () => queryResult({
    _id: 'admin-monnify-replacement',
    password,
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin']
  })
  PaymentGateway.findById = () => queryResult(gateway)
  paymentGatewayService.getAdapterInstance = () => {
    adapterCalled = true
    return { async testConnection () { return { success: true } } }
  }
  t.after(() => {
    User.findById = originals.userFindById
    PaymentGateway.findById = originals.gatewayFindById
    paymentGatewayService.getAdapterInstance = originals.getAdapterInstance
  })

  const res = response()
  await controller.replaceMonnifyMerchant(
    request(gateway, replacementBody({ webhookSecret: 'old-webhook' })),
    res
  )

  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'MONNIFY_WEBHOOK_SECRET_REUSE_FORBIDDEN')
  assert.equal(adapterCalled, false)
})

test('sandbox checkout pins Monnify gateway identity/environment without changing defaults', async t => {
  const gateway = gatewayFixture()
  gateway.status = 'inactive'
  const password = await bcrypt.hash('correct-password', 4)
  const admin = {
    _id: 'admin-monnify-replacement',
    name: 'Test SuperAdmin',
    email: 'admin@example.test',
    phone: '08000000000',
    password,
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin']
  }
  const originals = {
    userFindById: User.findById,
    gatewayFindById: PaymentGateway.findById,
    auditCreate: AuditLog.create,
    initializeFunding: paymentGatewayService.initializeFunding,
    gatewayUpdateOne: PaymentGateway.updateOne,
    setDefault: PaymentGateway.setDefault,
    startSession: mongoose.startSession
  }
  let initialization
  let markerUpdate
  let defaultChanged = false
  User.findById = () => queryResult(admin)
  PaymentGateway.findById = () => queryResult(gateway)
  AuditLog.create = async value => value
  PaymentGateway.updateOne = async (filter, update) => {
    markerUpdate = { filter, update }
    return { matchedCount: 1 }
  }
  PaymentGateway.setDefault = async () => { defaultChanged = true }
  mongoose.startSession = async () => transactionSession()
  paymentGatewayService.initializeFunding = async options => {
    initialization = options
    return {
      authorizationUrl: 'https://sandbox.monnify.com/checkout/test',
      reference: 'MNFY_TEST_REFERENCE',
      provider: 'monnify'
    }
  }
  t.after(() => {
    User.findById = originals.userFindById
    PaymentGateway.findById = originals.gatewayFindById
    AuditLog.create = originals.auditCreate
    paymentGatewayService.initializeFunding = originals.initializeFunding
    PaymentGateway.updateOne = originals.gatewayUpdateOne
    PaymentGateway.setDefault = originals.setDefault
    mongoose.startSession = originals.startSession
  })

  const res = response()
  await controller.testMonnifyHostedCheckout(
    request(gateway, { amount: 100, currentPassword: 'correct-password' }),
    res
  )

  assert.equal(res.statusCode, 200)
  assert.equal(initialization.gatewayCode, 'monnify')
  assert.equal(initialization.requiredGatewayId, gateway._id)
  assert.equal(initialization.requiredEnvironment, 'test')
  assert.equal(initialization.requiredStatus, 'inactive')
  assert.equal(initialization.requiredMutationVersion, 3)
  assert.equal(initialization.allowInactiveGateway, true)
  assert.equal(initialization.administrativeSandboxTest, true)
  assert.match(initialization.administrativeValidationLeaseToken, /^[a-f0-9]{64}$/)
  assert.equal(initialization.metadata.administrativeSandboxTest, true)
  assert.equal(markerUpdate.update.$set['metadata.checkoutValidation'].status, 'initialized')
  assert.equal(markerUpdate.update.$set['metadata.checkoutValidation'].reference, 'MNFY_TEST_REFERENCE')
  assert.equal(markerUpdate.update.$set['metadata.checkoutValidation'].configurationVersion, 3)
  assert.equal(markerUpdate.update.$set['metadata.checkoutValidation'].amountKobo, 10000)
  assert.equal(markerUpdate.update.$set['metadata.checkoutValidation'].currency, 'NGN')
  assert.equal(defaultChanged, false)
  assert.equal(gateway.isDefault, false)
})

test('coded checkout audit failure returns the accepted reference when recovery persistence also fails', async t => {
  const gateway = gatewayFixture()
  const password = await bcrypt.hash('correct-password', 4)
  const originals = {
    userFindById: User.findById,
    gatewayFindById: PaymentGateway.findById,
    gatewayUpdateOne: PaymentGateway.updateOne,
    initializeFunding: paymentGatewayService.initializeFunding,
    auditCreate: AuditLog.create,
    startSession: mongoose.startSession
  }
  const state = { updates: [] }
  User.findById = () => queryResult({
    _id: 'admin-monnify-replacement',
    name: 'Test SuperAdmin',
    email: 'admin@example.test',
    password,
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin']
  })
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.updateOne = async (filter, update, options) => {
    state.updates.push({ filter, update, options })
    if (update.$set?.['metadata.checkoutValidation']?.status === 'ambiguous') {
      const error = new Error('recovery write unavailable')
      error.code = 91
      throw error
    }
    return { matchedCount: 1 }
  }
  paymentGatewayService.initializeFunding = async () => ({
    authorizationUrl: 'https://sandbox.sdk.monnify.com/checkout/test',
    reference: 'MNFY_AUDIT_RECOVERY_REFERENCE',
    provider: 'monnify'
  })
  AuditLog.create = async () => {
    const error = new Error('audit unavailable')
    error.code = 112
    throw error
  }
  mongoose.startSession = async () => transactionSession(state)
  t.after(() => {
    User.findById = originals.userFindById
    PaymentGateway.findById = originals.gatewayFindById
    PaymentGateway.updateOne = originals.gatewayUpdateOne
    paymentGatewayService.initializeFunding = originals.initializeFunding
    AuditLog.create = originals.auditCreate
    mongoose.startSession = originals.startSession
  })

  const res = response()
  await controller.testMonnifyHostedCheckout(
    request(gateway, { amount: 100, currentPassword: 'correct-password' }),
    res
  )

  assert.equal(res.statusCode, 202)
  assert.equal(res.body.code, 'PAYMENT_INITIALIZATION_AMBIGUOUS')
  assert.equal(res.body.reference, 'MNFY_AUDIT_RECOVERY_REFERENCE')
  assert.equal(state.committed, undefined)
  assert.equal(state.aborted, true)
  const recovery = state.updates.find(item => (
    item.update.$set?.['metadata.checkoutValidation']?.status === 'ambiguous'
  ))
  assert.ok(recovery)
  assert.equal(recovery.options, undefined)
})

test('a second validation checkout is rejected before provider dispatch while the lease is held', async t => {
  const gateway = gatewayFixture()
  const password = await bcrypt.hash('correct-password', 4)
  const originals = {
    userFindById: User.findById,
    gatewayFindById: PaymentGateway.findById,
    gatewayUpdateOne: PaymentGateway.updateOne,
    initializeFunding: paymentGatewayService.initializeFunding,
    auditCreate: AuditLog.create,
    startSession: mongoose.startSession
  }
  let leaseHeld = false
  let initializeCalls = 0
  let releaseInitialization
  let providerEntered
  const providerStarted = new Promise(resolve => { providerEntered = resolve })
  const providerResult = new Promise(resolve => { releaseInitialization = resolve })

  User.findById = () => queryResult({
    _id: 'admin-monnify-replacement',
    name: 'Test SuperAdmin',
    email: 'admin@example.test',
    password,
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin']
  })
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.updateOne = async (filter, update) => {
    if (update.$set?.['metadata.checkoutValidation']?.status === 'initializing') {
      if (leaseHeld) return { matchedCount: 0 }
      leaseHeld = true
      return { matchedCount: 1 }
    }
    return { matchedCount: 1 }
  }
  paymentGatewayService.initializeFunding = async () => {
    initializeCalls++
    providerEntered()
    return providerResult
  }
  AuditLog.create = async value => value
  mongoose.startSession = async () => transactionSession()
  t.after(() => {
    User.findById = originals.userFindById
    PaymentGateway.findById = originals.gatewayFindById
    PaymentGateway.updateOne = originals.gatewayUpdateOne
    paymentGatewayService.initializeFunding = originals.initializeFunding
    AuditLog.create = originals.auditCreate
    mongoose.startSession = originals.startSession
  })

  const firstRes = response()
  const first = controller.testMonnifyHostedCheckout(
    request(gateway, { amount: 100, currentPassword: 'correct-password' }),
    firstRes
  )
  await providerStarted

  const secondRes = response()
  await controller.testMonnifyHostedCheckout(
    request(gateway, { amount: 100, currentPassword: 'correct-password' }),
    secondRes
  )

  assert.equal(secondRes.statusCode, 409)
  assert.equal(secondRes.body.code, 'MONNIFY_VALIDATION_CHECKOUT_IN_PROGRESS')
  assert.equal(initializeCalls, 1)

  releaseInitialization({
    authorizationUrl: 'https://sandbox.sdk.monnify.com/checkout/test',
    reference: 'MNFY_TEST_REFERENCE',
    provider: 'monnify'
  })
  await first
  assert.equal(firstRes.statusCode, 200)
})

test('ambiguous validation initialization retains exact evidence for later verification', async t => {
  const gateway = gatewayFixture()
  const password = await bcrypt.hash('correct-password', 4)
  const originals = {
    userFindById: User.findById,
    gatewayFindById: PaymentGateway.findById,
    gatewayUpdateOne: PaymentGateway.updateOne,
    initializeFunding: paymentGatewayService.initializeFunding
  }
  const updates = []
  User.findById = () => queryResult({
    _id: 'admin-monnify-replacement',
    name: 'Test SuperAdmin',
    password,
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin']
  })
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.updateOne = async (filter, update) => {
    updates.push({ filter, update })
    return { matchedCount: 1 }
  }
  paymentGatewayService.initializeFunding = async () => {
    const error = new Error('Provider outcome is ambiguous')
    error.code = 'PAYMENT_INITIALIZATION_AMBIGUOUS'
    error.reference = 'MNFY_AMBIGUOUS_REFERENCE'
    error.status = 'pending'
    throw error
  }
  t.after(() => {
    User.findById = originals.userFindById
    PaymentGateway.findById = originals.gatewayFindById
    PaymentGateway.updateOne = originals.gatewayUpdateOne
    paymentGatewayService.initializeFunding = originals.initializeFunding
  })

  const res = response()
  await controller.testMonnifyHostedCheckout(
    request(gateway, { amount: 100, currentPassword: 'correct-password' }),
    res
  )

  assert.equal(res.statusCode, 202)
  assert.equal(res.body.reference, 'MNFY_AMBIGUOUS_REFERENCE')
  const retained = updates.find(item => (
    item.update.$set?.['metadata.checkoutValidation']?.status === 'ambiguous'
  ))
  assert.ok(retained)
  assert.equal(
    retained.update.$set['metadata.checkoutValidation'].configurationVersion,
    gateway.virtualAccountMutationVersion
  )
})

test('definitive pre-dispatch validation failure releases only the owned checkout lease', async t => {
  const gateway = gatewayFixture()
  const password = await bcrypt.hash('correct-password', 4)
  const originals = {
    userFindById: User.findById,
    gatewayFindById: PaymentGateway.findById,
    gatewayUpdateOne: PaymentGateway.updateOne,
    initializeFunding: paymentGatewayService.initializeFunding
  }
  const updates = []
  User.findById = () => queryResult({
    _id: 'admin-monnify-replacement',
    name: 'Test SuperAdmin',
    password,
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin']
  })
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.updateOne = async (filter, update) => {
    updates.push({ filter, update })
    return { matchedCount: 1 }
  }
  paymentGatewayService.initializeFunding = async () => {
    const error = new Error('Credentials are unavailable')
    error.gatewayInitializationOutcome = 'definitive_failure'
    error.requestDispatched = false
    throw error
  }
  t.after(() => {
    User.findById = originals.userFindById
    PaymentGateway.findById = originals.gatewayFindById
    PaymentGateway.updateOne = originals.gatewayUpdateOne
    paymentGatewayService.initializeFunding = originals.initializeFunding
  })

  const res = response()
  await controller.testMonnifyHostedCheckout(
    request(gateway, { amount: 100, currentPassword: 'correct-password' }),
    res
  )

  assert.equal(res.statusCode, 400)
  const release = updates.find(item => item.update.$unset?.['metadata.checkoutValidation'] === 1)
  assert.ok(release)
  assert.equal(release.filter['metadata.checkoutValidation.status'], 'initializing')
  assert.ok(release.filter['metadata.checkoutValidation.leaseToken'])
})

test('live validation checkout requires its literal confirmation before initialization', async t => {
  const gateway = gatewayFixture()
  gateway.environment = 'live'
  gateway.baseUrl = 'https://api.monnify.com'
  const password = await bcrypt.hash('correct-password', 4)
  const originals = {
    userFindById: User.findById,
    gatewayFindById: PaymentGateway.findById,
    initializeFunding: paymentGatewayService.initializeFunding
  }
  let initialized = false
  User.findById = () => queryResult({
    _id: 'admin-monnify-replacement',
    name: 'Test SuperAdmin',
    password,
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin']
  })
  PaymentGateway.findById = () => queryResult(gateway)
  paymentGatewayService.initializeFunding = async () => { initialized = true }
  t.after(() => {
    User.findById = originals.userFindById
    PaymentGateway.findById = originals.gatewayFindById
    paymentGatewayService.initializeFunding = originals.initializeFunding
  })

  const res = response()
  await controller.testMonnifyHostedCheckout(
    request(gateway, { amount: 100, currentPassword: 'correct-password' }),
    res
  )

  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'MONNIFY_LIVE_VALIDATION_CONFIRMATION_REQUIRED')
  assert.equal(initialized, false)
})

test('Monnify activation requires successful hosted checkout validation', async t => {
  const gateway = gatewayFixture()
  gateway.status = 'inactive'
  gateway.lastHealthCheck = {
    status: 'online',
    message: 'Connected to Monnify successfully'
  }
  const originals = {
    gatewayFindById: PaymentGateway.findById,
    gatewayUpdateOne: PaymentGateway.updateOne,
    auditCreate: AuditLog.create,
    startSession: mongoose.startSession
  }
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.updateOne = async () => ({ matchedCount: 1 })
  AuditLog.create = async value => value
  mongoose.startSession = async () => transactionSession()
  t.after(() => {
    PaymentGateway.findById = originals.gatewayFindById
    PaymentGateway.updateOne = originals.gatewayUpdateOne
    AuditLog.create = originals.auditCreate
    mongoose.startSession = originals.startSession
  })

  const blocked = response()
  await controller.updateGatewayStatus(
    request(gateway, { status: 'active' }),
    blocked
  )
  assert.equal(blocked.statusCode, 409)
  assert.equal(blocked.body.code, 'MONNIFY_CUSTOMER_FUNDING_ELIGIBILITY_REQUIRED')
  assert.equal(gateway.status, 'inactive')

  approveGatewayForCustomerFunding(gateway)
  const allowed = response()
  await controller.updateGatewayStatus(
    request(gateway, { status: 'active' }),
    allowed
  )
  assert.equal(allowed.statusCode, 200)
  assert.equal(gateway.status, 'active')
})

test('activation audit failure aborts the canonical Monnify status transition', async t => {
  const gateway = gatewayFixture()
  approveGatewayForCustomerFunding(gateway)
  const originals = {
    gatewayFindById: PaymentGateway.findById,
    gatewayUpdateOne: PaymentGateway.updateOne,
    auditCreate: AuditLog.create,
    startSession: mongoose.startSession
  }
  const state = {}
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.updateOne = async () => ({ matchedCount: 1 })
  AuditLog.create = async () => { throw new Error('audit unavailable') }
  mongoose.startSession = async () => transactionSession(state)
  t.after(() => {
    PaymentGateway.findById = originals.gatewayFindById
    PaymentGateway.updateOne = originals.gatewayUpdateOne
    AuditLog.create = originals.auditCreate
    mongoose.startSession = originals.startSession
  })

  const res = response()
  await controller.updateGatewayStatus(
    request(gateway, { status: 'active' }),
    res
  )

  assert.equal(res.statusCode, 400)
  assert.match(res.body.message, /audit unavailable/)
  assert.equal(state.committed, undefined)
  assert.equal(state.aborted, true)
  assert.equal(gateway.status, 'inactive')
})

test('paid exact gateway-test evidence enables activation, default, and customer initialization', async t => {
  const result = await executeEligibility(t)

  assert.equal(result.res.statusCode, 200, JSON.stringify(result.res.body))
  assert.equal(result.verificationCalls, 1)
  assert.equal(result.gateway.metadata.administrativeSandboxOnly, false)
  assert.equal(result.gateway.metadata.checkoutValidation.status, 'verified')
  assert.equal(result.gateway.metadata.customerFundingEligibility.status, 'eligible')
  assert.equal(
    result.gateway.metadata.customerFundingEligibility.providerTransactionId,
    'MNFY_PROVIDER_TRANSACTION'
  )
  assert.equal(
    result.gatewayUpdate.update.$set['metadata.administrativeSandboxOnly'],
    false
  )
  assert.equal(result.transaction.type, 'gateway_test')
  assert.equal(result.committed, true)
  assert.equal(result.aborted, false)
  assert.equal(result.auditWrite.value[0].action, 'MONNIFY_CUSTOMER_FUNDING_ENABLED')
  assert.equal(result.auditWrite.options.session, result.session)

  const originals = {
    setDefault: PaymentGateway.setDefault,
    getDefaultGateway: paymentGatewayService.getDefaultGateway,
    getAdapterInstance: paymentGatewayService.getAdapterInstance,
    transactionCreate: TransactionStatus.create
  }
  let customerTransaction
  PaymentGateway.setDefault = async () => {
    result.gateway.isDefault = true
    return { modifiedCount: 1 }
  }
  paymentGatewayService.getDefaultGateway = async () => result.gateway
  paymentGatewayService.getAdapterInstance = () => ({
    async initializePayment ({ reference }) {
      return {
        authorizationUrl: 'https://sandbox.sdk.monnify.com/checkout/customer',
        reference
      }
    }
  })
  TransactionStatus.create = async value => { customerTransaction = value }
  t.after(() => {
    PaymentGateway.setDefault = originals.setDefault
    paymentGatewayService.getDefaultGateway = originals.getDefaultGateway
    paymentGatewayService.getAdapterInstance = originals.getAdapterInstance
    TransactionStatus.create = originals.transactionCreate
  })

  const activation = response()
  await controller.updateGatewayStatus(
    request(result.gateway, { status: 'active' }),
    activation
  )
  assert.equal(activation.statusCode, 200)
  assert.equal(result.gateway.status, 'active')

  const defaultResponse = response()
  let defaultProjection
  PaymentGateway.findById = () => ({
    select (fields) { defaultProjection = fields; return this },
    then (resolve, reject) {
      return Promise.resolve(result.gateway).then(resolve, reject)
    }
  })
  await controller.setDefaultGateway(request(result.gateway), defaultResponse)
  assert.equal(defaultResponse.statusCode, 200)
  assert.equal(result.gateway.isDefault, true)
  assert.match(defaultProjection, /virtualAccountMutationVersion/)

  const customerInitialization = await paymentGatewayService.initializeFunding({
    user: { _id: 'customer-1', email: 'customer@example.test' },
    amount: 100
  })
  assert.equal(customerInitialization.provider, 'monnify')
  assert.equal(customerTransaction.type, 'funding')
  assert.equal(customerTransaction.gatewayId, result.gateway._id)
  assert.equal(customerTransaction.gatewayConfigSnapshot.configurationVersion, 3)
})

test('audit failure aborts the eligibility transition', async t => {
  const result = await executeEligibility(t, { auditFailure: true })

  assert.equal(result.res.statusCode, 400)
  assert.match(result.res.body.message, /audit unavailable/)
  assert.equal(result.committed, false)
  assert.equal(result.aborted, true)
  assert.equal(result.gateway.metadata.administrativeSandboxOnly, true)
  assert.equal(result.gateway.metadata.customerFundingEligibility, undefined)
})

test('paid ambiguous checkout evidence can complete the exact eligibility transition', async t => {
  const result = await executeEligibility(t, { checkoutStatus: 'ambiguous' })

  assert.equal(result.res.statusCode, 200)
  assert.equal(result.gateway.metadata.checkoutValidation.status, 'verified')
  assert.equal(result.committed, true)
})

test('provider-accepted initializing evidence can recover through exact gateway-test verification', async t => {
  const result = await executeEligibility(t, {
    checkoutStatus: 'initializing',
    checkoutHasReference: false
  })

  assert.equal(result.res.statusCode, 200)
  assert.equal(result.gateway.metadata.checkoutValidation.status, 'verified')
  assert.equal(
    result.gateway.metadata.checkoutValidation.reference,
    'MNFY_VALIDATION_REFERENCE'
  )
  assert.equal(result.gateway.metadata.checkoutValidation.leaseToken, undefined)
  assert.equal(result.committed, true)
})

test('initializing recovery rejects a gateway-test transaction from another lease', async t => {
  const result = await executeEligibility(t, {
    checkoutStatus: 'initializing',
    checkoutHasReference: false,
    transactionLeaseToken: 'stale-lease'
  })

  assert.equal(result.res.statusCode, 409)
  assert.equal(result.res.body.code, 'MONNIFY_GATEWAY_TEST_SNAPSHOT_MISMATCH')
  assert.equal(result.verificationCalls, 0)
  assert.equal(result.gatewayUpdate, undefined)
  assert.equal(result.gateway.metadata.administrativeSandboxOnly, true)
})

test('pending validation payment returns 202 without an eligibility transition', async t => {
  const result = await executeEligibility(t, { verificationStatus: 'pending' })

  assert.equal(result.res.statusCode, 202)
  assert.equal(result.res.body.code, 'MONNIFY_VALIDATION_PAYMENT_PENDING')
  assert.equal(result.gatewayUpdate, undefined)
  assert.equal(result.gateway.metadata.administrativeSandboxOnly, true)
})

test('failed validation payment returns non-success without an eligibility transition', async t => {
  const result = await executeEligibility(t, { verificationStatus: 'failed' })

  assert.equal(result.res.statusCode, 422)
  assert.equal(result.res.body.code, 'MONNIFY_VALIDATION_PAYMENT_NOT_SUCCESSFUL')
  assert.equal(result.gatewayUpdate, undefined)
  assert.equal(result.gateway.metadata.administrativeSandboxOnly, true)
})

test('expired checkout evidence fails before provider verification', async t => {
  const result = await executeEligibility(t, {
    expiresAt: new Date(Date.now() - 1000)
  })

  assert.equal(result.res.statusCode, 410)
  assert.equal(result.res.body.code, 'MONNIFY_CHECKOUT_EVIDENCE_EXPIRED')
  assert.equal(result.verificationCalls, 0)
})

test('test and live validation evidence cannot be interchanged', async t => {
  const result = await executeEligibility(t, {
    gatewayEnvironment: 'live',
    checkoutEnvironment: 'test'
  })

  assert.equal(result.res.statusCode, 409)
  assert.equal(result.res.body.code, 'MONNIFY_CHECKOUT_EVIDENCE_MISMATCH')
  assert.equal(result.verificationCalls, 0)
})

test('wrong gateway snapshot cannot enable customer funding', async t => {
  const result = await executeEligibility(t, { snapshotEnvironment: 'live' })

  assert.equal(result.res.statusCode, 409)
  assert.equal(result.res.body.code, 'MONNIFY_GATEWAY_TEST_SNAPSHOT_MISMATCH')
  assert.equal(result.verificationCalls, 0)
})

test('canonical Monnify configuration mutation invalidates eligibility and restores admin isolation', async t => {
  const gateway = gatewayFixture()
  gateway.metadata.checkoutValidation = {
    status: 'verified',
    reference: 'OLD_REFERENCE',
    environment: 'test',
    configurationVersion: 3
  }
  gateway.metadata.customerFundingEligibility = {
    status: 'eligible',
    gatewayId: gateway._id,
    environment: 'test',
    configurationVersion: 3
  }
  gateway.metadata.administrativeSandboxOnly = false
  const originals = {
    gatewayFindById: PaymentGateway.findById,
    gatewayUpdateOne: PaymentGateway.updateOne,
    txCount: TransactionStatus.countDocuments,
    auditCreate: AuditLog.create,
    startSession: mongoose.startSession
  }
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.updateOne = async () => ({ matchedCount: 1 })
  TransactionStatus.countDocuments = async () => 0
  AuditLog.create = async value => value
  mongoose.startSession = async () => ({
    startTransaction () {},
    async commitTransaction () {},
    async abortTransaction () {},
    async endSession () {}
  })
  t.after(() => {
    PaymentGateway.findById = originals.gatewayFindById
    PaymentGateway.updateOne = originals.gatewayUpdateOne
    TransactionStatus.countDocuments = originals.txCount
    AuditLog.create = originals.auditCreate
    mongoose.startSession = originals.startSession
  })

  const res = response()
  await controller.updateGateway(request(gateway, {
    metadata: { label: 'Changed configuration' }
  }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(gateway.virtualAccountMutationVersion, 4)
  assert.equal(gateway.metadata.administrativeSandboxOnly, true)
  assert.equal(gateway.metadata.checkoutValidation, undefined)
  assert.equal(gateway.metadata.customerFundingEligibility, undefined)
})

test('ordinary gateway update cannot activate Monnify outside the atomic status path', async t => {
  const gateway = gatewayFixture()
  gateway.lastHealthCheck = {
    status: 'online',
    message: 'Monnify sandbox hosted checkout initialized successfully'
  }
  const originalFindById = PaymentGateway.findById
  PaymentGateway.findById = () => queryResult(gateway)
  t.after(() => { PaymentGateway.findById = originalFindById })

  const res = response()
  await controller.updateGateway(request(gateway, { status: 'active' }), res)

  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'MONNIFY_ACTIVATION_REQUIRES_STATUS_ENDPOINT')
  assert.equal(gateway.status, 'inactive')
})

test('historical routing extracts the documented Monnify V2 product reference', () => {
  const accountReference = 'VIRTUAL_507f1f77bcf86cd799439011'
  assert.equal(
    paymentGatewayService._extractVirtualAccountReference('monnify', {
      eventData: {
        product: {
          type: 'RESERVED_ACCOUNT',
          reference: accountReference
        }
      }
    }),
    accountReference
  )
})

test('administrative funding requirements fail before creating a transaction', async t => {
  const originals = {
    getGateway: paymentGatewayService.getGateway,
    transactionCreate: TransactionStatus.create
  }
  let transactionCreated = false
  paymentGatewayService.getGateway = async () => ({
    _id: 'different-gateway',
    code: 'monnify',
    adapterType: 'monnify',
    name: 'Monnify',
    status: 'active',
    environment: 'test',
    supportedChannels: ['card'],
    metadata: { contractCode: '2222222222' }
  })
  TransactionStatus.create = async () => { transactionCreated = true }
  t.after(() => {
    paymentGatewayService.getGateway = originals.getGateway
    TransactionStatus.create = originals.transactionCreate
  })

  await assert.rejects(
    paymentGatewayService.initializeFunding({
      gatewayCode: 'monnify',
      requiredGatewayId: 'expected-gateway',
      requiredEnvironment: 'test',
      user: { _id: 'admin-1', email: 'admin@example.test' },
      amount: 100
    }),
    { code: 'PAYMENT_GATEWAY_IDENTITY_MISMATCH' }
  )
  assert.equal(transactionCreated, false)
})

test('administrative sandbox initialization persists a no-credit transaction type', async t => {
  const originals = {
    getGateway: paymentGatewayService.getGateway,
    getAdapterInstance: paymentGatewayService.getAdapterInstance,
    transactionCreate: TransactionStatus.create
  }
  let created
  paymentGatewayService.getGateway = async () => ({
    _id: 'gateway-monnify',
    code: 'monnify',
    adapterType: 'monnify',
    name: 'Monnify',
    status: 'inactive',
    environment: 'test',
    virtualAccountMutationVersion: 4,
    supportedChannels: ['card'],
    metadata: { contractCode: '2222222222' }
  })
  paymentGatewayService.getAdapterInstance = () => ({
    async initializePayment () {
      return { authorizationUrl: 'https://sandbox.monnify.com/checkout/test' }
    }
  })
  TransactionStatus.create = async value => { created = value }
  t.after(() => {
    paymentGatewayService.getGateway = originals.getGateway
    paymentGatewayService.getAdapterInstance = originals.getAdapterInstance
    TransactionStatus.create = originals.transactionCreate
  })

  await paymentGatewayService.initializeFunding({
    gatewayCode: 'monnify',
    requiredGatewayId: 'gateway-monnify',
    requiredEnvironment: 'test',
    requiredStatus: 'inactive',
    requiredMutationVersion: 4,
    allowInactiveGateway: true,
    administrativeSandboxTest: true,
    administrativeValidationLeaseToken: 'owned-lease',
    user: { _id: 'admin-1', email: 'admin@example.test' },
    amount: 100
  })

  assert.equal(created.type, 'gateway_test')
  assert.equal(created.administrativeValidationLeaseToken, 'owned-lease')
})

test('administrative sandbox isolation blocks normal funding before transaction creation', async t => {
  const originals = {
    getGateway: paymentGatewayService.getGateway,
    transactionCreate: TransactionStatus.create
  }
  let transactionCreated = false
  paymentGatewayService.getGateway = async () => ({
    _id: 'gateway-monnify',
    code: 'monnify',
    adapterType: 'monnify',
    name: 'Monnify',
    status: 'active',
    environment: 'test',
    supportedChannels: ['card'],
    metadata: { administrativeSandboxOnly: true }
  })
  TransactionStatus.create = async () => { transactionCreated = true }
  t.after(() => {
    paymentGatewayService.getGateway = originals.getGateway
    TransactionStatus.create = originals.transactionCreate
  })

  await assert.rejects(
    paymentGatewayService.initializeFunding({
      gatewayCode: 'monnify',
      user: { _id: 'customer-1', email: 'customer@example.test' },
      amount: 100
    }),
    { code: 'PAYMENT_GATEWAY_SANDBOX_ISOLATED' }
  )
  assert.equal(transactionCreated, false)
})

test('administrative sandbox gateway cannot be made the platform default', async t => {
  const gateway = gatewayFixture()
  gateway.status = 'active'
  gateway.metadata.administrativeSandboxOnly = true
  const originals = {
    findById: PaymentGateway.findById,
    setDefault: PaymentGateway.setDefault
  }
  let defaultChanged = false
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.setDefault = async () => { defaultChanged = true }
  t.after(() => {
    PaymentGateway.findById = originals.findById
    PaymentGateway.setDefault = originals.setDefault
  })

  const res = response()
  await controller.setDefaultGateway(request(gateway), res)

  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'PAYMENT_GATEWAY_SANDBOX_ISOLATED')
  assert.equal(defaultChanged, false)
})

test('default audit failure aborts the routing transition', async t => {
  const gateway = gatewayFixture()
  gateway.status = 'active'
  approveGatewayForCustomerFunding(gateway)
  const originals = {
    gatewayFindById: PaymentGateway.findById,
    setDefault: PaymentGateway.setDefault,
    auditCreate: AuditLog.create,
    startSession: mongoose.startSession
  }
  const state = {}
  let defaultSession
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.setDefault = async (id, options) => {
    assert.equal(id, gateway._id)
    defaultSession = options.session
    return { modifiedCount: 1 }
  }
  AuditLog.create = async () => { throw new Error('audit unavailable') }
  mongoose.startSession = async () => transactionSession(state)
  t.after(() => {
    PaymentGateway.findById = originals.gatewayFindById
    PaymentGateway.setDefault = originals.setDefault
    AuditLog.create = originals.auditCreate
    mongoose.startSession = originals.startSession
  })

  const res = response()
  await controller.setDefaultGateway(request(gateway), res)

  assert.equal(res.statusCode, 400)
  assert.match(res.body.message, /audit unavailable/)
  assert.ok(defaultSession)
  assert.equal(state.committed, undefined)
  assert.equal(state.aborted, true)
})

test('wallet funding ignores caller-selected gateway compatibility fields', async t => {
  const original = paymentGatewayService.initializeFunding
  let initialization
  paymentGatewayService.initializeFunding = async options => {
    initialization = options
    return {
      authorizationUrl: 'https://checkout.paystack.com/test',
      reference: 'PAYSTACK_DEFAULT',
      provider: 'paystack'
    }
  }
  t.after(() => { paymentGatewayService.initializeFunding = original })
  const res = response()

  await walletFundingController.fundWallet({
    body: { amount: 100, gatewayCode: 'monnify', provider: 'monnify' },
    user: { id: 'customer-1', email: 'customer@example.test' }
  }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(initialization.gatewayCode, undefined)
})

test('settled gateway tests never credit wallets or create funding audits', async t => {
  const transaction = {
    refId: 'MNFY_GATEWAY_TEST',
    userId: 'admin-1',
    type: 'gateway_test',
    status: 'processing',
    settlementClaimToken: 'claim-token',
    settlementLeaseExpiresAt: new Date(Date.now() + 60_000),
    amountKobo: 10000,
    expectedCurrency: 'NGN',
    confirmedAmountKobo: 10000,
    confirmedCurrency: 'NGN',
    provider: 'monnify',
    confirmedProvider: 'monnify',
    confirmedReference: 'MNFY_GATEWAY_TEST',
    confirmedProviderRef: 'provider-test-reference'
  }
  const originals = {
    startSession: mongoose.startSession,
    transactionFindOne: TransactionStatus.findOne,
    transactionUpdateOne: TransactionStatus.updateOne,
    walletLedgerFindOne: WalletLedger.findOne,
    auditFindOne: Transaction.findOne,
    auditCreate: Transaction.create,
    walletCredit: walletService.credit,
    fundingNotification: notificationService.sendFundingSuccess,
    assertOwner: paymentGatewayService._assertProviderTransactionOwner
  }
  let committed = false
  let forbiddenSideEffect = false
  mongoose.startSession = async () => ({
    startTransaction () {},
    async commitTransaction () { committed = true },
    async abortTransaction () {},
    async endSession () {}
  })
  TransactionStatus.findOne = () => queryResult(transaction)
  TransactionStatus.updateOne = async () => ({ matchedCount: 1, modifiedCount: 1 })
  WalletLedger.findOne = () => { forbiddenSideEffect = true; throw new Error('wallet ledger lookup forbidden') }
  Transaction.findOne = () => { forbiddenSideEffect = true; throw new Error('funding audit lookup forbidden') }
  Transaction.create = async () => { forbiddenSideEffect = true; throw new Error('funding audit create forbidden') }
  walletService.credit = async () => { forbiddenSideEffect = true; throw new Error('wallet credit forbidden') }
  notificationService.sendFundingSuccess = async () => { forbiddenSideEffect = true; throw new Error('funding notification forbidden') }
  paymentGatewayService._assertProviderTransactionOwner = async () => {}
  t.after(() => {
    mongoose.startSession = originals.startSession
    TransactionStatus.findOne = originals.transactionFindOne
    TransactionStatus.updateOne = originals.transactionUpdateOne
    WalletLedger.findOne = originals.walletLedgerFindOne
    Transaction.findOne = originals.auditFindOne
    Transaction.create = originals.auditCreate
    walletService.credit = originals.walletCredit
    notificationService.sendFundingSuccess = originals.fundingNotification
    paymentGatewayService._assertProviderTransactionOwner = originals.assertOwner
  })

  const result = await paymentGatewayService._settleOwnedClaim({
    refId: transaction.refId,
    claimToken: transaction.settlementClaimToken,
    source: 'webhook'
  })

  assert.equal(committed, true)
  assert.equal(result.status, 'success')
  assert.equal(result.credited, false)
  assert.equal(forbiddenSideEffect, false)
})

test('canonical Monnify deposit ownership permits provider-tagged legacy rows without gatewayId', async () => {
  let lookupFilter
  const account = {
    provider: 'monnify',
    accountReference: 'VIRTUAL_507f1f77bcf86cd799439011',
    accountNumber: '1234567890',
    provisioningStatus: 'active',
    active: true,
    assigned: true,
    currency: 'NGN'
  }
  const repository = new MongoVirtualAccountRepository({
    find (filter) {
      lookupFilter = filter
      const query = queryResult([{
        _id: 'owner-1',
        virtualAccounts: [account],
        virtualAccountGatewaySnapshots: new Map()
      }])
      query.limit = () => query
      return query
    }
  })
  const service = new VirtualAccountService({
    repository
  })

  const owner = await service.resolveMonnifyDepositOwner({
    gateway: {
      _id: 'gateway-monnify',
      code: 'monnify',
      adapterType: 'monnify'
    },
    accountReference: 'VIRTUAL_507f1f77bcf86cd799439011',
    accountNumber: '1234567890'
  })

  assert.ok(lookupFilter.virtualAccounts.$elemMatch.$or)
  assert.equal(owner.userId, 'owner-1')
  assert.equal(owner.account.gatewayId, undefined)
})
