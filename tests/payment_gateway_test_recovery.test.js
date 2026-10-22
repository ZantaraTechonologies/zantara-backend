'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const bcrypt = require('bcryptjs')
const mongoose = require('mongoose')
const PaymentGateway = require('../models/PaymentGateway')
const TransactionStatus = require('../models/TransactionStatus')
const Transaction = require('../models/Transaction')
const WalletLedger = require('../models/WalletLedger')
const AuditLog = require('../models/AuditLog')
const User = require('../models/User')
const controller = require('../controllers/adminPaymentGatewayController')
const paymentGatewayService = require('../services/paymentGateway.service')
const walletService = require('../services/wallet.service')
const notificationService = require('../services/notification.service')
const { encryptSecret } = require('../utils/crypto')

const REFERENCE = 'MONNIFY-RECOVERY-REFERENCE'
const PROVIDER_REFERENCE = 'MNFY|RECOVERY|PROVIDER'
const ADMIN_ID = new mongoose.Types.ObjectId()

function queryResult (value) {
  return {
    select () { return this },
    session () { return this },
    then (resolve, reject) { return Promise.resolve(value).then(resolve, reject) }
  }
}

function gatewayFixture () {
  const secretKey = encryptSecret('recovery-secret')
  return {
    _id: 'gateway-monnify-recovery',
    name: 'Monnify',
    code: 'monnify',
    adapterType: 'monnify',
    status: 'inactive',
    environment: 'test',
    isDefault: false,
    publicKey: 'MK_RECOVERY',
    secretKey,
    webhookSecret: encryptSecret('recovery-webhook'),
    baseUrl: 'https://sandbox.monnify.com',
    supportedChannels: ['card', 'bank_transfer'],
    virtualAccountMutationVersion: 1,
    virtualAccountClaimVersion: 0,
    metadata: {
      contractCode: '1234567890',
      administrativeSandboxOnly: true,
      checkoutValidation: {
        status: 'initialized',
        reference: REFERENCE,
        gatewayId: 'gateway-monnify-recovery',
        environment: 'test',
        configurationVersion: 1,
        amountKobo: 10000,
        currency: 'NGN',
        initializedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      }
    }
  }
}

function transactionFixture (gateway) {
  const hydratedGateway = paymentGatewayService._hydrateGatewayCredentials(gateway)
  return {
    _id: 'gateway-test-recovery-row',
    refId: REFERENCE,
    userId: ADMIN_ID,
    type: 'gateway_test',
    status: 'reconciliation_required',
    amountKobo: 10000,
    expectedCurrency: 'NGN',
    confirmedAmountKobo: 10000,
    confirmedReference: REFERENCE,
    provider: 'monnify',
    gatewayId: gateway._id,
    reconciliationReason: "Currency mismatch: expected 'NGN', confirmed 'missing'",
    gatewayConfigSnapshot: paymentGatewayService._snapshotGatewayConfig(hydratedGateway),
    createdAt: new Date(Date.now() - 60_000),
    updatedAt: new Date()
  }
}

