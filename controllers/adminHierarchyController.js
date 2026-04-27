const PricingRule = require('../models/PricingRule');
const ProviderOffer = require('../models/ProviderOffer');
const ServiceCategory = require('../models/ServiceCategory');
const ServiceType = require('../models/ServiceType');
const Brand = require('../models/Brand');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
const { sendResponse } = require('../utils/response');
const { logAction } = require('./auditController');

/**
 * Controller for administrative management of the normalized hierarchy and pricing rules.
 */
class AdminHierarchyController {
    // --- Pricing Rule Management ---

    async getPricingRules(req, res) {
        try {
            const rules = await PricingRule.find().sort({ createdAt: -1 });
            return sendResponse(res, { success: true, data: rules });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }

    async createPricingRule(req, res) {
        try {
            const ruleData = req.body;
            
            // Fix: If targetType is 'global', targetId should be null, not an empty string
            if (ruleData.targetType === 'global' || !ruleData.targetId) {
                ruleData.targetId = null;
            }

            const newRule = await PricingRule.create(ruleData);
            
            await logAction(req.user.id, req.user.name, 'PRICING_RULE_CREATE', `Rule for ${newRule.targetType}`, newRule, 'success', req);
            
            return sendResponse(res, { success: true, data: newRule });
        } catch (error) {
            return sendResponse(res, { status: 400, success: false, message: error.message });
        }
    }

    async updatePricingRule(req, res) {
        try {
            const { id } = req.params;
            const ruleData = req.body;

            // Fix: Ensure targetId is null if global or empty
            if (ruleData.targetType === 'global' || !ruleData.targetId) {
                ruleData.targetId = null;
            }

            const updatedRule = await PricingRule.findByIdAndUpdate(id, ruleData, { new: true });
            
            if (!updatedRule) return sendResponse(res, { status: 404, success: false, message: 'Rule not found' });

            await logAction(req.user.id, req.user.name, 'PRICING_RULE_UPDATE', `Rule: ${id}`, req.body, 'success', req);

            return sendResponse(res, { success: true, data: updatedRule });
        } catch (error) {
            return sendResponse(res, { status: 400, success: false, message: error.message });
        }
    }

    async deletePricingRule(req, res) {
        try {
            const { id } = req.params;
            const rule = await PricingRule.findByIdAndDelete(id);
            
            if (!rule) return sendResponse(res, { status: 404, success: false, message: 'Rule not found' });

            await logAction(req.user.id, req.user.name, 'PRICING_RULE_DELETE', `Rule: ${id}`, null, 'success', req);

            return sendResponse(res, { success: true, message: 'Pricing rule deleted successfully' });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }

    // --- Provider Offer Management ---

    async createProviderOffer(req, res) {
        try {
            const offerData = req.body;
            
            // Check if mapping already exists
            const existing = await ProviderOffer.findOne({ 
                serviceId: offerData.serviceId, 
                providerId: offerData.providerId 
            });
            
            if (existing) {
                return sendResponse(res, { status: 400, success: false, message: 'Fulfillment route already exists for this provider and variant' });
            }

            const newOffer = await ProviderOffer.create(offerData);
            
            await logAction(req.user.id, req.user.name, 'PROVIDER_OFFER_CREATE', `Offer for variant: ${offerData.serviceId}`, newOffer, 'success', req);
            
            return sendResponse(res, { success: true, data: newOffer });
        } catch (error) {
            return sendResponse(res, { status: 400, success: false, message: error.message });
        }
    }

    async getProviderOffers(req, res) {
        try {
            const { serviceId, identityId } = req.query;
            let query = {};
            
            if (serviceId) {
                query.serviceId = serviceId;
            } else if (identityId) {
                // Find all services (plans) belonging to this identity
                const services = await Service.find({ identityId }).select('_id');
                const serviceIds = services.map(s => s._id);
                query.serviceId = { $in: serviceIds };
            }

            const offers = await ProviderOffer.find(query)
                .populate('providerId', 'name status')
                .populate({
                    path: 'serviceId',
                    select: 'name code identityId',
                    populate: { path: 'identityId', select: 'name' }
                })
                .sort({ serviceId: 1, priority: -1 });

            return sendResponse(res, { success: true, data: offers });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }

    async updateProviderOffer(req, res) {
        try {
            const { id } = req.params;
            const { priority, status, costPrice, costMode, providerRetailPrice, providerCode } = req.body;

            const updatedOffer = await ProviderOffer.findByIdAndUpdate(id, {
                priority,
                status,
                costPrice,
                costMode,
                providerRetailPrice,
                providerCode
            }, { new: true, omitUndefined: true });

            if (!updatedOffer) return sendResponse(res, { status: 404, success: false, message: 'Offer not found' });

            await logAction(req.user.id, req.user.name, 'PROVIDER_OFFER_UPDATE', `Offer: ${id}`, req.body, 'success', req);

            return sendResponse(res, { success: true, data: updatedOffer });
        } catch (error) {
            return sendResponse(res, { status: 400, success: false, message: error.message });
        }
    }

    async deleteProviderOffer(req, res) {
        try {
            const { id } = req.params;
            const deleted = await ProviderOffer.findByIdAndDelete(id);
            if (!deleted) return sendResponse(res, { status: 404, success: false, message: 'Offer not found' });

            await logAction(req.user.id, req.user.name, 'PROVIDER_OFFER_DELETE', `Offer: ${id}`, {}, 'success', req);

            return sendResponse(res, { success: true, message: 'Fulfillment mapping deleted' });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }


    async getServiceIdentities(req, res) {
        try {
            const identities = await ServiceIdentity.find()
                .populate('categoryId', 'name')
                .populate('typeId', 'name')
                .populate('brandId', 'name')
                .sort({ name: 1 });

            // Enhance with counts
            const enhanced = await Promise.all(identities.map(async (identity) => {
                const plansCount = await Service.countDocuments({ identityId: identity._id });
                
                // Get plan IDs to count provider offers
                const planIds = await Service.find({ identityId: identity._id }).select('_id');
                const offersCount = await ProviderOffer.countDocuments({ 
                    serviceId: { $in: planIds.map(p => p._id) } 
                });

                // Check for pricing rules (identity, type, category, or global)
                const hasPricing = await PricingRule.exists({
                    $or: [
                        { targetType: 'identity', targetId: identity._id },
                        { targetType: 'type', targetId: identity.typeId?._id },
                        { targetType: 'category', targetId: identity.categoryId?._id },
                        { targetType: 'global' }
                    ]
                });

                const readiness = {
                    hasVariants: plansCount > 0,
                    hasFulfillment: offersCount > 0,
                    hasPricing: !!hasPricing,
                    isVisible: identity.status && plansCount > 0 && offersCount > 0 && !!hasPricing
                };

                return {
                    ...identity.toObject(),
                    plansCount,
                    offersCount,
                    hasPricing: !!hasPricing,
                    readiness
                };
            }));

            return sendResponse(res, { success: true, data: enhanced });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }

    async createServiceIdentity(req, res) {
        try {
            const identity = await ServiceIdentity.create(req.body);
            await logAction(req.user.id, req.user.name, 'SERVICE_IDENTITY_CREATE', `Identity: ${identity.name}`, identity, 'success', req);
            return sendResponse(res, { success: true, data: identity });
        } catch (error) {
            return sendResponse(res, { status: 400, success: false, message: error.message });
        }
    }

    async updateServiceIdentity(req, res) {
        try {
            const { id } = req.params;
            const identity = await ServiceIdentity.findByIdAndUpdate(id, req.body, { new: true });
            if (!identity) return sendResponse(res, { status: 404, success: false, message: 'Identity not found' });
            
            await logAction(req.user.id, req.user.name, 'SERVICE_IDENTITY_UPDATE', `Identity: ${id}`, req.body, 'success', req);
            return sendResponse(res, { success: true, data: identity });
        } catch (error) {
            return sendResponse(res, { status: 400, success: false, message: error.message });
        }
    }

    async deleteServiceIdentity(req, res) {
        try {
            const { id } = req.params;
            
            // 1. Find all plans linked to this identity
            const plans = await Service.find({ identityId: id });
            const planIds = plans.map(p => p._id);

            // 2. Delete all fulfillment mappings for those plans
            await ProviderOffer.deleteMany({ serviceId: { $in: planIds } });

            // 3. Delete the plans
            await Service.deleteMany({ identityId: id });

            // 4. Delete the identity itself
            const deleted = await ServiceIdentity.findByIdAndDelete(id);
            if (!deleted) return sendResponse(res, { status: 404, success: false, message: 'Identity not found' });

            await logAction(req.user.id, req.user.name, 'SERVICE_IDENTITY_DELETE', `Identity: ${id}`, { name: deleted.name }, 'success', req);
            
            return sendResponse(res, { success: true, message: 'Service identity and all linked data deleted successfully' });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }

    async getHierarchyMetadata(req, res) {
        try {
            const { typeId } = req.query;
            
            const categories = await ServiceCategory.find({ status: true }).sort({ name: 1 });
            const types = await ServiceType.find({ status: true }).sort({ name: 1 });
            
            let brandQuery = { status: true };
            if (typeId) {
                // Check if typeId exists in the typeIds array
                brandQuery.typeIds = typeId; 
            }
            
            const brands = await Brand.find(brandQuery).sort({ name: 1 });
            
            return sendResponse(res, { 
                success: true, 
                data: { categories, types, brands } 
            });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }

    async safePurgeNoisyData(req, res) {
        try {
            // Guard: Only allow in development or with explicit confirmation
            if (process.env.NODE_ENV === 'production') {
                return sendResponse(res, { status: 403, success: false, message: 'Purge not allowed in production environment' });
            }

            // Narrowly scope deletion to Service records that have no identityId
            // These represent the "noisy" legacy/imported plans
            const noisyServices = await Service.find({ 
                $or: [
                    { identityId: null },
                    { identityId: { $exists: false } }
                ]
            }).select('_id');
            
            const serviceIds = noisyServices.map(s => s._id);

            // Delete associated ProviderOffers first
            const deletedOffers = await ProviderOffer.deleteMany({ 
                serviceId: { $in: serviceIds } 
            });

            // Delete the Services
            const deletedServices = await Service.deleteMany({ 
                _id: { $in: serviceIds } 
            });

            await logAction(req.user.id, req.user.name, 'CATALOG_PURGE', 'Noisy imported data cleared', { 
                deletedServices: deletedServices.deletedCount, 
                deletedOffers: deletedOffers.deletedCount 
            }, 'success', req);

            return sendResponse(res, { 
                success: true, 
                message: `Purge complete. Removed ${deletedServices.deletedCount} noisy services and ${deletedOffers.deletedCount} associated offers.`,
                deletedCount: deletedServices.deletedCount
            });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }

    // --- Master Data Management (Phase A) ---

    async manageCategories(req, res) {
        try {
            const { id } = req.params;
            const data = req.body;

            if (req.method === 'POST') {
                // Check uniqueness
                const exists = await ServiceCategory.findOne({ name: { $regex: new RegExp(`^${data.name}$`, 'i') } });
                if (exists) return sendResponse(res, { status: 400, success: false, message: 'Category name already exists' });
                
                const category = await ServiceCategory.create({ ...data, slug: data.name.toLowerCase().replace(/ /g, '-') });
                return sendResponse(res, { success: true, data: category });
            }

            if (req.method === 'PUT') {
                const category = await ServiceCategory.findByIdAndUpdate(id, data, { new: true });
                return sendResponse(res, { success: true, data: category });
            }

            const categories = await ServiceCategory.find().sort({ name: 1 });
            return sendResponse(res, { success: true, data: categories });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }

    async manageServiceTypes(req, res) {
        try {
            const { id } = req.params;
            const data = req.body;

            if (req.method === 'POST') {
                // Check uniqueness within category
                const exists = await ServiceType.findOne({ 
                    name: { $regex: new RegExp(`^${data.name}$`, 'i') },
                    categoryId: data.categoryId
                });
                if (exists) return sendResponse(res, { status: 400, success: false, message: 'Service type already exists in this category' });
                
                const type = await ServiceType.create({ ...data, slug: data.name.toLowerCase().replace(/ /g, '-') });
                return sendResponse(res, { success: true, data: type });
            }

            if (req.method === 'PUT') {
                const type = await ServiceType.findByIdAndUpdate(id, data, { new: true });
                return sendResponse(res, { success: true, data: type });
            }

            const types = await ServiceType.find().populate('categoryId', 'name').sort({ categoryId: 1, name: 1 });
            return sendResponse(res, { success: true, data: types });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }

    async manageBrands(req, res) {
        try {
            const { id } = req.params;
            const data = req.body;

            if (req.method === 'POST') {
                // Check uniqueness globally for Normalized Model
                const exists = await Brand.findOne({ name: { $regex: new RegExp(`^${data.name}$`, 'i') } });
                if (exists) return sendResponse(res, { status: 400, success: false, message: 'Brand name already exists globally' });
                
                const brand = await Brand.create({ ...data, slug: data.name.toLowerCase().replace(/ /g, '-') });
                return sendResponse(res, { success: true, data: brand });
            }

            if (req.method === 'PUT') {
                const brand = await Brand.findByIdAndUpdate(id, data, { new: true });
                return sendResponse(res, { success: true, data: brand });
            }

            const brands = await Brand.find().populate('typeIds', 'name').sort({ name: 1 });
            return sendResponse(res, { success: true, data: brands });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }
}

module.exports = new AdminHierarchyController();
