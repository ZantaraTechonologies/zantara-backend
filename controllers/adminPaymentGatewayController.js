'use strict';

const PaymentGateway = require('../models/PaymentGateway');
const TransactionStatus = require('../models/TransactionStatus');
const WebhookEvent = require('../models/WebhookEvent');
const paymentGatewayService = require('../services/paymentGateway.service');
const { sanitizePaymentGateway, sanitizePaymentGatewayForClient } = require('../utils/paymentGatewaySerializer');
const { encryptSecret, isEncrypted } = require('../utils/crypto');
const { logAction } = require('./auditController');
const {
    SUPPORTED_ADAPTER_CODES,
    getAdapterSpec,
    getPublicCapabilities
} = require('../adapters/payment/paymentAdapterRegistry');

/**
 * Ensures initial default payment gateways exist if the collection is empty.
 * Migrates env credentials for Paystack, Monnify, Flutterwave safely.
 */
async function ensureDefaultGateways() {
    const count = await PaymentGateway.countDocuments();
    if (count > 0) return;

    console.log('[PaymentGateway] Initializing default gateways in database...');

    const paystackSecret = process.env.PAYSTACK_SECRET_KEY || '';
    const paystackPublic = process.env.PAYSTACK_PUBLIC_KEY || '';
    const paystackBaseUrl = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';

    const monnifyApiKey = process.env.MONNIFY_API_KEY || '';
    const monnifySecretKey = process.env.MONNIFY_SECRET_KEY || '';
    const monnifyContractCode = process.env.MONNIFY_CONTRACT_CODE || '';
    const monnifyBaseUrl = process.env.MONNIFY_BASE_URL || 'https://sandbox.monnify.com';

    const flwSecret = process.env.FLUTTERWAVE_SECRET_KEY || '';
    const flwPublic = process.env.FLUTTERWAVE_PUBLIC_KEY || '';
    const flwHash = process.env.FLUTTERWAVE_HASH || '';
    const flwBaseUrl = process.env.FLUTTERWAVE_BASE_URL || 'https://api.flutterwave.com/v3';

    try {
        // 1. Paystack (Default Active Gateway)
        const paystack = new PaymentGateway({
            name: 'Paystack',
            code: 'paystack',
            adapterType: 'paystack',
            status: paystackSecret ? 'active' : 'inactive',
            environment: paystackSecret && paystackSecret.startsWith('sk_live_') ? 'live' : 'test',
            isDefault: true,
            priority: 1,
            publicKey: paystackPublic,
            secretKey: paystackSecret ? (isEncrypted(paystackSecret) ? paystackSecret : encryptSecret(paystackSecret)) : '',
            webhookSecret: paystackSecret ? (isEncrypted(paystackSecret) ? paystackSecret : encryptSecret(paystackSecret)) : '',
            baseUrl: paystackBaseUrl,
            supportedChannels: ['card', 'bank_transfer', 'ussd'],
            metadata: {}
        });
        await paystack.save();

        // 2. Monnify (Secondary Gateway - Inactive by default until configured)
        const monnify = new PaymentGateway({
            name: 'Monnify',
            code: 'monnify',
            adapterType: 'monnify',
            status: (monnifyApiKey && monnifySecretKey) ? 'active' : 'inactive',
            environment: monnifyBaseUrl.includes('sandbox') ? 'test' : 'live',
            isDefault: false,
            priority: 2,
            publicKey: monnifyApiKey,
            secretKey: monnifySecretKey ? (isEncrypted(monnifySecretKey) ? monnifySecretKey : encryptSecret(monnifySecretKey)) : '',
            webhookSecret: monnifySecretKey ? (isEncrypted(monnifySecretKey) ? monnifySecretKey : encryptSecret(monnifySecretKey)) : '',
            baseUrl: monnifyBaseUrl,
            supportedChannels: ['card', 'bank_transfer', 'virtual_account'],
            metadata: {
                contractCode: monnifyContractCode
            }
        });
        await monnify.save();

        // 3. Flutterwave (Tertiary Gateway - Inactive by default)
        const flutterwave = new PaymentGateway({
            name: 'Flutterwave',
            code: 'flutterwave',
            adapterType: 'flutterwave',
            status: flwSecret ? 'active' : 'inactive',
            environment: flwSecret.startsWith('FLWSECK_TEST') ? 'test' : 'live',
            isDefault: false,
            priority: 3,
            publicKey: flwPublic,
            secretKey: flwSecret ? (isEncrypted(flwSecret) ? flwSecret : encryptSecret(flwSecret)) : '',
            webhookSecret: flwHash ? (isEncrypted(flwHash) ? flwHash : encryptSecret(flwHash)) : '',
            baseUrl: flwBaseUrl,
            supportedChannels: ['card', 'bank_transfer', 'ussd'],
            metadata: {}
        });
        await flutterwave.save();

        console.log('[PaymentGateway] Default gateways seeded successfully.');
    } catch (err) {
        console.error('[PaymentGateway] Seeding error:', err.message);
    }
}

