const Provider = require('../models/Provider');
const Service = require('../models/Service');
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

    /**
     * Synchronizes Cost Prices from a provider to the internal Service registry.
     * @param {string} providerName - Name of the provider (e.g. 'VTPass')
     * @param {string[]} serviceIDs - List of vendor service categories to sync (e.g. ['mtn-data', 'dstv'])
     */
    async syncProviderCosts(providerName, serviceIDs = []) {
        const adapter = await this.getAdapterInstance(providerName);
        if (typeof adapter.fetchVariations !== 'function') {
            return { success: false, message: 'Pricing sync not supported for this provider type' };
        }

        const results = { updated: 0, failed: 0, errors: [] };

        for (const serviceID of serviceIDs) {
            try {
                const res = await adapter.fetchVariations(serviceID);
                if (!res.success) {
                    results.failed++;
                    results.errors.push(`ID ${serviceID}: ${res.message}`);
                    continue;
                }

                // Batch update matching services
                for (const item of res.variations) {
                    const update = await Service.updateOne(
                        { 
                            provider: { $regex: new RegExp(`^${providerName}$`, 'i') }, 
                            providerCode: item.variationCode 
                        },
                        { $set: { costPrice: item.amount } }
                    );
                    if (update.modifiedCount > 0) results.updated++;
                }

            } catch (err) {
                results.failed++;
                results.errors.push(`ID ${serviceID} Exception: ${err.message}`);
            }
        }

        return { success: true, ...results };
    }

    /**
     * Discovers and imports NEW services from a provider catalog.
     * @param {string} providerName 
     * @param {string[]} serviceIDs 
     */
    async importProviderServices(providerName, serviceIDs = []) {
        const adapter = await this.getAdapterInstance(providerName);
        if (typeof adapter.fetchVariations !== 'function') {
            return { success: false, message: 'Auto-import not supported for this provider type' };
        }

        const vtpassRates = providerName.toLowerCase() === 'vtpass' ? require('../utils/vtpass_rates') : null;
        const results = { newlyCreated: 0, skipped: 0, errors: [] };

        for (const serviceID of serviceIDs) {
            try {
                const res = await adapter.fetchVariations(serviceID);
                if (!res.success) {
                    results.errors.push(`ID ${serviceID}: ${res.message}`);
                    continue;
                }

                // Determine category from serviceID
                let category = 'data'; 
                const sId = serviceID.toLowerCase();
                if (sId.includes('airtime')) category = 'airtime';
                else if (['dstv', 'gotv', 'startimes', 'showmax', 'smile-direct'].some(tv => sId.includes(tv))) category = 'tv';
                else if (sId.includes('electric')) category = 'electricity';
                else if (['waec', 'jamb', 'neco', 'nabteb'].some(edu => sId.includes(edu))) category = 'pin';

                for (const item of res.variations) {
                    // Calculate cost based on commission rates if available
                    let costPrice = item.amount;
                    if (vtpassRates) {
                        costPrice = vtpassRates.calculateCost(serviceID, item.amount);
                    }

                    // Try to update existing or create new (Upsert)
                    const updated = await Service.findOneAndUpdate(
                        { 
                            provider: { $regex: new RegExp(`^${providerName}$`, 'i') }, 
                            providerCode: item.variationCode 
                        },
                        { 
                            $set: {
                                name: item.name,
                                category: category, // Force re-categorization if wrong
                                costPrice: costPrice,
                                provider: providerName,
                                // Note: We DON'T overwrite 'price' or 'code' to preserve user custom settings
                            }
                        },
                        { upsert: false } // We'll handle creation separately to generate code
                    );

                    if (updated) {
                        results.skipped++;
                        continue;
                    }

                    // Create a clean internal code if it doesn't exist
                    const cleanCode = `${providerName}_${item.name}`.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_').substring(0, 50);

                    await Service.create({
                        name: item.name,
                        code: cleanCode,
                        category,
                        provider: providerName,
                        providerCode: item.variationCode,
                        costPrice: costPrice,
                        price: item.amount,
                        status: false 
                    });

                    results.newlyCreated++;
                }

            } catch (err) {
                results.errors.push(`ID ${serviceID} Exception: ${err.message}`);
            }
        }

        return { success: true, ...results };
    }

    /**
     * Crawls a full category and imports all variations for all services within it.
     */
    async importByCategory(providerName, categoryIdentifier) {
        console.log(`[IMPORT] Starting category discovery: ${categoryIdentifier} from ${providerName}`);
        const adapter = await this.getAdapterInstance(providerName);
        
        if (typeof adapter.fetchServicesInCategory !== 'function') {
            return { success: false, message: 'Category import not supported for this provider' };
        }

        try {
            const res = await adapter.fetchServicesInCategory(categoryIdentifier);
            
            // Extract IDs from vendor response
            const discoveredIDs = (res.content || [])
                .map(s => s.serviceID || s.identifier)
                .filter(id => id);

            // MASTER FALLBACK LIST (Ensures Sandbox doesn't hide production services)
            const MASTER_LIST = {
                'electricity-bill': [
                    'ikeja-electric', 'eko-electric', 'abuja-electric', 'kano-electric',
                    'portharcourt-electric', 'jos-electric', 'kaduna-electric', 'enugu-electric',
                    'benin-electric', 'aba-electric', 'yola-electric', 'ibadan-electric'
                ],
                'education': [
                    'waec', 'waec-registration', 'waec-registration-pin', 'jamb', 'jamb-pin'
                ],
                'tv-subscription': ['dstv', 'gotv', 'startimes', 'showmax', 'smile-direct'],
                'data': ['mtn-data', 'airtel-data', 'glo-data', 'glo-sme-data', 'etisalat-data']
            };

            // Merge discovered IDs with our master list for that category
            const fallbackIDs = MASTER_LIST[categoryIdentifier] || [];
            const finalIDs = [...new Set([...discoveredIDs, ...fallbackIDs])];

            console.log(`[IMPORT] Category ${categoryIdentifier}: Found ${discoveredIDs.length} via API, merged to ${finalIDs.length} total IDs`);

            // Re-use the existing bulk import logic
            return await this.importProviderServices(providerName, finalIDs);

        } catch (err) {
            console.error(`[IMPORT] Category Import Exception:`, err);
            return { success: false, message: err.message };
        }
    }
}

module.exports = new ProviderService();
