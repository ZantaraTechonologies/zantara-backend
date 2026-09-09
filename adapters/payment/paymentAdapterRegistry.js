'use strict';

/**
 * paymentAdapterRegistry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for all registered payment gateway adapters in Zantara.
 *
 * HOW TO ADD A NEW ADAPTER
 * ─────────────────────────
 * 1. Create   adapters/payment/<name>.adapter.js  extending BasePaymentAdapter
 * 2. Add an   entry below in ADAPTER_REGISTRY
 * 3. Register the adapter class in paymentGateway.service.js constructor
 * 4. No frontend changes needed — the /capabilities endpoint auto-exposes it.
 *
 * FIELD DEFINITIONS
 * ─────────────────
 * credentialFields:
 *   key          — matches the field name in the DB model (publicKey / secretKey / webhookSecret)
 *   label        — human-readable label shown in Admin UI
 *   type         — 'text' | 'password'
 *   sensitive    — true means it is AES-256-GCM encrypted at rest; blank on edit = retain
 *   required     — whether the adapter requires this field to function
 *
 * metadataFields:
 *   key          — stored inside gateway.metadata[key]
 *   label        — human-readable label shown in Admin UI
 *   type         — 'text' | 'password'
 *   sensitive    — true means it will be treated as a secret
 *   required     — whether the adapter requires this field to function
 */

const ADAPTER_REGISTRY = {
    paystack: {
        code: 'paystack',
        label: 'Paystack',
        defaultBaseUrl: 'https://api.paystack.co',
        supportedChannels: ['card', 'bank_transfer', 'ussd'],
        credentialFields: [
            {
                key: 'publicKey',
                label: 'Public Key',
                type: 'text',
                sensitive: false,
                required: true,
                placeholder: 'pk_test_...'
            },
            {
                key: 'secretKey',
                label: 'Secret Key',
                type: 'password',
                sensitive: true,
                required: true,
                placeholder: 'sk_test_...'
            },
            {
                key: 'webhookSecret',
                label: 'Webhook Secret',
                type: 'password',
                sensitive: true,
                required: false,
                placeholder: 'Leave blank to use Secret Key as webhook secret'
            }
        ],
        metadataFields: []
    },

    monnify: {
        code: 'monnify',
        label: 'Monnify',
        defaultBaseUrl: 'https://sandbox.monnify.com',
        supportedChannels: ['card', 'bank_transfer', 'virtual_account'],
        credentialFields: [
            {
                key: 'publicKey',
                label: 'API Key',
                type: 'text',
                sensitive: false,
                required: true,
                placeholder: 'MK_...'
            },
            {
                key: 'secretKey',
                label: 'Secret Key',
                type: 'password',
                sensitive: true,
                required: true,
                placeholder: 'Monnify secret key'
            },
            {
                key: 'webhookSecret',
                label: 'Webhook Secret',
                type: 'password',
                sensitive: true,
                required: false,
                placeholder: 'Leave blank to use Secret Key as webhook secret'
            }
        ],
        metadataFields: [
            {
                key: 'contractCode',
                label: 'Contract Code',
                type: 'text',
                sensitive: false,
                required: true,
                placeholder: 'e.g. 1234567890'
            }
        ]
    },

    flutterwave: {
        code: 'flutterwave',
        label: 'Flutterwave',
        defaultBaseUrl: 'https://api.flutterwave.com/v3',
        supportedChannels: ['card', 'bank_transfer', 'ussd'],
        credentialFields: [
            {
                key: 'publicKey',
                label: 'Public Key',
                type: 'text',
                sensitive: false,
                required: false,
                placeholder: 'FLWPUBK_TEST-...'
            },
            {
                key: 'secretKey',
                label: 'Secret Key',
                type: 'password',
                sensitive: true,
                required: true,
                placeholder: 'FLWSECK_TEST-...'
            },
            {
                key: 'webhookSecret',
                label: 'Webhook Hash',
                type: 'password',
                sensitive: true,
                required: false,
                placeholder: 'Webhook verification hash (verif-hash header)'
            }
        ],
        metadataFields: []
    }
};

/** Ordered list of supported adapter codes. */
const SUPPORTED_ADAPTER_CODES = Object.keys(ADAPTER_REGISTRY);

/**
 * Returns the registry entry for a given adapter code, or null if unsupported.
 * @param {string} code
 * @returns {object|null}
 */
function getAdapterSpec(code) {
    return ADAPTER_REGISTRY[code] || null;
}

/**
 * Returns a safe (non-sensitive) representation of the registry for API exposure.
 * Never includes keys, defaults, or sensitive data.
 */
function getPublicCapabilities() {
    return SUPPORTED_ADAPTER_CODES.map(code => {
        const spec = ADAPTER_REGISTRY[code];
        return {
            code: spec.code,
            label: spec.label,
            defaultBaseUrl: spec.defaultBaseUrl,
            supportedChannels: spec.supportedChannels,
            credentialFields: spec.credentialFields.map(f => ({
                key: f.key,
                label: f.label,
                type: f.sensitive ? 'password' : f.type,
                sensitive: f.sensitive,
                required: f.required,
                placeholder: f.placeholder || ''
            })),
            metadataFields: spec.metadataFields.map(f => ({
                key: f.key,
                label: f.label,
                type: f.sensitive ? 'password' : f.type,
                sensitive: f.sensitive,
                required: f.required,
                placeholder: f.placeholder || ''
            }))
        };
    });
}

module.exports = {
    ADAPTER_REGISTRY,
    SUPPORTED_ADAPTER_CODES,
    getAdapterSpec,
    getPublicCapabilities
};
