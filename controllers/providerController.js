const Provider = require('../models/Provider');
const ProviderOffer = require('../models/ProviderOffer');
const providerService = require('../services/provider.service');
const { encryptSecret } = require('../utils/crypto');
const { serializeProvider, sanitizeMetadata, validateMetadata } = require('../utils/providerSerializer');
const { logAction } = require('./auditController');

function validateBaseUrl(url) {
    if (!url || typeof url !== 'string') throw new Error('Base URL is required');
    const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
    if (process.env.NODE_ENV === 'production' && !isLocal && !url.startsWith('https://')) {
        throw new Error('Base URL must use HTTPS in production environments');
    }
}

const getAllProviders = async (req, res) => {
    try {
        const providers = await Provider.find().sort({ name: 1 });
        const sanitized = providers.map(p => serializeProvider(p));
        res.json({ success: true, data: sanitized });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const createProvider = async (req, res) => {
    try {
        const { name, adapterType, baseUrl, apiKey, secretKey, publicKey, status, metadata } = req.body;
        
        if (!name || !baseUrl || !apiKey) {
            return res.status(400).json({ success: false, message: 'Missing required fields: name, baseUrl, apiKey' });
        }

        validateBaseUrl(baseUrl);

        if (metadata) {
            validateMetadata(metadata);
        }
        const cleanMetadata = sanitizeMetadata(metadata);

        // Encrypt sensitive credential fields before database persistence
        const encryptedApiKey = encryptSecret(apiKey.trim());
        const encryptedSecretKey = secretKey && secretKey.trim() !== '' ? encryptSecret(secretKey.trim()) : undefined;

        const provider = await Provider.create({
            name: name.trim(),
            adapterType: adapterType || 'vtpass',
            baseUrl: baseUrl.trim(),
            apiKey: encryptedApiKey,
            secretKey: encryptedSecretKey,
            publicKey: publicKey ? publicKey.trim() : undefined,
            status: status || 'active',
            metadata: cleanMetadata
        });

        // Audit Logging
        const adminId = req.user?._id || req.user?.id;
        const operatorName = req.user?.name || req.user?.email || 'Admin';
        await logAction(adminId, operatorName, 'PROVIDER_CREATED', `Provider: ${provider.name}`, {
            providerId: provider._id,
            name: provider.name,
            adapterType: provider.adapterType,
            status: provider.status
        }, 'success', req);

        res.status(201).json({ success: true, data: serializeProvider(provider) });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const updateProvider = async (req, res) => {
    try {
        const { id } = req.params;
        const provider = await Provider.findById(id);
        if (!provider) return res.status(404).json({ success: false, message: 'Provider not found' });

        const { name, adapterType, baseUrl, apiKey, secretKey, publicKey, status, metadata } = req.body;

        let isCredentialRotated = false;
        let isStatusChanged = false;

        if (baseUrl) {
            validateBaseUrl(baseUrl);
            provider.baseUrl = baseUrl.trim();
        }

        if (name) provider.name = name.trim();
        if (adapterType) provider.adapterType = adapterType;
        if (publicKey !== undefined) provider.publicKey = publicKey.trim();
        
        if (status && status !== provider.status) {
            provider.status = status;
            isStatusChanged = true;
        }

        if (metadata) {
            validateMetadata(metadata);
            // Merge with existing metadata to ensure editing one field does not delete unrelated metadata configuration
            const currentMeta = provider.metadata instanceof Map ? Object.fromEntries(provider.metadata) : (provider.metadata || {});
            const merged = { ...currentMeta, ...metadata };
            provider.metadata = sanitizeMetadata(merged);
            provider.markModified('metadata');
        }

        // Encrypt and replace credentials ONLY if new non-empty values are supplied
        if (apiKey && typeof apiKey === 'string' && apiKey.trim() !== '') {
            provider.apiKey = encryptSecret(apiKey.trim());
            isCredentialRotated = true;
        }

        if (secretKey && typeof secretKey === 'string' && secretKey.trim() !== '') {
            provider.secretKey = encryptSecret(secretKey.trim());
            isCredentialRotated = true;
        }

        await provider.save();

        // Audit Logging
        const adminId = req.user?._id || req.user?.id;
        const operatorName = req.user?.name || req.user?.email || 'Admin';

        if (isCredentialRotated) {
            await logAction(adminId, operatorName, 'PROVIDER_CREDENTIAL_ROTATED', `Provider: ${provider.name}`, {
                providerId: provider._id,
                name: provider.name
            }, 'success', req);
        }

        if (isStatusChanged) {
            await logAction(adminId, operatorName, 'PROVIDER_STATUS_CHANGED', `Provider: ${provider.name}`, {
                providerId: provider._id,
                newStatus: provider.status
            }, 'success', req);
        }

        await logAction(adminId, operatorName, 'PROVIDER_UPDATED', `Provider: ${provider.name}`, {
            providerId: provider._id,
            name: provider.name,
            status: provider.status
        }, 'success', req);

        res.json({ success: true, data: serializeProvider(provider) });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const deleteProvider = async (req, res) => {
    try {
        const { id } = req.params;
        const provider = await Provider.findById(id);
        if (!provider) return res.status(404).json({ success: false, message: 'Provider not found' });

        // Check for existing ProviderOffer mappings to preserve referential integrity
        const activeOffersCount = await ProviderOffer.countDocuments({ providerId: id });
        if (activeOffersCount > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete provider '${provider.name}' because it has ${activeOffersCount} service offer mapping(s). Please remove or reassign those offers first.`
            });
        }

        await Provider.findByIdAndDelete(id);

        const adminId = req.user?._id || req.user?.id;
        const operatorName = req.user?.name || req.user?.email || 'Admin';
        await logAction(adminId, operatorName, 'PROVIDER_DELETED', `Provider: ${provider.name}`, {
            providerId: id,
            name: provider.name
        }, 'success', req);

        res.json({ success: true, message: 'Provider deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const getProviderBalance = async (req, res) => {
    try {
        const { id } = req.params;
        const provider = await Provider.findById(id);
        if (!provider) return res.status(404).json({ success: false, message: 'Provider not found' });

        const adapter = await providerService.getAdapterInstance(provider.name);
        const result = await adapter.checkBalance();
        
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.message || 'Balance check failed' });
        }

        provider.balance = result.balance;
        provider.lastBalanceCheck = new Date();
        await provider.save();

        res.json({ success: true, balance: result.balance, data: serializeProvider(provider) });
    } catch (error) {
        console.error('Balance check error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * SuperAdmin-only connection test.
 * Safely tests provider connectivity without executing purchases or exposing credentials.
 */
const testProviderConnection = async (req, res) => {
    try {
        const { id } = req.params;
        const provider = await Provider.findById(id);
        if (!provider) return res.status(404).json({ success: false, message: 'Provider not found' });

        const adapter = await providerService.getAdapterInstance(provider.name);

        const rawMeta = provider.metadata instanceof Map ? Object.fromEntries(provider.metadata) : (provider.metadata || {});
        const hasBalanceConfigured = provider.adapterType === 'vtpass' || provider.adapterType === 'vas2nets' || Boolean(rawMeta.balanceUrl);

        let testResult = null;

        if (hasBalanceConfigured) {
            try {
                const balRes = await adapter.checkBalance();
                testResult = {
                    success: balRes.success,
                    mode: 'balance',
                    message: balRes.success 
                        ? `Connection successful (Vendor balance responded: ₦${Number(balRes.balance || 0).toLocaleString()})`
                        : (balRes.message || 'Balance endpoint responded with failure')
                };
            } catch (err) {
                testResult = {
                    success: false,
                    mode: 'balance',
                    message: err.response?.data?.message || err.message || 'Balance request failed'
                };
            }
        } else if (rawMeta.variationsUrl) {
            try {
                const varRes = await adapter.fetchVariations('test-ping');
                testResult = {
                    success: varRes.success,
                    mode: 'variations',
                    message: varRes.success 
                        ? 'Connection successful (Service variations endpoint responded)'
                        : (varRes.message || 'Variations endpoint returned non-success')
                };
            } catch (err) {
                testResult = {
                    success: false,
                    mode: 'variations',
                    message: err.response?.data?.message || err.message || 'Variations probe failed'
                };
            }
        } else {
            // Harmless reachability check on Base URL
            try {
                const axios = require('axios');
                const pingRes = await axios.get(provider.baseUrl, { timeout: 5000, validateStatus: () => true });
                testResult = {
                    success: pingRes.status < 500,
                    mode: 'ping',
                    message: `Connection reachable (Base URL returned HTTP ${pingRes.status})`
                };
            } catch (err) {
                testResult = {
                    success: false,
                    mode: 'ping',
                    message: `Could not reach Base URL: ${err.message}`
                };
            }
        }

        // Return strictly sanitized message without exposing credentials, tokens, or headers
        res.json({
            success: testResult.success,
            mode: testResult.mode,
            message: testResult.message
        });
    } catch (error) {
        res.status(500).json({ success: false, message: `Connection test error: ${error.message}` });
    }
};

module.exports = {
    getAllProviders,
    createProvider,
    updateProvider,
    deleteProvider,
    getProviderBalance,
    testProviderConnection
};
