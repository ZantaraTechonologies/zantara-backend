'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const mongoose = require('mongoose')
const TransactionStatus = require('../models/TransactionStatus')
const PaymentGateway = require('../models/PaymentGateway')
const paymentGatewayService = require('../services/paymentGateway.service')
const { VirtualAccountService } = require('../services/virtualAccount.service')
const {
  isCustomerFundingEligible,
  resolveCustomerFundingEnvironment
} = require('../utils/paymentGatewayEligibility')

function withRuntimeEnvironment (t, value) {
  const previous = process.env.PAYMENT_GATEWAY_ENVIRONMENT
  process.env.PAYMENT_GATEWAY_ENVIRONMENT = value
  t.after(() => {
    if (previous === undefined) delete process.env.PAYMENT_GATEWAY_ENVIRONMENT
    else process.env.PAYMENT_GATEWAY_ENVIRONMENT = previous
  })
}

function withEnvironmentValues (t, values) {
  const previous = Object.fromEntries(
    Object.keys(values).map(key => [key, process.env[key]])
  )
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('explicit runtime environment filters normal customer gateway selection', async t => {
  withRuntimeEnvironment(t, 'test')
  const originals = {
    getGateway: paymentGatewayService.getGateway,
    transactionCreate: TransactionStatus.create
  }
  let transactionCreated = false
  paymentGatewayService.getGateway = async () => ({
    _id: 'gateway-paystack-live',
    code: 'paystack',
    adapterType: 'paystack',
    name: 'Paystack Live',
    status: 'active',
    environment: 'live',
    supportedChannels: ['card'],
    metadata: {}
  })
  TransactionStatus.create = async () => { transactionCreated = true }
  t.after(() => {
    paymentGatewayService.getGateway = originals.getGateway
    TransactionStatus.create = originals.transactionCreate
  })

  await assert.rejects(
    paymentGatewayService.initializeFunding({
      gatewayCode: 'paystack',
      user: { _id: 'customer-1', email: 'customer@example.test' },
      amount: 100
    }),
    { code: 'PAYMENT_GATEWAY_CUSTOMER_FUNDING_INELIGIBLE' }
  )
  assert.equal(transactionCreated, false)
})

test('normal settlement rejects a transaction snapshot from another runtime environment', t => {
  withRuntimeEnvironment(t, 'live')
  assert.throws(
    () => paymentGatewayService._assertSettlementEnvironment({
      type: 'funding',
      gatewayConfigSnapshot: { environment: 'test' }
    }),
    { code: 'PAYMENT_GATEWAY_RUNTIME_ENVIRONMENT_MISMATCH' }
  )
})

test('resolved runtime settlement rejects a missing snapshot environment', t => {
  withRuntimeEnvironment(t, 'live')
  assert.throws(
    () => paymentGatewayService._assertSettlementEnvironment({
      type: 'funding',
      gatewayConfigSnapshot: {}
    }),
    { code: 'PAYMENT_GATEWAY_RUNTIME_ENVIRONMENT_MISMATCH' }
  )
})

test('gateway-test settlement remains non-creditable and environment-independent', t => {
  withRuntimeEnvironment(t, 'live')
  assert.doesNotThrow(() => paymentGatewayService._assertSettlementEnvironment({
    type: 'gateway_test',
    gatewayConfigSnapshot: { environment: 'test' }
  }))
})

test('structured Monnify eligibility is invalid after configuration version changes', t => {
  withRuntimeEnvironment(t, 'test')
  const gateway = {
    _id: 'gateway-monnify',
    code: 'monnify',
    adapterType: 'monnify',
    status: 'active',
    environment: 'test',
    virtualAccountMutationVersion: 8,
    metadata: {
      administrativeSandboxOnly: false,
      checkoutValidation: {
        status: 'verified',
        reference: 'MNFY_VERSION_TEST',
        gatewayId: 'gateway-monnify',
        environment: 'test',
        configurationVersion: 7,
        amountKobo: 10000,
        currency: 'NGN',
        provider: 'monnify',
        providerTransactionId: 'MNFY_VERSION_PROVIDER_TX'
      },
      customerFundingEligibility: {
        status: 'eligible',
        reference: 'MNFY_VERSION_TEST',
        gatewayId: 'gateway-monnify',
        environment: 'test',
        configurationVersion: 7,
        amountKobo: 10000,
        currency: 'NGN',
        provider: 'monnify',
        providerTransactionId: 'MNFY_VERSION_PROVIDER_TX'
      }
    }
  }
  assert.equal(isCustomerFundingEligible(gateway), false)
})

test('structured Monnify eligibility requires the exact environment API base', t => {
  withRuntimeEnvironment(t, 'test')
  const evidence = {
    status: 'eligible',
    reference: 'MNFY_HOST_TEST',
    gatewayId: 'gateway-monnify',
    environment: 'test',
    configurationVersion: 7,
    amountKobo: 10000,
    currency: 'NGN',
    provider: 'monnify',
    providerTransactionId: 'MNFY_HOST_PROVIDER_TX'
  }
  const gateway = {
    _id: 'gateway-monnify',
    code: 'monnify',
    adapterType: 'monnify',
    status: 'active',
    environment: 'test',
    baseUrl: 'https://api.monnify.com',
    virtualAccountMutationVersion: 7,
    metadata: {
      administrativeSandboxOnly: false,
      checkoutValidation: { ...evidence, status: 'verified' },
      customerFundingEligibility: evidence
    }
  }

  assert.equal(isCustomerFundingEligible(gateway), false)
  gateway.baseUrl = 'https://sandbox.monnify.com'
  assert.equal(isCustomerFundingEligible(gateway), true)
})

test('canonical Monnify without structured eligibility fails closed', t => {
  withRuntimeEnvironment(t, 'test')
  assert.equal(isCustomerFundingEligible({
    _id: 'gateway-monnify',
    code: 'monnify',
    adapterType: 'monnify',
    status: 'active',
    environment: 'test',
    metadata: {}
  }), false)
})

test('legacy environment-backed Monnify is disabled', async t => {
  const originals = { countDocuments: PaymentGateway.countDocuments }
  const keys = ['MONNIFY_API_KEY', 'MONNIFY_SECRET_KEY', 'MONNIFY_BASE_URL']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.MONNIFY_API_KEY = 'legacy-key'
  process.env.MONNIFY_SECRET_KEY = 'legacy-secret'
  process.env.MONNIFY_BASE_URL = 'https://example.invalid'
  PaymentGateway.countDocuments = async () => 0
  t.after(() => {
    PaymentGateway.countDocuments = originals.countDocuments
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })

  assert.equal(await paymentGatewayService.getGateway('monnify'), null)
})

test('staging derives its payment environment from require-live mode', t => {
  withEnvironmentValues(t, {
    NODE_ENV: 'staging',
    PAYMENT_GATEWAY_REQUIRE_LIVE: 'false',
    PAYMENT_GATEWAY_ENVIRONMENT: undefined
  })
  assert.equal(resolveCustomerFundingEnvironment(), 'test')
})

test('a connected database named test resolves the development fence to test', t => {
  withEnvironmentValues(t, {
    NODE_ENV: 'development',
    PAYMENT_GATEWAY_REQUIRE_LIVE: undefined,
    PAYMENT_GATEWAY_ENVIRONMENT: undefined
  })
  const previousName = mongoose.connection.name
  mongoose.connection.name = 'test'
  t.after(() => { mongoose.connection.name = previousName })
  assert.equal(resolveCustomerFundingEnvironment(), 'test')
})

test('production rejects an explicit test payment environment', t => {
  withEnvironmentValues(t, {
    NODE_ENV: 'production',
    PAYMENT_GATEWAY_REQUIRE_LIVE: 'true',
    PAYMENT_GATEWAY_ENVIRONMENT: 'test'
  })
  assert.throws(
    () => resolveCustomerFundingEnvironment(),
    { code: 'PAYMENT_GATEWAY_RUNTIME_ENVIRONMENT_MISMATCH' }
  )
})

test('production rejects a connected database named test before serving traffic', t => {
  withEnvironmentValues(t, {
    NODE_ENV: 'production',
    PAYMENT_GATEWAY_REQUIRE_LIVE: 'true',
    PAYMENT_GATEWAY_ENVIRONMENT: undefined
  })
  const previousName = mongoose.connection.name
  mongoose.connection.name = 'test'
  t.after(() => { mongoose.connection.name = previousName })

  assert.throws(
    () => resolveCustomerFundingEnvironment(),
    { code: 'PAYMENT_GATEWAY_RUNTIME_ENVIRONMENT_MISMATCH' }
  )
})

test('invalid explicit runtime environment fails closed', t => {
  withRuntimeEnvironment(t, 'sandbox')
  assert.throws(
    () => resolveCustomerFundingEnvironment(),
    { code: 'PAYMENT_GATEWAY_RUNTIME_ENVIRONMENT_INVALID' }
  )
})

test('snapshot-bound verification does not depend on the gateway remaining active', async t => {
  withRuntimeEnvironment(t, 'test')
  const originals = {
    transactionFindOne: TransactionStatus.findOne,
    getGateway: paymentGatewayService.getGateway,
    getAdapterInstance: paymentGatewayService.getAdapterInstance,
    finalizeFundingCredit: paymentGatewayService.finalizeFundingCredit
  }
  const transaction = {
    refId: 'MAINTENANCE_SNAPSHOT_REFERENCE',
    userId: 'customer-1',
    type: 'funding',
    status: 'pending',
    provider: 'monnify',
    amountKobo: 10000,
    expectedCurrency: 'NGN',
    gatewayConfigSnapshot: {
      gatewayId: 'gateway-monnify',
      code: 'monnify',
      adapterType: 'monnify',
      environment: 'test',
      publicKey: 'MK_TEST',
      secretKey: '',
      metadata: { contractCode: '123456' },
      configurationVersion: 4
    }
  }
  TransactionStatus.findOne = () => ({
    select () { return this },
    then (resolve, reject) { return Promise.resolve(transaction).then(resolve, reject) }
  })
  paymentGatewayService.getGateway = async () => {
    throw new Error('current maintenance gateway must not be loaded')
  }
  paymentGatewayService.getAdapterInstance = gateway => ({
    async verifyPayment () {
      assert.equal(gateway.configurationVersion, 4)
      return {
        status: 'success',
        reference: transaction.refId,
        amount: 100,
        currency: 'NGN',
        providerTransactionId: 'MNFY_PROVIDER_REFERENCE'
      }
    }
  })
  paymentGatewayService.finalizeFundingCredit = async ({ gatewayPaymentResult }) => {
    assert.equal(gatewayPaymentResult.gateway, 'monnify')
    return { status: 'success', amount: 100 }
  }
  t.after(() => {
    TransactionStatus.findOne = originals.transactionFindOne
    paymentGatewayService.getGateway = originals.getGateway
    paymentGatewayService.getAdapterInstance = originals.getAdapterInstance
    paymentGatewayService.finalizeFundingCredit = originals.finalizeFundingCredit
  })

  const result = await paymentGatewayService.verifyFunding(transaction.refId)
  assert.equal(result.status, 'success')
})

test('virtual-account provisioning rejects an admin-isolated gateway before dispatch', async t => {
  withRuntimeEnvironment(t, 'test')
  let adapterRequested = false
  const gateway = {
    _id: 'gateway-monnify',
    code: 'monnify',
    adapterType: 'monnify',
    status: 'active',
    environment: 'test',
    metadata: { administrativeSandboxOnly: true }
  }
  const service = new VirtualAccountService({
    repository: {
      async getUser () { return { _id: 'customer-1', virtualAccounts: [] } },
      async listScope () { return [] },
      async listLegacyUnverified () { return [] }
    },
    gatewayService: {
      async getGateway () { return gateway },
      _isCustomerFundingEligible: candidate => paymentGatewayService._isCustomerFundingEligible(candidate),
      getAdapterInstance () { adapterRequested = true; return {} }
    }
  })
  service._assertOnboardingEligibility = async () => null

  await assert.rejects(
    service.provision({
      userId: 'customer-1',
      providerCode: 'monnify',
      consent: true
    }),
    { code: 'VIRTUAL_ACCOUNT_GATEWAY_CUSTOMER_FUNDING_INELIGIBLE' }
  )
  assert.equal(adapterRequested, false)
})

test('an existing active virtual account remains readable without provider dispatch', async t => {
  withRuntimeEnvironment(t, 'test')
  let adapterRequested = false
  const account = {
    provider: 'monnify',
    gatewayId: 'gateway-monnify',
    accountReference: 'VIRTUAL_507f1f77bcf86cd799439011',
    accountNumber: '1234567890',
    accountName: 'Test Customer',
    bankName: 'Test Bank',
    provisioningStatus: 'active',
    active: true,
    assigned: true,
    currency: 'NGN'
  }
  const service = new VirtualAccountService({
    repository: {
      async getUser () { return { _id: 'customer-1', virtualAccounts: [account] } },
      async listScope () { return [account] },
      async listLegacyUnverified () { return [] }
    },
    gatewayService: {
      async getGateway () {
        return {
          _id: 'gateway-monnify',
          code: 'monnify',
          adapterType: 'monnify',
          status: 'maintenance',
          environment: 'test',
          metadata: { administrativeSandboxOnly: true }
        }
      },
      _isCustomerFundingEligible () { return false },
      getAdapterInstance () { adapterRequested = true; return {} }
    }
  })
  service._assertOnboardingEligibility = async () => null

  const result = await service.provision({
    userId: 'customer-1',
    providerCode: 'monnify'
  })
  assert.equal(result.status, 'active')
  assert.equal(result.existing, true)
  assert.equal(adapterRequested, false)
})
