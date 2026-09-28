const ServiceCategory = require('../../models/ServiceCategory');
const ServiceType = require('../../models/ServiceType');
const Brand = require('../../models/Brand');
const Service = require('../../models/Service');
const { sendResponse } = require('../../utils/response');
const { isBroadbandType } = require('../../services/broadbandReadiness.service');

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
            const services = await Service.find({ status: true, category: { $ne: 'broadband' } })
                .sort({ name: 1 }).lean();
            const publicTypes = types.filter(type => !isBroadbandType(type));

            // Map types to categories
            const categoryMap = categories.map(cat => ({
                ...cat,
                types: publicTypes.filter(t => t.categoryId.toString() === cat._id.toString()).map(t => ({
                    ...t,
                    brands: brands.filter(b => Array.isArray(b.typeIds) && b.typeIds.some(typeId => typeId.toString() === t._id.toString())).map(b => ({
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
            const [categories, types] = await Promise.all([
                ServiceCategory.find({ status: true }).sort({ name: 1 }),
                ServiceType.find({ status: true })
            ]);
            const broadbandCategoryIds = new Set(types
                .filter(isBroadbandType)
                .map(type => String(type.categoryId)));
            const publicCategoryIds = new Set(types
                .filter(type => !isBroadbandType(type))
                .map(type => String(type.categoryId)));
            const publicCategories = categories.filter(category => (
                !broadbandCategoryIds.has(String(category._id))
                || publicCategoryIds.has(String(category._id))
            ));
            return sendResponse(res, { success: true, data: publicCategories });
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
            return sendResponse(res, {
                success: true,
                data: types.filter(type => !isBroadbandType(type))
            });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }
}

module.exports = new CatalogController();
