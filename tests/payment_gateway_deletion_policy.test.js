'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const mongoose = require('mongoose')
const PaymentGateway = require('../models/PaymentGateway')
const TransactionStatus = require('../models/TransactionStatus')
const adminPaymentGatewayController = require('../controllers/adminPaymentGatewayController')
const paymentGatewayService = require('../services/paymentGateway.service')

function queryResult (value) {
  return {
    select () { return this },
    session () { return Promise.resolve(value) },
    then (resolve, reject) { return Promise.resolve(value).then(resolve, reject) }
  }
}

function response () {
  return {
    statusCode: 200,
    body: null,
    status (code) {
      this.statusCode = code
      return this
    },
    json (body) {
      this.body = body
      return this
    }
  }
}

function deleteRequest (gateway) {
  return {
    params: { id: gateway._id },
    user: { id: 'super-admin-1', name: 'Super Admin' },
    headers: {},
    ip: '127.0.0.1'
  }
}

test('hard deletion is rejected while gateway initialization evidence is active', async t => {
  const originals = {
    findById: PaymentGateway.findById,
    findByIdAndDelete: PaymentGateway.findByIdAndDelete
  }
  const gateway = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Monnify',
    code: 'monnify',
    status: 'inactive',
    metadata: {
      checkoutValidation: {
        status: 'initializing',
        leaseToken: 'active-initialization-lease'
      }
    }
  }
  let destructiveCall = false
  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.findByIdAndDelete = async () => {
    destructiveCall = true
    return gateway
  }
  t.after(() => {
    PaymentGateway.findById = originals.findById
    PaymentGateway.findByIdAndDelete = originals.findByIdAndDelete
  })

  const res = response()
  await adminPaymentGatewayController.deleteGateway(deleteRequest(gateway), res)

  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'PAYMENT_GATEWAY_HARD_DELETE_DISABLED')
  assert.equal(res.body.allowedAction.status, 'inactive')
  assert.equal(destructiveCall, false)
})

test('model middleware rejects direct payment-gateway hard deletes', async () => {
  const id = new mongoose.Types.ObjectId()
  const isPolicyError = error =>
    error.code === 'PAYMENT_GATEWAY_HARD_DELETE_DISABLED' &&
    error.statusCode === 409

  await assert.rejects(PaymentGateway.deleteOne({ _id: id }), isPolicyError)
  await assert.rejects(PaymentGateway.deleteMany({}), isPolicyError)
  await assert.rejects(PaymentGateway.findOneAndDelete({ _id: id }), isPolicyError)
  await assert.rejects(
    PaymentGateway.bulkWrite([{ deleteOne: { filter: { _id: id } } }]),
    isPolicyError
  )
})

test('deactivated gateway cannot initialize a new customer payment', async t => {
  const originals = {
    getGateway: paymentGatewayService.getGateway,
    transactionCreate: TransactionStatus.create
  }
  let transactionCreated = false
  paymentGatewayService.getGateway = async () => ({
    _id: 'gateway-paystack',
    name: 'Paystack',
    code: 'paystack',
    adapterType: 'paystack',
    status: 'inactive',
    environment: 'test',
    supportedChannels: ['card'],
    metadata: {}
  })
  TransactionStatus.create = async () => {
    transactionCreated = true
  }
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
    { code: 'PAYMENT_GATEWAY_INACTIVE' }
  )
  assert.equal(transactionCreated, false)
})

test('hard deletion during historical verification is rejected without interrupting snapshot settlement', async t => {
  const originals = {
    findById: PaymentGateway.findById,
    findByIdAndDelete: PaymentGateway.findByIdAndDelete,
    transactionFindOne: TransactionStatus.findOne,
    getGateway: paymentGatewayService.getGateway,
    getAdapterInstance: paymentGatewayService.getAdapterInstance,
    finalizeFundingCredit: paymentGatewayService.finalizeFundingCredit
  }
  const previousEnvironment = process.env.PAYMENT_GATEWAY_ENVIRONMENT
  process.env.PAYMENT_GATEWAY_ENVIRONMENT = 'test'
  const gateway = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Paystack',
    code: 'paystack',
    adapterType: 'paystack',
    status: 'inactive',
    environment: 'test'
  }
  const transaction = {
    refId: 'HISTORICAL-SNAPSHOT-REFERENCE',
    userId: 'customer-1',
    type: 'funding',
    status: 'pending',
    provider: 'paystack',
    amountKobo: 10000,
    expectedCurrency: 'NGN',
    gatewayConfigSnapshot: {
      gatewayId: String(gateway._id),
      name: 'Paystack',
      code: 'paystack',
      adapterType: 'paystack',
      environment: 'test',
      baseUrl: 'https://api.paystack.co',
      supportedChannels: ['card'],
      metadata: {},
      configurationVersion: 2
    }
  }
  let verificationStarted
  const started = new Promise(resolve => { verificationStarted = resolve })
  let releaseVerification
  const release = new Promise(resolve => { releaseVerification = resolve })
  let currentGatewayLoaded = false
  let destructiveCall = false

  PaymentGateway.findById = () => queryResult(gateway)
  PaymentGateway.findByIdAndDelete = async () => {
    destructiveCall = true
    return gateway
  }
  TransactionStatus.findOne = () => queryResult(transaction)
  paymentGatewayService.getGateway = async () => {
    currentGatewayLoaded = true
    return gateway
  }
  paymentGatewayService.getAdapterInstance = snapshot => ({
    async verifyPayment (reference) {
      assert.equal(snapshot.code, 'paystack')
      assert.equal(reference, transaction.refId)
      verificationStarted()
      await release
      return {
        status: 'success',
        reference,
        amount: 100,
        currency: 'NGN',
        providerTransactionId: 'PAYSTACK-HISTORICAL-TX'
      }
    }
  })
  paymentGatewayService.finalizeFundingCredit = async () => ({
    status: 'success',
    amount: 100
  })
  t.after(() => {
    PaymentGateway.findById = originals.findById
    PaymentGateway.findByIdAndDelete = originals.findByIdAndDelete
    TransactionStatus.findOne = originals.transactionFindOne
    paymentGatewayService.getGateway = originals.getGateway
    paymentGatewayService.getAdapterInstance = originals.getAdapterInstance
    paymentGatewayService.finalizeFundingCredit = originals.finalizeFundingCredit
    if (previousEnvironment === undefined) delete process.env.PAYMENT_GATEWAY_ENVIRONMENT
    else process.env.PAYMENT_GATEWAY_ENVIRONMENT = previousEnvironment
  })

  const verification = paymentGatewayService.verifyFunding(transaction.refId)
  await started

  const res = response()
  await adminPaymentGatewayController.deleteGateway(deleteRequest(gateway), res)
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'PAYMENT_GATEWAY_HARD_DELETE_DISABLED')
  assert.equal(destructiveCall, false)

  releaseVerification()
  const result = await verification
  assert.equal(result.status, 'success')
  assert.equal(currentGatewayLoaded, false)
})

test('retained gateway records preserve code and name uniqueness', () => {
  assert.equal(PaymentGateway.schema.path('code').options.unique, true)
  assert.equal(PaymentGateway.schema.path('name').options.unique, true)
})
