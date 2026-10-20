'use strict'

const mongoose = require('mongoose')

const MONNIFY_BASE_URLS = Object.freeze({
  test: 'https://sandbox.monnify.com',
  live: 'https://api.monnify.com'
})

function plainMetadata (gateway) {
  const metadata = gateway?.metadata
  return metadata instanceof Map ? Object.fromEntries(metadata) : metadata || {}
}

function configurationVersion (gateway) {
  return Number(
    gateway?.configurationVersion ??
    gateway?.virtualAccountMutationVersion ??
    0
  )
}

function isCanonicalMonnify (gateway) {
  return String(gateway?.code || '').toLowerCase() === 'monnify' &&
    String(gateway?.adapterType || '').toLowerCase() === 'monnify'
}

function hasExactMonnifyEligibility (gateway) {
  if (!isCanonicalMonnify(gateway)) return true
  if (
    !['test', 'live'].includes(gateway?.environment) ||
    gateway?.baseUrl !== MONNIFY_BASE_URLS[gateway.environment]
  ) return false
  const metadata = plainMetadata(gateway)
  const eligibility = metadata.customerFundingEligibility
  const checkout = metadata.checkoutValidation
  if (!eligibility || typeof eligibility !== 'object') return false
  if (!checkout || typeof checkout !== 'object') return false
  const gatewayId = String(gateway._id || gateway.gatewayId || '')
  const version = configurationVersion(gateway)
  const providerTransactionId = String(eligibility.providerTransactionId || '')
  const reference = String(eligibility.reference || '')
  return eligibility.status === 'eligible' &&
    String(eligibility.gatewayId || '') === gatewayId &&
    eligibility.environment === gateway.environment &&
    Number(eligibility.configurationVersion) === version &&
    reference.length > 0 &&
    Number.isSafeInteger(eligibility.amountKobo) &&
    eligibility.amountKobo > 0 &&
    eligibility.currency === 'NGN' &&
    eligibility.provider === 'monnify' &&
    providerTransactionId.length > 0 &&
    checkout.status === 'verified' &&
    checkout.reference === reference &&
    String(checkout.gatewayId || '') === gatewayId &&
    checkout.environment === gateway.environment &&
    Number(checkout.configurationVersion) === version &&
    checkout.amountKobo === eligibility.amountKobo &&
    checkout.currency === eligibility.currency &&
    checkout.provider === eligibility.provider &&
    String(checkout.providerTransactionId || '') === providerTransactionId
}

function resolveCustomerFundingEnvironment () {
  const configured = String(process.env.PAYMENT_GATEWAY_ENVIRONMENT || '')
    .trim()
    .toLowerCase()
  if (configured && configured !== 'test' && configured !== 'live') {
    const error = new Error("PAYMENT_GATEWAY_ENVIRONMENT must be 'test' or 'live'")
    error.code = 'PAYMENT_GATEWAY_RUNTIME_ENVIRONMENT_INVALID'
    throw error
  }

  const nodeEnvironment = String(process.env.NODE_ENV || 'development')
    .trim()
    .toLowerCase()
  const requireLiveValue = String(process.env.PAYMENT_GATEWAY_REQUIRE_LIVE || '')
    .trim()
    .toLowerCase()
  const databaseName = String(mongoose.connection?.name || '').trim().toLowerCase()
  const databaseEnvironment = databaseName === 'test' ? 'test' : null
  let deploymentEnvironment = null

  if (configured && ['true', 'false'].includes(requireLiveValue)) {
    const requiredEnvironment = requireLiveValue === 'true' ? 'live' : 'test'
    if (configured !== requiredEnvironment) {
      const error = new Error(
        `PAYMENT_GATEWAY_ENVIRONMENT '${configured}' conflicts with PAYMENT_GATEWAY_REQUIRE_LIVE`
      )
      error.code = 'PAYMENT_GATEWAY_RUNTIME_ENVIRONMENT_MISMATCH'
      throw error
    }
  }

  if (nodeEnvironment === 'production') {
    deploymentEnvironment = 'live'
  } else if (nodeEnvironment === 'staging') {
    if (!['true', 'false'].includes(requireLiveValue)) {
      const error = new Error(
        'PAYMENT_GATEWAY_REQUIRE_LIVE must resolve the staging payment environment'
      )
      error.code = 'PAYMENT_GATEWAY_RUNTIME_ENVIRONMENT_INVALID'
      throw error
    }
    deploymentEnvironment = requireLiveValue === 'true' ? 'live' : 'test'
  }

  const expected = deploymentEnvironment || databaseEnvironment
  if (configured && expected && configured !== expected) {
    const error = new Error(
      `PAYMENT_GATEWAY_ENVIRONMENT '${configured}' conflicts with resolved '${expected}' environment`
    )
    error.code = 'PAYMENT_GATEWAY_RUNTIME_ENVIRONMENT_MISMATCH'
    throw error
  }
  if (
    deploymentEnvironment &&
    databaseEnvironment &&
    deploymentEnvironment !== databaseEnvironment
  ) {
    const error = new Error(
      `Deployment environment '${deploymentEnvironment}' conflicts with connected database environment '${databaseEnvironment}'`
    )
    error.code = 'PAYMENT_GATEWAY_RUNTIME_ENVIRONMENT_MISMATCH'
    throw error
  }

  if (configured) return configured
  if (deploymentEnvironment) return deploymentEnvironment
  if (databaseEnvironment) return databaseEnvironment
  return null
}

function isCustomerFundingEligible (gateway) {
  if (!gateway || gateway.status !== 'active') return false
  const metadata = plainMetadata(gateway)
  if (metadata.administrativeSandboxOnly === true) return false

  const runtimeEnvironment = resolveCustomerFundingEnvironment()
  if (runtimeEnvironment && gateway.environment !== runtimeEnvironment) return false
  if (!isCanonicalMonnify(gateway)) return true
  return hasExactMonnifyEligibility(gateway)
}

module.exports = {
  MONNIFY_BASE_URLS,
  plainMetadata,
  configurationVersion,
  isCanonicalMonnify,
  hasExactMonnifyEligibility,
  isCustomerFundingEligible,
  resolveCustomerFundingEnvironment
}
