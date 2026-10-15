'use strict'

const DISPOSITIONS = Object.freeze({
  DEFINITIVE: 'definitive_rejection',
  RETRYABLE: 'retryable',
  AMBIGUOUS: 'ambiguous_mutation'
})

function classifiedError ({ code, message, disposition, providerStatus, operation }) {
  const error = new Error(message)
  error.code = code
  error.paystackDvaDisposition = disposition
  error.retryable = disposition === DISPOSITIONS.RETRYABLE
  error.providerStatus = Number.isInteger(providerStatus) ? providerStatus : null
  error.operation = operation
  error.httpStatus = disposition === DISPOSITIONS.DEFINITIVE ? 422 : 503
  return error
}

function normalizePaystackDvaError (error, { operation = 'request', mutation = false } = {}) {
  if (error?.paystackDvaDisposition) return error

  const providerStatus = Number(error?.response?.status)
  const hasProviderStatus = Number.isInteger(providerStatus)
  const providerMessage = String(
    error?.response?.data?.message || error?.providerMessage || ''
  ).toLowerCase()
  const merchantRestricted = /(?:dedicated (?:account|nuban).*(?:not enabled|not available|not eligible|restricted))|(?:(?:merchant|business).*(?:not enabled|not eligible|restricted|cannot access))|(?:feature.*(?:not enabled|restricted))/.test(providerMessage)
  const invalidBank = /preferred.?bank|bank provider|bank/.test(providerMessage)
  const invalidCustomer = /customer|email|phone|first.?name|last.?name/.test(providerMessage)
  const providerRejected = [400, 404, 422].includes(providerStatus) || error?.providerDeclared

  if (error?.code === 'PAYSTACK_CONFIGURATION_INVALID') {
    return classifiedError({
      code: 'PAYSTACK_DVA_AUTHENTICATION_FAILED',
      message: 'Paystack DVA credentials are not configured.',
      disposition: DISPOSITIONS.DEFINITIVE,
      operation
    })
  }
  if (providerStatus === 401) {
    return classifiedError({
      code: 'PAYSTACK_DVA_AUTHENTICATION_FAILED',
      message: 'Paystack rejected the configured API credentials.',
      disposition: DISPOSITIONS.DEFINITIVE,
      providerStatus,
      operation
    })
  }
  if (providerStatus === 403 && merchantRestricted) {
    return classifiedError({
      code: 'PAYSTACK_DVA_MERCHANT_RESTRICTED',
      message: 'Paystack DVA access is not enabled for this merchant.',
      disposition: DISPOSITIONS.DEFINITIVE,
      providerStatus,
      operation
    })
  }
  if (providerStatus === 403) {
    return classifiedError({
      code: 'PAYSTACK_DVA_AUTHORIZATION_FAILED',
      message: 'Paystack denied access to the DVA operation.',
      disposition: DISPOSITIONS.DEFINITIVE,
      providerStatus,
      operation
    })
  }
  if (providerStatus === 429) {
    return classifiedError({
      code: 'PAYSTACK_DVA_RATE_LIMITED',
      message: 'Paystack temporarily rate-limited DVA provisioning.',
      disposition: DISPOSITIONS.RETRYABLE,
      providerStatus,
      operation
    })
  }
  if (hasProviderStatus && providerStatus >= 500) {
    return classifiedError({
      code: 'PAYSTACK_DVA_PROVIDER_UNAVAILABLE',
      message: 'Paystack is temporarily unavailable for DVA provisioning.',
      disposition: mutation ? DISPOSITIONS.AMBIGUOUS : DISPOSITIONS.RETRYABLE,
      providerStatus,
      operation
    })
  }
  if (mutation && /already (?:exists|assigned)|duplicate/.test(providerMessage)) {
    return classifiedError({
      code: 'PAYSTACK_DVA_MUTATION_AMBIGUOUS',
      message: 'Paystack reports an existing DVA operation; reconciliation is required.',
      disposition: DISPOSITIONS.AMBIGUOUS,
      providerStatus,
      operation
    })
  }
  if (mutation && [408, 409, 425].includes(providerStatus)) {
    return classifiedError({
      code: 'PAYSTACK_DVA_MUTATION_AMBIGUOUS',
      message: 'Paystack may have accepted the DVA request; reconciliation is required.',
      disposition: DISPOSITIONS.AMBIGUOUS,
      providerStatus,
      operation
    })
  }
  if (providerRejected && merchantRestricted) {
    return classifiedError({
      code: 'PAYSTACK_DVA_MERCHANT_RESTRICTED',
      message: 'Paystack DVA access is not enabled for this merchant.',
      disposition: DISPOSITIONS.DEFINITIVE,
      providerStatus,
      operation
    })
  }
  if (providerRejected && invalidBank) {
    return classifiedError({
      code: 'PAYSTACK_DVA_BANK_INVALID',
      message: 'Paystack rejected the selected DVA bank.',
      disposition: DISPOSITIONS.DEFINITIVE,
      providerStatus,
      operation
    })
  }
  if (providerRejected && invalidCustomer) {
    return classifiedError({
      code: 'PAYSTACK_DVA_CUSTOMER_INVALID',
      message: 'Paystack rejected the DVA customer details.',
      disposition: DISPOSITIONS.DEFINITIVE,
      providerStatus,
      operation
    })
  }
  if (hasProviderStatus || error?.providerDeclared) {
    return classifiedError({
      code: 'PAYSTACK_DVA_PROVIDER_REJECTED',
      message: 'Paystack rejected the DVA provisioning request.',
      disposition: DISPOSITIONS.DEFINITIVE,
      providerStatus,
      operation
    })
  }

  return classifiedError({
    code: mutation
      ? 'PAYSTACK_DVA_MUTATION_AMBIGUOUS'
      : 'PAYSTACK_DVA_PROVIDER_UNAVAILABLE',
    message: mutation
      ? 'The Paystack DVA request outcome is unknown; reconciliation is required.'
      : 'Paystack is temporarily unavailable for DVA provisioning.',
    disposition: mutation ? DISPOSITIONS.AMBIGUOUS : DISPOSITIONS.RETRYABLE,
    operation
  })
}

function providerDeclaredPaystackError (response) {
  return {
    providerDeclared: true,
    providerMessage: response?.data?.message,
    response: {
      status: Number(response?.status) || 422,
      data: { message: response?.data?.message }
    }
  }
}

module.exports = {
  DISPOSITIONS,
  normalizePaystackDvaError,
  providerDeclaredPaystackError
}
