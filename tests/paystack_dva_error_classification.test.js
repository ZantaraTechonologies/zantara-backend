'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const axios = require('axios')
const PaystackAdapter = require('../adapters/payment/paystack.adapter')
const {
  normalizePaystackDvaError
} = require('../utils/paystackDvaError')

const responseError = (status, message) => ({
  response: { status, data: { message } }
})

test('Paystack DVA errors have stable sanitized codes and dispositions', () => {
  const cases = [
    [responseError(401, 'invalid key sk_live_private'), 'PAYSTACK_DVA_AUTHENTICATION_FAILED', 'definitive_rejection'],
    [responseError(403, 'access denied'), 'PAYSTACK_DVA_AUTHORIZATION_FAILED', 'definitive_rejection'],
    [responseError(403, 'dedicated accounts not enabled for merchant'), 'PAYSTACK_DVA_MERCHANT_RESTRICTED', 'definitive_rejection'],
    [responseError(422, 'customer code is invalid'), 'PAYSTACK_DVA_CUSTOMER_INVALID', 'definitive_rejection'],
    [responseError(400, 'preferred bank is invalid'), 'PAYSTACK_DVA_BANK_INVALID', 'definitive_rejection'],
    [responseError(429, 'limit'), 'PAYSTACK_DVA_RATE_LIMITED', 'retryable'],
    [responseError(503, 'upstream outage'), 'PAYSTACK_DVA_PROVIDER_UNAVAILABLE', 'ambiguous_mutation'],
    [responseError(422, 'request cannot be completed'), 'PAYSTACK_DVA_PROVIDER_REJECTED', 'definitive_rejection'],
    [{ code: 'PAYSTACK_CONFIGURATION_INVALID' }, 'PAYSTACK_DVA_AUTHENTICATION_FAILED', 'definitive_rejection'],
    [responseError(400, 'dedicated account already exists'), 'PAYSTACK_DVA_MUTATION_AMBIGUOUS', 'ambiguous_mutation'],
    [{ code: 'ETIMEDOUT', message: 'socket included private payload' }, 'PAYSTACK_DVA_MUTATION_AMBIGUOUS', 'ambiguous_mutation']
  ]

  for (const [source, code, disposition] of cases) {
    const normalized = normalizePaystackDvaError(source, {
      operation: 'create_dedicated_account',
      mutation: true
    })
    assert.equal(normalized.code, code)
    assert.equal(normalized.paystackDvaDisposition, disposition)
    assert.doesNotMatch(normalized.message, /sk_live_private|socket included private payload/)
    assert.equal(Object.hasOwn(normalized, 'response'), false)
  }
})

test('read outage is retryable while mutation outage remains ambiguous', () => {
  const source = responseError(503, 'outage')
  const read = normalizePaystackDvaError(source, { operation: 'fetch_customer' })
  const mutation = normalizePaystackDvaError(source, {
    operation: 'create_customer',
    mutation: true
  })

  assert.equal(read.paystackDvaDisposition, 'retryable')
  assert.equal(read.retryable, true)
  assert.equal(mutation.paystackDvaDisposition, 'ambiguous_mutation')
  assert.equal(mutation.retryable, false)
})

test('Paystack adapter normalizes provider-declared and transport DVA failures', async t => {
  const originalPost = axios.post
  t.after(() => { axios.post = originalPost })
  const adapter = new PaystackAdapter({
    baseUrl: 'https://api.paystack.test',
    secretKey: 'sk_test_fake'
  })
  const request = {
    customer: 'CUS_test',
    preferredBank: 'wema-bank',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '+2348012345678'
  }

  axios.post = async () => ({
    status: 200,
    data: {
      status: false,
      message: 'Dedicated accounts are restricted for this business'
    }
  })
  await assert.rejects(
    adapter.createDedicatedVirtualAccount(request),
    error => error.code === 'PAYSTACK_DVA_MERCHANT_RESTRICTED'
      && error.paystackDvaDisposition === 'definitive_rejection'
  )

  axios.post = async () => {
    const error = new Error('connect ETIMEDOUT with private request data')
    error.code = 'ETIMEDOUT'
    throw error
  }
  await assert.rejects(
    adapter.createDedicatedVirtualAccount(request),
    error => error.code === 'PAYSTACK_DVA_MUTATION_AMBIGUOUS'
      && error.paystackDvaDisposition === 'ambiguous_mutation'
      && !error.message.includes('private request data')
  )
})
