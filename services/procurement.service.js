const Service = require('../models/Service');
const ProviderOffer = require('../models/ProviderOffer');

/**
 * Service responsible for selecting the best provider for a given service.
 * In Batch 2, this implements the 'manual_priority' strategy.
 */
class ProcurementService {
    resolveProviderServiceCode(service, offer) {
        const configuredCode = String(offer?.providerServiceCode || '').trim();
        if (configuredCode) return configuredCode;

        const category = String(service?.category || '').toLowerCase();
        if (category === 'airtime' || category === 'electricity') {
            const offerCode = String(offer?.providerCode || '').trim();
            if (offerCode) return offerCode;
        }

        const selectedProvider = String(offer?.providerId?.name || '').trim().toLowerCase();
        const legacyProvider = String(service?.provider || '').trim().toLowerCase();
        const legacyIdentityCode = String(service?.identityId?.providerCode || '').trim();
        if (selectedProvider && selectedProvider === legacyProvider && legacyIdentityCode) {
            return legacyIdentityCode;
        }

        throw new Error('Selected provider offer has no provider service code for this service');
    }

    /**
     * Selects the highest priority active ProviderOffer for a given Service.
     * @param {string|ObjectId} serviceId - The ID of the normalized service.
     * @returns {Promise<Object|null>} - The best ProviderOffer or null if none found.
     */
    async selectBestOffer(serviceId) {
        try {
            // Find active offers for this service, sorted by priority (highest first)
            const offers = await ProviderOffer.find({
                serviceId,
                status: true
            })
            .populate('providerId')
            .sort({ priority: -1, _id: 1 });

            if (!offers || offers.length === 0) {
                return null;
            }

            // Hardening: Filter out offers where the parent provider is NOT active
            const validOffers = offers.filter(o => o.providerId && o.providerId.status === 'active');

            if (validOffers.length === 0) {
                return null;
            }

            // In manual_priority strategy, we just return the first active offer (highest priority)
            return validOffers[0];
        } catch (error) {
            console.error(`[ProcurementService] Error selecting offer for service ${serviceId}:`, error);
            return null;
        }
    }
}

module.exports = new ProcurementService();
