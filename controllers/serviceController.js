const Service = require('../models/Service');

/**
 * GET /api/admin/services
 * Get all services with category filtering
 */
exports.getAdminServices = async (req, res) => {
    try {
        const { category, status, brandId, identityId } = req.query;
        let filter = {};
        if (category) filter.category = category;
        if (brandId) filter.brandId = brandId;
        if (identityId) filter.identityId = identityId;
        if (status !== undefined) filter.status = status === 'true';

        const services = await Service.find(filter).sort({ category: 1, name: 1 });
        res.json({ success: true, data: services });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * POST /api/admin/services
 * Create a new service record
 */
exports.createService = async (req, res) => {
    try {
        const service = await Service.create(req.body);
        res.status(201).json({ success: true, data: service });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * PUT /api/admin/services/:id
 * Update service pricing or status
 */
exports.updateService = async (req, res) => {
    try {
        const { id } = req.params;
        const service = await Service.findByIdAndUpdate(id, req.body, { new: true });
        if (!service) return res.status(404).json({ success: false, message: 'Service not found' });
        
        res.json({ success: true, data: service, message: 'Service updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * DELETE /api/admin/services/:id
 */
exports.deleteService = async (req, res) => {
    try {
        await Service.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Service deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * POST /api/admin/services/sync-costs
 * Bulk update cost prices from a provider
 */
exports.bulkSyncCosts = async (req, res) => {
    try {
        const { providerName, serviceIDs } = req.body;
        if (!providerName || !serviceIDs || !Array.isArray(serviceIDs)) {
            return res.status(400).json({ success: false, message: 'Invalid payload' });
        }

        const providerService = require('../services/provider.service');
        const results = await providerService.syncProviderCosts(providerName, serviceIDs);

        res.json(results);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * POST /api/admin/services/import
 * Discover and bulk create missing services from a provider
 */
exports.bulkImportServices = async (req, res) => {
    try {
        const { providerName, serviceIDs, categoryIdentifier } = req.body;
        if (!providerName) {
            return res.status(400).json({ success: false, message: 'Provider name required' });
        }

        const providerService = require('../services/provider.service');
        
        let results;
        if (categoryIdentifier) {
            // New level: Import everything in a category (e.g. electricity-bill)
            results = await providerService.importByCategory(providerName, categoryIdentifier);
        } else if (Array.isArray(serviceIDs)) {
            // Existing level: Import specific service IDs
            results = await providerService.importProviderServices(providerName, serviceIDs);
        } else {
            return res.status(400).json({ success: false, message: 'Invalid payload' });
        }

        res.json(results);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
