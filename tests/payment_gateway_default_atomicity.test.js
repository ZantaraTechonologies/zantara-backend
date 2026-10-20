'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const mongoose = require('mongoose')
const PaymentGateway = require('../models/PaymentGateway')

function queryResult (value, state) {
  return {
    select () { return this },
    session (session) { state.querySession = session; return this },
    then (resolve, reject) { return Promise.resolve(value).then(resolve, reject) }
  }
}

function eligiblePaystack () {
  return {
    _id: 'gateway-paystack',
    code: 'paystack',
    adapterType: 'paystack',
    status: 'active',
    environment: 'test',
    metadata: {}
  }
}

function installModelMocks (t, {
  gateway = eligiblePaystack(),
  updateResult = { modifiedCount: 1 }
} = {}) {
  const originals = {
    findOne: PaymentGateway.findOne,
    updateMany: PaymentGateway.updateMany,
    updateOne: PaymentGateway.updateOne,
    startSession: mongoose.startSession
  }
  const state = { updates: [] }
  const session = {
    startTransaction () { state.started = true },
    async commitTransaction () { state.committed = true },
    async abortTransaction () { state.aborted = true },
    async endSession () { state.ended = true }
  }
  PaymentGateway.findOne = () => queryResult(gateway, state)
  PaymentGateway.updateMany = async (filter, update, options) => {
    state.updates.push({ method: 'updateMany', filter, update, options })
    return { modifiedCount: 1 }
  }
  PaymentGateway.updateOne = async (filter, update, options) => {
    state.updates.push({ method: 'updateOne', filter, update, options })
    return updateResult
  }
  mongoose.startSession = async () => session
  t.after(() => {
    PaymentGateway.findOne = originals.findOne
    PaymentGateway.updateMany = originals.updateMany
    PaymentGateway.updateOne = originals.updateOne
    mongoose.startSession = originals.startSession
  })
  return { state, session }
}

test('setDefault owns one transaction when no session is supplied', async t => {
  const { state, session } = installModelMocks(t)

  await PaymentGateway.setDefault('gateway-paystack')

  assert.equal(state.started, true)
  assert.equal(state.committed, true)
  assert.equal(state.aborted, undefined)
  assert.equal(state.ended, true)
  assert.equal(state.querySession, session)
  assert.equal(state.updates.length, 2)
  assert.equal(state.updates[0].options.session, session)
  assert.equal(state.updates[1].options.session, session)
})

test('setDefault aborts rather than committing a cleared default when target assignment fails', async t => {
  const { state } = installModelMocks(t, {
    updateResult: { modifiedCount: 0 }
  })

  await assert.rejects(
    PaymentGateway.setDefault('gateway-paystack'),
    /changed or is no longer eligible/
  )

  assert.equal(state.committed, undefined)
  assert.equal(state.aborted, true)
  assert.equal(state.ended, true)
})

test('setDefault participates in a supplied transaction without owning it', async t => {
  const { state } = installModelMocks(t)
  const supplied = {
    inTransaction: () => true,
    commitTransaction () { state.suppliedCommitted = true },
    abortTransaction () { state.suppliedAborted = true },
    endSession () { state.suppliedEnded = true }
  }

  await PaymentGateway.setDefault('gateway-paystack', { session: supplied })

  assert.equal(state.querySession, supplied)
  assert.equal(state.updates[0].options.session, supplied)
  assert.equal(state.updates[1].options.session, supplied)
  assert.equal(state.suppliedCommitted, undefined)
  assert.equal(state.suppliedAborted, undefined)
  assert.equal(state.suppliedEnded, undefined)
  assert.equal(state.started, undefined)
})

test('setDefault rejects a supplied session that is not in a transaction', async () => {
  await assert.rejects(
    PaymentGateway.setDefault('gateway-paystack', {
      session: { inTransaction: () => false }
    }),
    /must already be in a transaction/
  )
})

test('setDefault binds canonical Monnify to exact eligibility and configuration', async t => {
  const gateway = {
    _id: 'gateway-monnify',
    code: 'monnify',
    adapterType: 'monnify',
    status: 'active',
    environment: 'test',
    baseUrl: 'https://sandbox.monnify.com',
    virtualAccountMutationVersion: 7,
    metadata: {
      administrativeSandboxOnly: false,
      checkoutValidation: {
        status: 'verified',
        reference: 'MNFY_DEFAULT_TEST',
        gatewayId: 'gateway-monnify',
        environment: 'test',
        configurationVersion: 7,
        amountKobo: 10000,
        currency: 'NGN',
        provider: 'monnify',
        providerTransactionId: 'MNFY_DEFAULT_PROVIDER_TX'
      },
      customerFundingEligibility: {
        status: 'eligible',
        reference: 'MNFY_DEFAULT_TEST',
        gatewayId: 'gateway-monnify',
        environment: 'test',
        configurationVersion: 7,
        amountKobo: 10000,
        currency: 'NGN',
        provider: 'monnify',
        providerTransactionId: 'MNFY_DEFAULT_PROVIDER_TX'
      }
    }
  }
  const { state } = installModelMocks(t, { gateway })

  await PaymentGateway.setDefault(gateway._id)

  const target = state.updates.find(item => item.method === 'updateOne').filter
  assert.equal(target.code, 'monnify')
  assert.equal(target.adapterType, 'monnify')
  assert.equal(target.baseUrl, 'https://sandbox.monnify.com')
  assert.equal(target.virtualAccountMutationVersion, 7)
  assert.equal(target['metadata.customerFundingEligibility.gatewayId'], gateway._id)
  assert.equal(target['metadata.customerFundingEligibility.environment'], 'test')
  assert.equal(target['metadata.customerFundingEligibility.configurationVersion'], 7)
})
