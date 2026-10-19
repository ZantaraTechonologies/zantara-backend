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
    metadata: { contractCode: '1111111111', label: 'Existing' },
    webhookVerificationSnapshots: [],
    virtualAccountMutationVersion: 3,
    markModified () {},
    async save () { return this }
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
    setDefault: PaymentGateway.setDefault
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
  assert.equal(initialization.metadata.administrativeSandboxTest, true)
  assert.equal(
    markerUpdate.update.$set.lastHealthCheck.message,
    'Monnify sandbox hosted checkout initialized successfully'
  )
  assert.equal(defaultChanged, false)
  assert.equal(gateway.isDefault, false)
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
    auditCreate: AuditLog.create
  }
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.updateOne = async () => ({ matchedCount: 1 })
  AuditLog.create = async value => value
  t.after(() => {
    PaymentGateway.findById = originals.gatewayFindById
    PaymentGateway.updateOne = originals.gatewayUpdateOne
    AuditLog.create = originals.auditCreate
  })

  const blocked = response()
  await controller.updateGatewayStatus(
    request(gateway, { status: 'active' }),
    blocked
  )
  assert.equal(blocked.statusCode, 409)
  assert.equal(blocked.body.code, 'MONNIFY_SANDBOX_CHECKOUT_VALIDATION_REQUIRED')
  assert.equal(gateway.status, 'inactive')

  gateway.lastHealthCheck.message = 'Monnify sandbox hosted checkout initialized successfully'
  const allowed = response()
  await controller.updateGatewayStatus(
    request(gateway, { status: 'active' }),
    allowed
  )
  assert.equal(allowed.statusCode, 200)
  assert.equal(gateway.status, 'active')
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
    user: { _id: 'admin-1', email: 'admin@example.test' },
    amount: 100
  })

  assert.equal(created.type, 'gateway_test')
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
