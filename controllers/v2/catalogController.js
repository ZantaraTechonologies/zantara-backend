const ServiceCategory = require('../../models/ServiceCategory');
const ServiceType = require('../../models/ServiceType');
const Brand = require('../../models/Brand');
const Service = require('../../models/Service');
const { sendResponse } = require('../../utils/response');

/**
 * Controller for normalized catalog exposure.
 * Optimized for storefront rendering with nested structure.
 */
class CatalogController {
    /**
     * GET /api/v2/catalog
     * Returns the full hierarchy: Category -> Type -> Brand -> Service
     */
    async getCatalog(req, res) {
        try {
            // Fetch all active entities
            const categories = await ServiceCategory.find({ status: true }).sort({ name: 1 }).lean();
            const types = await ServiceType.find({ status: true }).sort({ name: 1 }).lean();
            const brands = await Brand.find({ status: true }).sort({ name: 1 }).lean();
            const services = await Service.find({ status: true }).sort({ name: 1 }).lean();

            // Map types to categories
            const categoryMap = categories.map(cat => ({
                ...cat,
                types: types.filter(t => t.categoryId.toString() === cat._id.toString()).map(t => ({
                    ...t,
                    brands: brands.filter(b => b.typeId.toString() === t._id.toString()).map(b => ({
                        ...b,
                        services: services.filter(s => 
                            s.brandId && s.brandId.toString() === b._id.toString() &&
                            s.typeId && s.typeId.toString() === t._id.toString()
                        ).map(s => ({
                            _id: s._id,
                            name: s.name,
                            code: s.code,
                            description: s.description,
                            category: s.category, // legacy field for fallback
                            categoryId: s.categoryId,
                            typeId: s.typeId,
                            brandId: s.brandId,
                            inputSchema: s.inputSchema,
                            fulfillmentMode: s.fulfillmentMode,
                            suggestedRetailPrice: s.suggestedRetailPrice // if useful
                        }))
                    }))
                }))
            }));

            // Filter out empty types/brands/categories if needed or keep structure
            // For now, return the full structure to allow frontend flexibility
            
            return sendResponse(res, {
                success: true,
                data: categoryMap
            });
        } catch (error) {
            console.error('[CatalogController] Error fetching catalog:', error);
            return sendResponse(res, {
                status: 500,
                success: false,
                message: 'Failed to fetch normalized catalog',
                error: error.message
            });
        }
    }

    /**
     * GET /api/v2/catalog/categories
     */
    async getCategories(req, res) {
        try {
            const categories = await ServiceCategory.find({ status: true }).sort({ name: 1 });
            return sendResponse(res, { success: true, data: categories });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }

    /**
     * GET /api/v2/catalog/types/:categoryId
     */
    async getTypesByCategory(req, res) {
        try {
            const { categoryId } = req.params;
            const types = await ServiceType.find({ categoryId, status: true }).sort({ name: 1 });
            return sendResponse(res, { success: true, data: types });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }
}

module.exports = new CatalogController();