/**
 * GET /api/admin/payment-gateways
 * Returns all configured payment gateways with safe boolean credential indicators.
 */
const getAllGateways = async (req, res) => {
    try {
        await ensureDefaultGateways();
        const gateways = await PaymentGateway.find().sort({ priority: 1, createdAt: 1 });
        const sanitized = gateways.map(g => sanitizePaymentGateway(g));

        const activeCount = sanitized.filter(g => g.status === 'active').length;
        const defaultGateway = sanitized.find(g => g.isDefault)?.code || null;

        res.json({
            success: true,
            data: sanitized,
            summary: {
                total: sanitized.length,
                activeCount,
                defaultGateway
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/admin/payment-gateways/:id
 * Returns a single gateway by ID.
 */
const getGatewayById = async (req, res) => {
    try {
        const { id } = req.params;
        const gateway = await PaymentGateway.findById(id);
        if (!gateway) {
            return res.status(404).json({ success: false, message: 'Payment gateway not found' });
        }
        res.json({ success: true, data: sanitizePaymentGateway(gateway) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * POST /api/admin/payment-gateways
 * SuperAdmin-only endpoint to register a new payment gateway.
 */
const createGateway = async (req, res) => {
    try {
        const {
            name,
            code,
            adapterType,
            status = 'inactive',
            environment = 'test',
            isDefault = false,
            priority = 1,
            publicKey = '',
            secretKey = '',
            webhookSecret = '',
            baseUrl = '',
            supportedChannels = [],
            metadata = {}
        } = req.body;

        if (!name || !code || !adapterType) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: name, code, adapterType'
            });
        }

        if (!SUPPORTED_ADAPTER_CODES.includes(adapterType.toLowerCase())) {
            return res.status(400).json({
                success: false,
                message: `Invalid adapterType '${adapterType}'. Must be one of: ${SUPPORTED_ADAPTER_CODES.join(', ')}`
            });
        }

        const normalizedCode = code.toLowerCase().trim();
        const existing = await PaymentGateway.findOne({
            $or: [{ code: normalizedCode }, { name: name.trim() }]
        });
        if (existing) {
            return res.status(400).json({
                success: false,
                message: `A payment gateway with code '${normalizedCode}' or name '${name.trim()}' already exists`
            });
        }

        // Validate channels against adapter's declared supported channels
        const adapterSpec = getAdapterSpec(adapterType.toLowerCase());
        const adapterChannels = adapterSpec ? adapterSpec.supportedChannels : [];
        if (supportedChannels.length > 0) {
            const invalidChannels = supportedChannels.filter(c => !adapterChannels.includes(c));
            if (invalidChannels.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: `Channels [${invalidChannels.join(', ')}] are not supported by the '${adapterType}' adapter. Allowed: ${adapterChannels.join(', ')}`
                });
            }
        }

        if (isDefault && status !== 'active') {
            return res.status(400).json({
                success: false,
                message: 'Default gateway must be active. Cannot make an inactive or maintenance gateway default.'
            });
        }

        const encryptedSecretKey = secretKey && secretKey.trim() !== ''
            ? (isEncrypted(secretKey.trim()) ? secretKey.trim() : encryptSecret(secretKey.trim()))
            : '';

        const encryptedWebhookSecret = webhookSecret && webhookSecret.trim() !== ''
            ? (isEncrypted(webhookSecret.trim()) ? webhookSecret.trim() : encryptSecret(webhookSecret.trim()))
            : '';

        const gateway = await PaymentGateway.create({
            name: name.trim(),
            code: normalizedCode,
            adapterType: adapterType.toLowerCase(),
            status,
            environment: environment === 'live' ? 'live' : 'test',
            isDefault: false, // will assign via setDefault if requested
            priority: Number(priority) || 1,
            publicKey: publicKey.trim(),
            secretKey: encryptedSecretKey,
            webhookSecret: encryptedWebhookSecret,
            baseUrl: baseUrl.trim(),
            supportedChannels,
            metadata: metadata || {}
        });

        if (isDefault && status === 'active') {
            await PaymentGateway.setDefault(gateway._id);
            gateway.isDefault = true;
        }

        // Audit Logging (NEVER logging credentials)
        const adminId = req.user?._id || req.user?.id;
        const operatorName = req.user?.name || req.user?.email || 'SuperAdmin';
        await logAction(adminId, operatorName, 'PAYMENT_GATEWAY_CREATED', `Gateway: ${gateway.name}`, {
            gatewayId: gateway._id,
            name: gateway.name,
            code: gateway.code,
            adapterType: gateway.adapterType,
            status: gateway.status,
            environment: gateway.environment,
            isDefault: gateway.isDefault,
            secretKeyConfigured: !!(secretKey && secretKey.trim() !== ''),
            webhookSecretConfigured: !!(webhookSecret && webhookSecret.trim() !== '')
        }, 'success', req);

        res.status(201).json({ success: true, data: sanitizePaymentGateway(gateway) });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

/**
 * PUT /api/admin/payment-gateways/:id
 * SuperAdmin-only endpoint to update gateway settings.
 * RULE: Blank secretKey / webhookSecret retains existing encrypted values.
 */
const updateGateway = async (req, res) => {
    try {
        const { id } = req.params;
        const gateway = await PaymentGateway.findById(id);
        if (!gateway) {
            return res.status(404).json({ success: false, message: 'Payment gateway not found' });
        }

        const {
            name,
            adapterType,
            status,
            environment,
            isDefault,
            priority,
            publicKey,
            secretKey,
            webhookSecret,
            baseUrl,
            supportedChannels,
            metadata
        } = req.body;

        let isSecretRotated = false;
        let isWebhookRotated = false;
        let isEnvChanged = false;
        let isStatusChanged = false;
        const previousEnv = gateway.environment;
        const previousStatus = gateway.status;

        if (name && name.trim() !== '') gateway.name = name.trim();
        if (adapterType) {
            if (!SUPPORTED_ADAPTER_CODES.includes(adapterType.toLowerCase())) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid adapterType. Must be one of: ${SUPPORTED_ADAPTER_CODES.join(', ')}`
                });
            }
            gateway.adapterType = adapterType.toLowerCase();
        }

        if (baseUrl !== undefined) gateway.baseUrl = baseUrl.trim();
        if (publicKey !== undefined) gateway.publicKey = publicKey.trim();
        if (priority !== undefined) gateway.priority = Number(priority) || 1;

        if (supportedChannels !== undefined && Array.isArray(supportedChannels)) {
            // Validate channels against adapter's declared supported channels
            const effectiveAdapter = (adapterType || gateway.adapterType || '').toLowerCase();
            const adapterSpec = getAdapterSpec(effectiveAdapter);
            const adapterChannels = adapterSpec ? adapterSpec.supportedChannels : [];
            if (supportedChannels.length > 0 && adapterChannels.length > 0) {
                const invalidChannels = supportedChannels.filter(c => !adapterChannels.includes(c));
                if (invalidChannels.length > 0) {
                    return res.status(400).json({
                        success: false,
                        message: `Channels [${invalidChannels.join(', ')}] are not supported by the '${effectiveAdapter}' adapter. Allowed: ${adapterChannels.join(', ')}`
                    });
                }
            }
            gateway.supportedChannels = supportedChannels;
        }

        if (metadata && typeof metadata === 'object') {
            gateway.metadata = { ...(gateway.metadata || {}), ...metadata };
            gateway.markModified('metadata');
        }

        // Credentials Rotation: Update ONLY if non-empty string provided.
        // Blank string or undefined means "retain current configured secret".
        if (secretKey && typeof secretKey === 'string' && secretKey.trim() !== '') {
            gateway.secretKey = isEncrypted(secretKey.trim()) ? secretKey.trim() : encryptSecret(secretKey.trim());
            isSecretRotated = true;
        }

        if (webhookSecret && typeof webhookSecret === 'string' && webhookSecret.trim() !== '') {
            gateway.webhookSecret = isEncrypted(webhookSecret.trim()) ? webhookSecret.trim() : encryptSecret(webhookSecret.trim());
            isWebhookRotated = true;
        }

        // Environment Switch Tracking
        if (environment && environment !== gateway.environment) {
            if (!['test', 'live'].includes(environment)) {
                return res.status(400).json({ success: false, message: "Environment must be 'test' or 'live'" });
            }
            gateway.environment = environment;
            isEnvChanged = true;
        }

        // Status Management
        if (status && status !== gateway.status) {
            if (!['active', 'inactive', 'maintenance'].includes(status)) {
                return res.status(400).json({ success: false, message: "Status must be 'active', 'inactive', or 'maintenance'" });
            }
            gateway.status = status;
            isStatusChanged = true;

            // Inactive or maintenance gateway CANNOT be default
            if (status !== 'active' && gateway.isDefault) {
                gateway.isDefault = false;
            }
        }

        await gateway.save();

        // Default Gateway Handling
        if (isDefault === true && !gateway.isDefault) {
            if (gateway.status !== 'active') {
                return res.status(400).json({
                    success: false,
                    message: `Cannot set gateway '${gateway.name}' as default because it is not active. Please activate it first.`
                });
            }
            await PaymentGateway.setDefault(gateway._id);
            gateway.isDefault = true;
        } else if (isDefault === false && gateway.isDefault) {
            gateway.isDefault = false;
            await gateway.save();
        }

        // Audit Logging
        const adminId = req.user?._id || req.user?.id;
        const operatorName = req.user?.name || req.user?.email || 'SuperAdmin';

        if (isSecretRotated || isWebhookRotated) {
            await logAction(adminId, operatorName, 'PAYMENT_GATEWAY_CREDENTIALS_ROTATED', `Gateway: ${gateway.name}`, {
                gatewayId: gateway._id,
                name: gateway.name,
                secretKeyUpdated: isSecretRotated,
                webhookSecretUpdated: isWebhookRotated
            }, 'success', req);
        }

        if (isEnvChanged) {
            await logAction(adminId, operatorName, 'PAYMENT_GATEWAY_ENVIRONMENT_CHANGED', `Gateway: ${gateway.name}`, {
                gatewayId: gateway._id,
                name: gateway.name,
                previousEnv,
                newEnv: gateway.environment
            }, 'success', req);
        }

        if (isStatusChanged) {
            await logAction(adminId, operatorName, 'PAYMENT_GATEWAY_STATUS_CHANGED', `Gateway: ${gateway.name}`, {
                gatewayId: gateway._id,
                name: gateway.name,
                previousStatus,
                newStatus: gateway.status
            }, 'success', req);
        }

        await logAction(adminId, operatorName, 'PAYMENT_GATEWAY_UPDATED', `Gateway: ${gateway.name}`, {
            gatewayId: gateway._id,
            name: gateway.name,
            status: gateway.status,
            environment: gateway.environment,
            isDefault: gateway.isDefault
        }, 'success', req);

        res.json({ success: true, data: sanitizePaymentGateway(gateway) });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

/**
 * PATCH /api/admin/payment-gateways/:id/status
 * SuperAdmin-only endpoint to update gateway status.
 */
const updateGatewayStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!status || !['active', 'inactive', 'maintenance'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Valid status ('active', 'inactive', 'maintenance') is required"
            });
        }

        const gateway = await PaymentGateway.findById(id);
        if (!gateway) {
            return res.status(404).json({ success: false, message: 'Payment gateway not found' });
        }

        const oldStatus = gateway.status;
        gateway.status = status;

        if (status !== 'active' && gateway.isDefault) {
            gateway.isDefault = false;
        }

        await gateway.save();

        const adminId = req.user?._id || req.user?.id;
        const operatorName = req.user?.name || req.user?.email || 'SuperAdmin';
        await logAction(adminId, operatorName, 'PAYMENT_GATEWAY_STATUS_CHANGED', `Gateway: ${gateway.name}`, {
            gatewayId: gateway._id,
            name: gateway.name,
            oldStatus,
            newStatus: status,
            isDefault: gateway.isDefault
        }, 'success', req);

        res.json({ success: true, data: sanitizePaymentGateway(gateway) });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

/**
 * POST /api/admin/payment-gateways/:id/set-default
 * SuperAdmin-only endpoint to designate a gateway as the platform default.
 * Enforces: Gateway must be active. Uses concurrency-safe PaymentGateway.setDefault().
 */
const setDefaultGateway = async (req, res) => {
    try {
        const { id } = req.params;
        const gateway = await PaymentGateway.findById(id);
        if (!gateway) {
            return res.status(404).json({ success: false, message: 'Payment gateway not found' });
        }

        if (gateway.status !== 'active') {
            return res.status(400).json({
                success: false,
                message: `Cannot set gateway '${gateway.name}' as default because it is '${gateway.status}'. Only active gateways can be default.`
            });
        }

        await PaymentGateway.setDefault(gateway._id);
        const updated = await PaymentGateway.findById(id);

        const adminId = req.user?._id || req.user?.id;
        const operatorName = req.user?.name || req.user?.email || 'SuperAdmin';
        await logAction(adminId, operatorName, 'PAYMENT_GATEWAY_DEFAULT_CHANGED', `Gateway: ${gateway.name}`, {
            gatewayId: gateway._id,
            name: gateway.name
        }, 'success', req);

        res.json({ success: true, data: sanitizePaymentGateway(updated) });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

/**
 * POST /api/admin/payment-gateways/:id/test-connection
 * SuperAdmin-only endpoint to test gateway connectivity server-side.
 * Returns only safe success/error messages; never returns keys, secrets, or auth headers.
 */
const testGatewayConnection = async (req, res) => {
    try {
        const { id } = req.params;
        const gateway = await PaymentGateway.findById(id);
        if (!gateway) {
            return res.status(404).json({ success: false, message: 'Payment gateway not found' });
        }

        const hydrated = paymentGatewayService._hydrateGatewayCredentials(gateway);
        const adapter = paymentGatewayService.getAdapterInstance(hydrated);

        let result = null;
        try {
            result = await adapter.testConnection();
        } catch (adapterErr) {
            result = {
                success: false,
                message: adapterErr.message || 'Connection test threw an unhandled error'
            };
        }

        gateway.lastHealthCheck = {
            status: result.success ? 'online' : 'offline',
            checkedAt: new Date(),
            message: result.message || (result.success ? 'Connection successful' : 'Connection failed')
        };
        await gateway.save();

        const adminId = req.user?._id || req.user?.id;
        const operatorName = req.user?.name || req.user?.email || 'SuperAdmin';
        await logAction(adminId, operatorName, 'PAYMENT_GATEWAY_TEST_CONNECTION', `Gateway: ${gateway.name}`, {
            gatewayId: gateway._id,
            name: gateway.name,
            healthStatus: gateway.lastHealthCheck.status
        }, result.success ? 'success' : 'failure', req);

        res.json({
            success: result.success,
            message: result.message,
            lastHealthCheck: gateway.lastHealthCheck
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * DELETE /api/admin/payment-gateways/:id
 * SuperAdmin-only endpoint to remove a gateway.
 * SAFETY RULE: Prevents deletion if any historical transactions or webhooks reference this gateway code.
 */
const deleteGateway = async (req, res) => {
    try {
        const { id } = req.params;
        const gateway = await PaymentGateway.findById(id);
        if (!gateway) {
            return res.status(404).json({ success: false, message: 'Payment gateway not found' });
        }

        const [txCount, whCount] = await Promise.all([
            TransactionStatus.countDocuments({ gateway: gateway.code }),
            WebhookEvent.countDocuments({ gatewayCode: gateway.code })
        ]);

        if (txCount > 0 || whCount > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete gateway '${gateway.name}' because it is bound to historical financial records (${txCount} transactions, ${whCount} webhooks). Deactivate the gateway instead.`
            });
        }

        await PaymentGateway.findByIdAndDelete(id);

        const adminId = req.user?._id || req.user?.id;
        const operatorName = req.user?.name || req.user?.email || 'SuperAdmin';
        await logAction(adminId, operatorName, 'PAYMENT_GATEWAY_DELETED', `Gateway: ${gateway.name}`, {
            gatewayId: gateway._id,
            name: gateway.name,
            code: gateway.code
        }, 'success', req);

        res.json({
            success: true,
            message: `Gateway '${gateway.name}' deleted successfully.`
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/admin/payment-gateways/reconciliation
 * Returns funding transactions in 'processing' or 'reconciliation_required' states.
 * Read-only visibility for operational audits.
 */
const getReconciliationTransactions = async (req, res) => {
    try {
        const issues = await TransactionStatus.find({
            status: { $in: ['processing', 'reconciliation_required'] }
        })
            .sort({ updatedAt: -1 })
            .limit(100)
            .populate('userId', 'name email phone')
            .lean();

        const formatted = issues.map(tx => {
            const lastUpdated = tx.updatedAt || tx.createdAt || new Date();
            const elapsedMs = Date.now() - new Date(lastUpdated).getTime();
            const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / (1000 * 60)));

            return {
                _id: tx._id,
                reference: tx.reference,
                gateway: tx.gateway || 'unknown',
                status: tx.status,
                user: tx.userId ? {
                    _id: tx.userId._id,
                    name: tx.userId.name || 'User',
                    email: tx.userId.email || '',
                    phone: tx.userId.phone || ''
                } : null,
                expectedAmount: tx.amount,
                confirmedAmount: tx.confirmedAmountKobo ? tx.confirmedAmountKobo / 100 : null,
                expectedCurrency: tx.currency || 'NGN',
                confirmedCurrency: tx.confirmedCurrency || null,
                confirmedProviderRef: tx.confirmedProviderRef || null,
                reconciliationReason: tx.reconciliationReason || null,
                elapsedMinutes,
                createdAt: tx.createdAt,
                updatedAt: tx.updatedAt
            };
        });

        res.json({
            success: true,
            data: formatted,
            count: formatted.length
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/admin/payment-gateways/capabilities
 * Returns the safe adapter capability registry — adapter codes, labels, supported channels,
 * credential field descriptors, and metadata field descriptors.
 * Does NOT expose any credentials, secrets, or configured values.
 * Accessible to admin and superAdmin.
 */
const getAdapterCapabilities = async (req, res) => {
    try {
        res.json({
            success: true,
            data: getPublicCapabilities()
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/wallet/funding-methods
 * Client-facing endpoint returning all active payment gateways and enabled channels.
 */
const getFundingMethods = async (req, res) => {
    try {
        const activeGateways = await paymentGatewayService.getActiveGateways();
        const sanitized = activeGateways.map(g => sanitizePaymentGatewayForClient(g));
        res.json({ success: true, data: sanitized });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    ensureDefaultGateways,
    getAllGateways,
    getGatewayById,
    getAdapterCapabilities,
    createGateway,
    updateGateway,
    updateGatewayStatus,
    setDefaultGateway,
    testGatewayConnection,
    deleteGateway,
    getReconciliationTransactions,
    getFundingMethods
};
