'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const mongoose = require('mongoose')
const PaymentGateway = require('../models/PaymentGateway')
const TransactionStatus = require('../models/TransactionStatus')
const User = require('../models/User')
const AuditLog = require('../models/AuditLog')
const controller = require('../controllers/adminPaymentGatewayController')
const { encryptSecret, isEncrypted } = require('../utils/crypto')
const {
  buildGatewayChangePlan,
  sameCanonicalValue
} = require('../utils/paymentGatewayChangePlan')

function gatewayFixture (overrides = {}) {
  return {
    _id: 'gateway-effective-changes',
    name: 'Paystack',
    code: 'paystack',
    adapterType: 'paystack',
    status: 'active',
    environment: 'test',
    isDefault: false,
    priority: 1,
    publicKey: 'pk_test_public',
    secretKey: encryptSecret('sk_test_current'),
    webhookSecret: encryptSecret('legacy-webhook-value'),
    baseUrl: 'https://api.paystack.co',
    supportedChannels: ['card', 'virtual_account'],
    metadata: { alpha: 1, nested: { enabled: true } },
    webhookVerificationSnapshots: [],
    virtualAccountMutationVersion: 0,
    markModified () {},
    async save () { return this },
    ...overrides
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

function request (gateway, body) {
  return {
    params: { id: gateway._id },
    body,
    user: { id: 'admin-effective-changes', name: 'Admin' },
    headers: {},
    ip: '127.0.0.1'
  }
}

test('gateway change plan compares effective values rather than submitted fields', () => {
  const gateway = gatewayFixture()
  const noOp = buildGatewayChangePlan(gateway, {
    adapterType: 'PAYSTACK',
    baseUrl: 'https://api.paystack.co',
    publicKey: 'pk_test_public',
    secretKey: 'sk_test_current',
    webhookSecret: 'legacy-webhook-value',
    environment: 'TEST',
    metadata: { nested: { enabled: true }, alpha: 1 }
  })

  assert.equal(noOp.noOp, true)
  assert.deepEqual(noOp.effectiveChanges, [])
  assert.equal(noOp.requiresMutationFence, false)

  const changed = buildGatewayChangePlan(gateway, {
    secretKey: 'sk_test_next',
    metadata: { alpha: 2 }
  })
  assert.deepEqual(changed.effectiveChanges, ['secretKey', 'metadata'])
  assert.deepEqual(changed.paystackVerificationChanges, ['secretKey'])
  assert.deepEqual(changed.next.metadata, {
    alpha: 2,
    nested: { enabled: true }
  })
  assert.equal(changed.requiresMutationFence, true)
  assert.equal(
    sameCanonicalValue({ a: 1, b: { x: 2, y: 3 } }, { b: { y: 3, x: 2 }, a: 1 }),
    true
  )
})

test('same secret and canonically identical metadata do not fence or archive', async t => {
  const gateway = gatewayFixture()
  const originals = {
    findById: PaymentGateway.findById,
    startSession: mongoose.startSession,
    transactionCount: TransactionStatus.countDocuments,
    userCount: User.countDocuments,
    auditCreate: AuditLog.create
  }
  let sessionStarted = false
  let transactionCounted = false
  let userCounted = false

  PaymentGateway.findById = async () => gateway
  mongoose.startSession = async () => {
    sessionStarted = true
    throw new Error('A no-op verification update must not start a transaction')
  }
  TransactionStatus.countDocuments = async () => {
    transactionCounted = true
    return 0
  }
  User.countDocuments = async () => {
    userCounted = true
    return 0
  }
  AuditLog.create = async value => value
  t.after(() => {
    PaymentGateway.findById = originals.findById
    mongoose.startSession = originals.startSession
    TransactionStatus.countDocuments = originals.transactionCount
    User.countDocuments = originals.userCount
    AuditLog.create = originals.auditCreate
  })

  const res = response()
  await controller.updateGateway(request(gateway, {
    name: 'Paystack Renamed',
    secretKey: 'sk_test_current',
    webhookSecret: 'legacy-webhook-value',
    metadata: { nested: { enabled: true }, alpha: 1 }
  }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(sessionStarted, false)
  assert.equal(transactionCounted, false)
  assert.equal(userCounted, false)
  assert.equal(gateway.webhookVerificationSnapshots.length, 0)
  assert.deepEqual(res.body.diagnostics.effectiveChanges, [])
})

test('genuine Paystack secret rotation fences and archives historical verification', async t => {
  const gateway = gatewayFixture({ environment: 'live', publicKey: 'pk_live_public' })
  const originals = {
    findById: PaymentGateway.findById,
    updateOne: PaymentGateway.updateOne,
    startSession: mongoose.startSession,
    transactionCount: TransactionStatus.countDocuments,
    userCount: User.countDocuments,
    auditCreate: AuditLog.create
  }
  let committed = false
  let transactionFilter

  PaymentGateway.findById = async () => gateway
  PaymentGateway.updateOne = async () => ({ matchedCount: 1 })
  mongoose.startSession = async () => ({
    startTransaction () {},
    async commitTransaction () { committed = true },
    async abortTransaction () {},
    async endSession () {}
  })
  TransactionStatus.countDocuments = async filter => {
    transactionFilter = filter
    return 0
  }
  User.countDocuments = async () => 1
  AuditLog.create = async value => value
  t.after(() => {
    PaymentGateway.findById = originals.findById
    PaymentGateway.updateOne = originals.updateOne
    mongoose.startSession = originals.startSession
    TransactionStatus.countDocuments = originals.transactionCount
    User.countDocuments = originals.userCount
    AuditLog.create = originals.auditCreate
  })

  const previousSecret = gateway.secretKey
  const res = response()
  await controller.updateGateway(request(gateway, { secretKey: 'sk_live_next' }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(committed, true)
  assert.deepEqual(transactionFilter.status.$in, [
    'pending',
    'processing',
    'settlement_pending',
    'reconciliation_required'
  ])
  assert.equal(Object.hasOwn(transactionFilter, 'createdAt'), false)
  assert.equal(gateway.webhookVerificationSnapshots.length, 1)
  assert.equal(gateway.webhookVerificationSnapshots[0].secretKey, previousSecret)
  assert.equal(isEncrypted(gateway.secretKey), true)
  assert.notEqual(gateway.secretKey, previousSecret)
})

test('test-to-live gateway switch requires explicit confirmation', async t => {
  const gateway = gatewayFixture()
  const originalFindById = PaymentGateway.findById
  PaymentGateway.findById = async () => gateway
  t.after(() => { PaymentGateway.findById = originalFindById })

  const res = response()
  await controller.updateGateway(request(gateway, {
    environment: 'live',
    publicKey: 'pk_live_public',
    secretKey: 'sk_live_next'
  }), res)

  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'PAYMENT_GATEWAY_ENVIRONMENT_CONFIRMATION_REQUIRED')
  assert.deepEqual(res.body.details.requiredConfirmation, {
    confirmEnvironmentChange: 'test-to-live'
  })
})

test('Paystack credential prefixes cannot silently cross environments', async t => {
  const gateway = gatewayFixture()
  const originalFindById = PaymentGateway.findById
  PaymentGateway.findById = async () => gateway
  t.after(() => { PaymentGateway.findById = originalFindById })

  const res = response()
  await controller.updateGateway(request(gateway, { secretKey: 'sk_live_next' }), res)

  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'PAYMENT_GATEWAY_CREDENTIAL_ENVIRONMENT_MISMATCH')
  assert.deepEqual(res.body.details.mismatchedFields, ['secretKey'])
})

test('malformed Paystack credential updates fail before mutation', async t => {
  const gateway = gatewayFixture()
  const originals = {
    findById: PaymentGateway.findById,
    startSession: mongoose.startSession
  }
  let sessionStarted = false
  PaymentGateway.findById = async () => gateway
  mongoose.startSession = async () => {
    sessionStarted = true
    throw new Error('invalid credentials must fail before a transaction starts')
  }
  t.after(() => {
    PaymentGateway.findById = originals.findById
    mongoose.startSession = originals.startSession
  })

  const res = response()
  await controller.updateGateway(request(gateway, { secretKey: 'garbage' }), res)

  assert.equal(res.statusCode, 400)
  assert.equal(res.body.code, 'PAYMENT_GATEWAY_CREDENTIAL_INVALID')
  assert.deepEqual(res.body.details.invalidFields, ['secretKey'])
  assert.equal(sessionStarted, false)
})

test('invalid default request is rejected before saving ordinary changes', async t => {
  let saves = 0
  const gateway = gatewayFixture({
    status: 'inactive',
    async save () { saves++; return this }
  })
  const originalFindById = PaymentGateway.findById
  PaymentGateway.findById = async () => gateway
  t.after(() => { PaymentGateway.findById = originalFindById })

  const res = response()
  await controller.updateGateway(request(gateway, {
    name: 'Must Not Persist',
    isDefault: true
  }), res)

  assert.equal(res.statusCode, 400)
  assert.equal(res.body.code, 'PAYMENT_GATEWAY_DEFAULT_REQUIRES_ACTIVE')
  assert.equal(saves, 0)
  assert.equal(gateway.name, 'Paystack')
})

test('transactional reload revalidates credentials against a concurrent environment change', async t => {
  const initial = gatewayFixture()
  const concurrent = gatewayFixture({
    environment: 'live',
    publicKey: 'pk_live_public',
    secretKey: encryptSecret('sk_live_current')
  })
  const originals = {
    findById: PaymentGateway.findById,
    updateOne: PaymentGateway.updateOne,
    startSession: mongoose.startSession
  }
  let reads = 0
  let fenced = false
  let aborted = false
  PaymentGateway.findById = async () => (++reads === 1 ? initial : concurrent)
  PaymentGateway.updateOne = async () => {
    fenced = true
    return { matchedCount: 1 }
  }
  mongoose.startSession = async () => ({
    startTransaction () {},
    async commitTransaction () {},
    async abortTransaction () { aborted = true },
    async endSession () {}
  })
  t.after(() => {
    PaymentGateway.findById = originals.findById
    PaymentGateway.updateOne = originals.updateOne
    mongoose.startSession = originals.startSession
  })

  const res = response()
  await controller.updateGateway(request(initial, { secretKey: 'sk_test_next' }), res)

  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'PAYMENT_GATEWAY_CREDENTIAL_ENVIRONMENT_MISMATCH')
  assert.equal(fenced, false)
  assert.equal(aborted, true)
})

test('transactional reload that becomes a no-op does not advance the mutation fence', async t => {
  const initial = gatewayFixture()
  const concurrent = gatewayFixture({
    secretKey: encryptSecret('sk_test_next'),
    virtualAccountMutationVersion: 7
  })
  const originals = {
    findById: PaymentGateway.findById,
    updateOne: PaymentGateway.updateOne,
    startSession: mongoose.startSession,
    auditCreate: AuditLog.create
  }
  let reads = 0
  let fenced = false
  let committed = false
  PaymentGateway.findById = async () => (++reads === 1 ? initial : concurrent)
  PaymentGateway.updateOne = async () => {
    fenced = true
    return { matchedCount: 1 }
  }
  mongoose.startSession = async () => ({
    startTransaction () {},
    async commitTransaction () { committed = true },
    async abortTransaction () {},
    async endSession () {}
  })
  AuditLog.create = async value => value
  t.after(() => {
    PaymentGateway.findById = originals.findById
    PaymentGateway.updateOne = originals.updateOne
    mongoose.startSession = originals.startSession
    AuditLog.create = originals.auditCreate
  })

  const res = response()
  await controller.updateGateway(request(initial, { secretKey: 'sk_test_next' }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(fenced, false)
  assert.equal(committed, true)
  assert.equal(concurrent.virtualAccountMutationVersion, 7)
  assert.deepEqual(res.body.diagnostics.effectiveChanges, [])
})
