const Provider = require('../models/Provider');
const VTPassAdapter = require('../adapters/vtpass.adapter');
const Vas2NetsAdapter = require('../adapters/vas2nets.adapter');
const UniversalAdapter = require('../adapters/universal.adapter');

class ProviderService {
    constructor() {
        this.adapterClasses = {
            'vtpass': VTPassAdapter,
            'vas2nets': Vas2NetsAdapter,
            'universal': UniversalAdapter
        };
    }

    /**
     * Resolves and instantiates an adapter from the database configuration.
     * This ensures that API keys updated in the Admin UI are picked up immediately.
     * @param {string} providerName 
     */
    async getAdapterInstance(providerName) {
        const name = (providerName || 'vtpass').toLowerCase();
        
        // 1. Fetch config from Database
        const providerConfig = await Provider.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } });
        
        if (!providerConfig) {
            console.error(`Provider config not found for: ${name}. Falling back to VTPass class with process.env.`);
            // Fallback for safety (though deprecated)
            return new VTPassAdapter({ baseUrl: process.env.VTU_API_URI, apiKey: process.env.VTPASS_API_KEY });
        }

        // 2. Resolve Class
        const AdapterClass = this.adapterClasses[providerConfig.adapterType] || VTPassAdapter;
        
        // 3. Instantiate with DB data
        return new AdapterClass({
            baseUrl: providerConfig.baseUrl,
            apiKey: providerConfig.apiKey,
            secretKey: providerConfig.secretKey,
            publicKey: providerConfig.publicKey,
            metadata: providerConfig.metadata
        });
    }

    async purchaseAirtime(data, providerName) {
        const adapter = await this.getAdapterInstance(providerName);
        return adapter.purchaseAirtime(data);
    }

    async purchaseData(data, providerName) {
        const adapter = await this.getAdapterInstance(providerName);
        return adapter.purchaseData(data);
    }

    async purchaseElectricity(data, providerName) {
        const adapter = await this.getAdapterInstance(providerName);
        return adapter.purchaseElectricity(data);
    }

    async purchaseCable(data, providerName) {
        const adapter = await this.getAdapterInstance(providerName);
        return adapter.purchaseCable(data);
    }

    async purchaseExamPin(data, providerName) {
        const adapter = await this.getAdapterInstance(providerName);
        return adapter.purchaseExamPin(data);
    }

    async queryTransaction(refId, providerName) {
        const adapter = await this.getAdapterInstance(providerName);
        return adapter.queryTransaction(refId);
    }

    async fetchVariations(serviceID, providerName) {
        const adapter = await this.getAdapterInstance(providerName);
        if (typeof adapter.fetchVariations === 'function') {
            return adapter.fetchVariations(serviceID);
        }
        return { success: false, message: 'Source variation fetching not supported for this adapter type' };
    }

    async verifyMerchant(data, providerName) {
        const adapter = await this.getAdapterInstance(providerName);
        if (typeof adapter.verifyMerchant === 'function') {
            return adapter.verifyMerchant(data);
        }
        return { success: false, message: 'Merchant verification not supported for this adapter type' };
    }
}

module.exports = new ProviderService();