function providerResult (overrides = {}) {
  return {
    success: true,
    status: 'success',
    providerStatus: 'PAID',
    reference: REFERENCE,
    providerTransactionId: PROVIDER_REFERENCE,
    amount: 100,
    currency: 'NGN',
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

function installRecoveryHarness (t, options = {}) {
  const gateway = options.gateway || gatewayFixture()
  const transaction = options.transaction || transactionFixture(gateway)
  const verification = options.verification || providerResult()
  const auditWrites = []
  const state = {
    providerCalls: 0,
    ownerChecks: 0,
    gatewayWrites: 0,
    transactionWrites: 0,
    walletEffects: 0,
    committed: false,
    aborted: false,
    released: false
  }
  const originals = {
    gatewayFindById: PaymentGateway.findById,
    gatewayUpdateOne: PaymentGateway.updateOne,
    transactionFindOne: TransactionStatus.findOne,
    transactionFindOneAndUpdate: TransactionStatus.findOneAndUpdate,
    transactionUpdateOne: TransactionStatus.updateOne,
    transactionFind: Transaction.findOne,
    transactionCreate: Transaction.create,
    ledgerFind: WalletLedger.findOne,
    auditCreate: AuditLog.create,
    startSession: mongoose.startSession,
    getAdapter: paymentGatewayService.getAdapterInstance,
    assertOwner: paymentGatewayService._assertProviderTransactionOwner,
    walletCredit: walletService.credit,
    fundingSuccess: notificationService.sendFundingSuccess
  }

  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.updateOne = async () => {
    state.gatewayWrites++
    if (options.gatewayFenceConflict) return { matchedCount: 0, modifiedCount: 0 }
    gateway.virtualAccountClaimVersion++
    return { matchedCount: 1, modifiedCount: 1 }
  }
  TransactionStatus.findOne = filter => {
    if (filter?.confirmedProvider) return queryResult(null)
    return queryResult(transaction)
  }
  TransactionStatus.findOneAndUpdate = (_filter, update) => {
    if (options.claimDenied) return queryResult(null)
    Object.assign(transaction, update.$set)
    return queryResult(transaction)
  }
  TransactionStatus.updateOne = async (filter, update, writeOptions) => {
    state.transactionWrites++
    if (filter.eligibilityVerificationLeaseToken && update.$unset && !writeOptions) {
      state.released = true
      delete transaction.eligibilityVerificationLeaseToken
      delete transaction.eligibilityVerificationLeaseExpiresAt
      return { matchedCount: 1, modifiedCount: 1 }
    }
    if (options.duplicateKeyOnFinalize && writeOptions?.session) {
      const error = new Error('duplicate provider transaction')
      error.code = 11000
      throw error
    }
    if (writeOptions?.session) {
      Object.assign(transaction, update.$set)
      for (const key of Object.keys(update.$unset || {})) delete transaction[key]
    }
    return { matchedCount: 1, modifiedCount: 1 }
  }
  AuditLog.create = async (entries, writeOptions) => {
    if (!writeOptions?.session) throw new Error('Recovery audit must be transactional')
    if (options.auditFailure) throw new Error('audit unavailable')
    auditWrites.push(...entries)
    return entries
  }
  mongoose.startSession = async () => {
    const transactionBeforeSession = { ...transaction }
    const gatewayClaimVersionBeforeSession = gateway.virtualAccountClaimVersion
    return {
    startTransaction () {},
    async commitTransaction () { state.committed = true },
    async abortTransaction () {
      state.aborted = true
      for (const key of Object.keys(transaction)) delete transaction[key]
      Object.assign(transaction, transactionBeforeSession)
      gateway.virtualAccountClaimVersion = gatewayClaimVersionBeforeSession
    },
    async endSession () {}
    }
  }
  paymentGatewayService.getAdapterInstance = snapshot => {
    assert.equal(snapshot.environment, 'test')
    assert.equal(snapshot.baseUrl, 'https://sandbox.monnify.com')
    assert.equal(snapshot.publicKey, gateway.publicKey)
    assert.equal(snapshot.secretKey, 'recovery-secret')
    return {
      async verifyPayment (reference) {
        state.providerCalls++
        assert.equal(reference, REFERENCE)
        return verification
      }
    }
  }
  paymentGatewayService._assertProviderTransactionOwner = async () => {
    state.ownerChecks++
    if (
      options.providerReferenceReused ||
      (options.duplicateKeyOnFinalize && state.ownerChecks > 2)
    ) {
      const error = new Error('Provider transaction is already owned')
      error.code = 'PAYMENT_PROVIDER_TRANSACTION_REUSED'
      error.statusCode = 409
      throw error
    }
  }

  const forbidden = () => {
    state.walletEffects++
    throw new Error('Gateway-test recovery must not touch financial side effects')
  }
  WalletLedger.findOne = forbidden
  Transaction.findOne = forbidden
  Transaction.create = forbidden
  walletService.credit = forbidden
  notificationService.sendFundingSuccess = forbidden

  t.after(() => {
    PaymentGateway.findById = originals.gatewayFindById
    PaymentGateway.updateOne = originals.gatewayUpdateOne
    TransactionStatus.findOne = originals.transactionFindOne
    TransactionStatus.findOneAndUpdate = originals.transactionFindOneAndUpdate
    TransactionStatus.updateOne = originals.transactionUpdateOne
    Transaction.findOne = originals.transactionFind
    Transaction.create = originals.transactionCreate
    WalletLedger.findOne = originals.ledgerFind
    AuditLog.create = originals.auditCreate
    mongoose.startSession = originals.startSession
    paymentGatewayService.getAdapterInstance = originals.getAdapter
    paymentGatewayService._assertProviderTransactionOwner = originals.assertOwner
    walletService.credit = originals.walletCredit
    notificationService.sendFundingSuccess = originals.fundingSuccess
  })

  return { gateway, transaction, auditWrites, state }
}

test('fresh pinned-snapshot verification atomically recovers a paid gateway test without wallet effects', async t => {
  const { gateway, transaction, auditWrites, state } = installRecoveryHarness(t)
  assert.notEqual(transaction.gatewayConfigSnapshot.secretKey, gateway.secretKey)

  const result = await paymentGatewayService.recoverGatewayTestReconciliation({
    gatewayId: gateway._id,
    reference: REFERENCE,
    adminId: ADMIN_ID,
    operatorName: 'Recovery Admin',
    note: 'Confirmed documented currency normalization incident'
  })

  assert.equal(result.status, 'success')
  assert.equal(result.recovered, true)
  assert.equal(result.alreadyRecovered, false)
  assert.equal(result.credited, false)
  assert.equal(result.nextAction, 'check_eligibility')
  assert.equal(transaction.status, 'success')
  assert.equal(transaction.confirmedAmountKobo, 10000)
  assert.equal(transaction.confirmedCurrency, 'NGN')
  assert.equal(transaction.confirmedProvider, 'monnify')
  assert.equal(transaction.confirmedReference, REFERENCE)
  assert.equal(transaction.confirmedProviderRef, PROVIDER_REFERENCE)
  assert.equal(transaction.providerPaymentStatus, 'PAID')
  assert.ok(transaction.providerVerifiedAt instanceof Date)
  assert.ok(transaction.eligibilityRecoveredAt instanceof Date)
  assert.equal(transaction.reconciliationReason, "Currency mismatch: expected 'NGN', confirmed 'missing'")
  assert.equal(
    transaction.eligibilityRecoveryOriginalEvidence.reconciliationReason,
    transaction.reconciliationReason
  )
  assert.equal(transaction.eligibilityRecoveryOriginalEvidence.confirmedAmountKobo, 10000)
  assert.equal(state.providerCalls, 1)
  assert.equal(state.walletEffects, 0)
  assert.equal(state.committed, true)
  assert.equal(state.aborted, false)
  assert.equal(auditWrites.length, 1)
  assert.equal(auditWrites[0].action, 'MONNIFY_GATEWAY_TEST_RECOVERED')
  assert.equal(auditWrites[0].details.previousReconciliationReason, transaction.reconciliationReason)
  assert.equal(auditWrites[0].details.walletCredited, false)
  assert.equal(JSON.stringify(auditWrites[0]).includes(PROVIDER_REFERENCE), false)
})

for (const [name, override, code] of [
  ['pending payment', { success: false, status: 'pending', providerStatus: 'PENDING' }, 'MONNIFY_GATEWAY_TEST_RECOVERY_NOT_PAID'],
  ['failed payment', { success: false, status: 'failed', providerStatus: 'FAILED' }, 'MONNIFY_GATEWAY_TEST_RECOVERY_NOT_PAID'],
  ['wrong amount', { amount: 99 }, 'MONNIFY_GATEWAY_TEST_RECOVERY_EVIDENCE_MISMATCH'],
  ['missing currency', { currency: '' }, 'MONNIFY_GATEWAY_TEST_RECOVERY_EVIDENCE_MISMATCH'],
  ['wrong currency', { currency: 'USD' }, 'MONNIFY_GATEWAY_TEST_RECOVERY_EVIDENCE_MISMATCH'],
  ['wrong reference', { reference: 'DIFFERENT' }, 'MONNIFY_GATEWAY_TEST_RECOVERY_EVIDENCE_MISMATCH'],
  ['missing provider transaction reference', { providerTransactionId: '' }, 'MONNIFY_GATEWAY_TEST_RECOVERY_EVIDENCE_MISMATCH']
]) {
  test(`gateway-test recovery rejects ${name} and leaves manual review intact`, async t => {
    const { gateway, transaction, auditWrites, state } = installRecoveryHarness(t, {
      verification: providerResult(override)
    })

    await assert.rejects(
      paymentGatewayService.recoverGatewayTestReconciliation({
        gatewayId: gateway._id,
        reference: REFERENCE,
        adminId: ADMIN_ID
      }),
      error => error.code === code
    )

    assert.equal(transaction.status, 'reconciliation_required')
    assert.equal(state.released, true)
    assert.equal(state.walletEffects, 0)
    assert.equal(auditWrites.length, 0)
  })
}

test('missing encrypted snapshot and stale configuration fail before provider verification', async t => {
  const gateway = gatewayFixture()
  const transaction = transactionFixture(gateway)
  transaction.gatewayConfigSnapshot.secretKey = 'not-encrypted'
  const { state } = installRecoveryHarness(t, { gateway, transaction })

  await assert.rejects(
    paymentGatewayService.recoverGatewayTestReconciliation({
      gatewayId: gateway._id,
      reference: REFERENCE,
      adminId: ADMIN_ID
    }),
    error => error.code === 'MONNIFY_GATEWAY_TEST_RECOVERY_SNAPSHOT_INVALID'
  )
  assert.equal(state.providerCalls, 0)
})

test('provider-accepted initializing context recovers only with its original lease', async t => {
  const gateway = gatewayFixture()
  const transaction = transactionFixture(gateway)
  gateway.metadata.checkoutValidation = {
    ...gateway.metadata.checkoutValidation,
    status: 'initializing',
    reference: undefined,
    leaseToken: 'original-initialization-lease'
  }
  transaction.administrativeValidationLeaseToken = 'original-initialization-lease'
  const { state } = installRecoveryHarness(t, { gateway, transaction })

  const result = await paymentGatewayService.recoverGatewayTestReconciliation({
    gatewayId: gateway._id,
    reference: REFERENCE,
    adminId: ADMIN_ID
  })

  assert.equal(result.status, 'success')
  assert.equal(state.providerCalls, 1)
  assert.equal(state.committed, true)
})

test('an active recovery lease rejects a concurrent verifier without another provider query', async t => {
  const gateway = gatewayFixture()
  const transaction = transactionFixture(gateway)
  transaction.eligibilityVerificationLeaseToken = 'active-owner'
  transaction.eligibilityVerificationLeaseExpiresAt = new Date(Date.now() + 60_000)
  const { state } = installRecoveryHarness(t, {
    gateway,
    transaction,
    claimDenied: true
  })

  const result = await paymentGatewayService.recoverGatewayTestReconciliation({
    gatewayId: gateway._id,
    reference: REFERENCE,
    adminId: ADMIN_ID
  })

  assert.equal(result.status, 'processing')
  assert.equal(result.retryAllowed, true)
  assert.equal(state.providerCalls, 0)
  assert.equal(state.walletEffects, 0)
})

test('provider transaction reuse and unique-index races fail closed', async t => {
  const first = installRecoveryHarness(t, { providerReferenceReused: true })
  await assert.rejects(
    paymentGatewayService.recoverGatewayTestReconciliation({
      gatewayId: first.gateway._id,
      reference: REFERENCE,
      adminId: ADMIN_ID
    }),
    error => error.code === 'PAYMENT_PROVIDER_TRANSACTION_REUSED'
  )
  assert.equal(first.transaction.status, 'reconciliation_required')
  assert.equal(first.auditWrites.length, 0)
})

test('fresh verification cannot replace a provider transaction ID retained for manual review', async t => {
  const gateway = gatewayFixture()
  const transaction = transactionFixture(gateway)
  transaction.confirmedProvider = 'monnify'
  transaction.confirmedProviderRef = 'MNFY|ORIGINAL|PROVIDER'
  const result = installRecoveryHarness(t, { gateway, transaction })

  await assert.rejects(
    paymentGatewayService.recoverGatewayTestReconciliation({
      gatewayId: gateway._id,
      reference: REFERENCE,
      adminId: ADMIN_ID
    }),
    error => error.code === 'MONNIFY_GATEWAY_TEST_RECOVERY_EVIDENCE_MISMATCH'
  )

  assert.equal(transaction.status, 'reconciliation_required')
  assert.equal(transaction.confirmedProviderRef, 'MNFY|ORIGINAL|PROVIDER')
  assert.equal(result.state.ownerChecks, 0)
  assert.equal(result.state.released, true)
  assert.equal(result.auditWrites.length, 0)
  assert.equal(result.state.walletEffects, 0)
})

test('fresh verification cannot replace a retained provider namespace', async t => {
  const gateway = gatewayFixture()
  const transaction = transactionFixture(gateway)
  transaction.confirmedProvider = 'paystack'
  transaction.confirmedProviderRef = PROVIDER_REFERENCE
  const result = installRecoveryHarness(t, { gateway, transaction })

  await assert.rejects(
    paymentGatewayService.recoverGatewayTestReconciliation({
      gatewayId: gateway._id,
      reference: REFERENCE,
      adminId: ADMIN_ID
    }),
    error => error.code === 'MONNIFY_GATEWAY_TEST_RECOVERY_EVIDENCE_MISMATCH'
  )

  assert.equal(transaction.status, 'reconciliation_required')
  assert.equal(transaction.confirmedProvider, 'paystack')
  assert.equal(transaction.confirmedProviderRef, PROVIDER_REFERENCE)
  assert.equal(result.state.ownerChecks, 0)
  assert.equal(result.state.released, true)
  assert.equal(result.auditWrites.length, 0)
  assert.equal(result.state.walletEffects, 0)
})

test('provider transaction unique-index race aborts recovery and resolves to reuse', async t => {
  const result = installRecoveryHarness(t, { duplicateKeyOnFinalize: true })

  await assert.rejects(
    paymentGatewayService.recoverGatewayTestReconciliation({
      gatewayId: result.gateway._id,
      reference: REFERENCE,
      adminId: ADMIN_ID
    }),
    error => error.code === 'PAYMENT_PROVIDER_TRANSACTION_REUSED'
  )
  assert.equal(result.state.aborted, true)
  assert.equal(result.state.released, true)
  assert.equal(result.auditWrites.length, 0)
  assert.equal(result.state.walletEffects, 0)
})

test('gateway configuration fence rejects a stale verified result', async t => {
  const result = installRecoveryHarness(t, { gatewayFenceConflict: true })

  await assert.rejects(
    paymentGatewayService.recoverGatewayTestReconciliation({
      gatewayId: result.gateway._id,
      reference: REFERENCE,
      adminId: ADMIN_ID
    }),
    error => error.code === 'MONNIFY_GATEWAY_TEST_RECOVERY_CONFIGURATION_CONFLICT'
  )
  assert.equal(result.state.providerCalls, 1)
  assert.equal(result.state.aborted, true)
  assert.equal(result.state.released, true)
  assert.equal(result.transaction.status, 'reconciliation_required')
})

test('a different SuperAdmin cannot recover another operator gateway test', async t => {
  const result = installRecoveryHarness(t)

  await assert.rejects(
    paymentGatewayService.recoverGatewayTestReconciliation({
      gatewayId: result.gateway._id,
      reference: REFERENCE,
      adminId: new mongoose.Types.ObjectId()
    }),
    error => error.code === 'MONNIFY_GATEWAY_TEST_RECOVERY_OWNER_MISMATCH'
  )
  assert.equal(result.state.providerCalls, 0)
  assert.equal(result.state.transactionWrites, 0)
})

test('audit failure aborts the same transaction as recovery', async t => {
  const { gateway, state } = installRecoveryHarness(t, { auditFailure: true })

  await assert.rejects(
    paymentGatewayService.recoverGatewayTestReconciliation({
      gatewayId: gateway._id,
      reference: REFERENCE,
      adminId: ADMIN_ID
    }),
    /audit unavailable/
  )
  assert.equal(state.committed, false)
  assert.equal(state.aborted, true)
  assert.equal(state.released, true)
  assert.equal(state.walletEffects, 0)
})

test('already recovered gateway tests are idempotent without provider or audit repetition', async t => {
  const gateway = gatewayFixture()
  const transaction = transactionFixture(gateway)
  Object.assign(transaction, {
    status: 'success',
    confirmedAmountKobo: 10000,
    confirmedCurrency: 'NGN',
    confirmedProvider: 'monnify',
    confirmedReference: REFERENCE,
    confirmedProviderRef: PROVIDER_REFERENCE,
    providerPaymentStatus: 'PAID',
    providerVerifiedAt: new Date(),
    eligibilityRecoveredAt: new Date()
  })
  const { auditWrites, state } = installRecoveryHarness(t, { gateway, transaction })

  const result = await paymentGatewayService.recoverGatewayTestReconciliation({
    gatewayId: gateway._id,
    reference: REFERENCE,
    adminId: ADMIN_ID
  })

  assert.equal(result.alreadyRecovered, true)
  assert.equal(result.credited, false)
  assert.equal(state.providerCalls, 0)
  assert.equal(state.gatewayWrites, 0)
  assert.equal(state.transactionWrites, 0)
  assert.equal(auditWrites.length, 0)
})

test('recovery endpoint requires password reauthentication before service execution', async t => {
  const originals = {
    userFindById: User.findById,
    recovery: paymentGatewayService.recoverGatewayTestReconciliation
  }
  const passwordHash = await bcrypt.hash('correct-password', 4)
  let recoveryCalls = 0
  User.findById = () => queryResult({
    _id: new mongoose.Types.ObjectId(),
    status: true,
    role: 'superAdmin',
    roles: ['superAdmin'],
    password: passwordHash,
    name: 'Recovery Admin'
  })
  paymentGatewayService.recoverGatewayTestReconciliation = async () => {
    recoveryCalls++
    return { success: true, status: 'success' }
  }
  t.after(() => {
    User.findById = originals.userFindById
    paymentGatewayService.recoverGatewayTestReconciliation = originals.recovery
  })
  const res = response()

  await controller.recoverMonnifyGatewayTest({
    params: { id: 'gateway-monnify-recovery' },
    body: {
      reference: REFERENCE,
      currentPassword: 'wrong-password',
      confirmation: 'recover-monnify-test-gateway-payment'
    },
    user: { id: new mongoose.Types.ObjectId() },
    headers: {}
  }, res)

  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'SUPERADMIN_REAUTHENTICATION_FAILED')
  assert.equal(recoveryCalls, 0)
})

test('recovery route preserves JWT, SuperAdmin, limiter, and handler ordering', () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'adminPaymentGateway.js'),
    'utf8'
  )
  assert.match(
    routeSource,
    /router\.post\('\/:id\/recover-monnify-gateway-test', verifyJWT, checkRoles\('superAdmin'\), adminReauthenticationLimiter, recoverMonnifyGatewayTest\)/
  )
})
