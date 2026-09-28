const PricingRule = require('../models/PricingRule');
const ProviderOffer = require('../models/ProviderOffer');
const ServiceCategory = require('../models/ServiceCategory');
const ServiceType = require('../models/ServiceType');
const Brand = require('../models/Brand');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
const { sendResponse } = require('../utils/response');
const { logAction } = require('./auditController');
const broadbandReadiness = require('../services/broadbandReadiness.service');
const mongoose = require('mongoose');

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

            const newOffer = new ProviderOffer(offerData);
            await broadbandReadiness.assertActiveOffer(newOffer);
            await newOffer.save();
            
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
            const { priority, status, costPrice, costMode, providerRetailPrice, providerCode, providerServiceCode } = req.body;

            const currentOffer = await ProviderOffer.findById(id);
            if (!currentOffer) return sendResponse(res, { status: 404, success: false, message: 'Offer not found' });
            const linkedService = await Service.findById(currentOffer.serviceId);
            let updatedOffer;
            if (linkedService?.category === 'broadband') {
                if (currentOffer.status && status === false) {
                    await broadbandReadiness.assertActiveOfferRemoval(currentOffer);
                }
                const offerPatch = Object.fromEntries(Object.entries({
                    priority,
                    status,
                    costPrice,
                    costMode,
                    providerRetailPrice,
                    providerCode,
                    providerServiceCode
                }).filter(([, value]) => value !== undefined));
                currentOffer.set(offerPatch);
                await broadbandReadiness.assertActiveOffer(currentOffer);
                updatedOffer = await currentOffer.save();
            } else {
                updatedOffer = await ProviderOffer.findByIdAndUpdate(id, {
                    priority,
                    status,
                    costPrice,
                    costMode,
                    providerRetailPrice,
                    providerCode,
                    providerServiceCode
                }, { new: true, omitUndefined: true });
            }

            await logAction(req.user.id, req.user.name, 'PROVIDER_OFFER_UPDATE', `Offer: ${id}`, req.body, 'success', req);

            return sendResponse(res, { success: true, data: updatedOffer });
        } catch (error) {
            return sendResponse(res, { status: 400, success: false, message: error.message });
        }
    }

    async deleteProviderOffer(req, res) {
        try {
            const { id } = req.params;
            const offer = await ProviderOffer.findById(id);
            if (!offer) return sendResponse(res, { status: 404, success: false, message: 'Offer not found' });
            await broadbandReadiness.assertActiveOfferRemoval(offer);
            await ProviderOffer.findByIdAndDelete(id);

            await logAction(req.user.id, req.user.name, 'PROVIDER_OFFER_DELETE', `Offer: ${id}`, {}, 'success', req);

            return sendResponse(res, { success: true, message: 'Fulfillment mapping deleted' });
        } catch (error) {
            return sendResponse(res, { status: 500, success: false, message: error.message });
        }
    }


    async getServiceIdentities(req, res) {
        try {
            const identities = await ServiceIdentity.find()
                .populate('categoryId', 'name slug status')
                .populate('typeId', 'name slug aliases categoryId status')
                .populate('brandId', 'name typeIds status')
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
                        { targetType: 'service_type', targetId: identity.typeId?._id },
                        { targetType: 'category', targetId: identity.categoryId?._id },
                        { targetType: 'global' }
                    ]
                });

                let readiness = {
                    hasVariants: plansCount > 0,
                    hasFulfillment: offersCount > 0,
                    hasPricing: !!hasPricing,
                    isVisible: identity.status && plansCount > 0 && offersCount > 0 && !!hasPricing
                };

                if (await broadbandReadiness.isBroadbandIdentity(identity)) {
                    const activeServices = await Service.find({ identityId: identity._id, status: true });
                    const identityCheck = await broadbandReadiness.inspectIdentity(identity);
                    const serviceChecks = await Promise.all(activeServices.map(service => (
                        broadbandReadiness.inspectService(identity, service)
                    )));
                    const readyServices = serviceChecks.filter(check => check.ready).length;
                    const errors = [
                        ...identityCheck.errors,
                        ...serviceChecks.flatMap(check => check.errors)
                    ];
                    if (identity.purchaseMode === 'amount' && activeServices.length !== 1) {
                        errors.push('Broadband AMOUNT identity must have exactly one active purchase service');
                    }
                    readiness = {
                        hasVariants: activeServices.length > 0,
                        hasFulfillment: readyServices > 0,
                        hasPricing: !!hasPricing,
                        isVisible: identity.status && activeServices.length > 0
                            && readyServices === activeServices.length && errors.length === 0,
                        errors: [...new Set(errors)]
                    };
                }

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
            const identity = new ServiceIdentity(req.body);
            await broadbandReadiness.assertActiveIdentity(identity);
            await identity.save();
            await logAction(req.user.id, req.user.name, 'SERVICE_IDENTITY_CREATE', `Identity: ${identity.name}`, identity, 'success', req);
            return sendResponse(res, { success: true, data: identity });
        } catch (error) {
            return sendResponse(res, { status: 400, success: false, message: error.message });
        }
    }

    async updateServiceIdentity(req, res) {
        try {
            const { id } = req.params;
            const identity = await ServiceIdentity.findById(id);
            if (!identity) return sendResponse(res, { status: 404, success: false, message: 'Identity not found' });

            identity.set(req.body);
            await broadbandReadiness.assertActiveIdentity(identity);
            await identity.save();
            
            await logAction(req.user.id, req.user.name, 'SERVICE_IDENTITY_UPDATE', `Identity: ${id}`, req.body, 'success', req);
            return sendResponse(res, { success: true, data: identity });
        } catch (error) {
            return sendResponse(res, { status: 400, success: false, message: error.message });
        }
    }

    async deleteServiceIdentity(req, res) {
        let session;
        try {
            session = await mongoose.startSession();
            const { id } = req.params;
            session.startTransaction();
            const identity = await ServiceIdentity.findById(id).session(session);
            if (!identity) {
                await session.abortTransaction();
                return sendResponse(res, { status: 404, success: false, message: 'Identity not found' });
            }
            if (identity.status && await broadbandReadiness.isBroadbandIdentity(identity)) {
                const error = new Error('Deactivate the Broadband identity before deleting it');
                error.statusCode = 409;
                throw error;
            }

            const plans = await Service.find({ identityId: id }).session(session);
            const planIds = plans.map(p => p._id);
            await ProviderOffer.deleteMany({ serviceId: { $in: planIds } }, { session });
            await Service.deleteMany({ identityId: id }, { session });
            await ServiceIdentity.deleteOne({ _id: id }, { session });
            await session.commitTransaction();

            await logAction(req.user.id, req.user.name, 'SERVICE_IDENTITY_DELETE', `Identity: ${id}`, { name: identity.name }, 'success', req);
            
            return sendResponse(res, { success: true, message: 'Service identity and all linked data deleted successfully' });
        } catch (error) {
            if (session) await session.abortTransaction().catch(() => {});
            return sendResponse(res, { status: error.statusCode || 500, success: false, message: error.message });
        } finally {
            if (session) await session.endSession();
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
                if (data.status === false) {
                    await broadbandReadiness.assertParentMutationSafe({ categoryId: id }, 'the category');
                }
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
                if (['status', 'categoryId', 'name', 'slug', 'aliases'].some(key => data[key] !== undefined)) {
                    await broadbandReadiness.assertParentMutationSafe({ typeId: id }, 'the service type');
                }
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
                if (data.status === false || data.typeIds !== undefined) {
                    await broadbandReadiness.assertParentMutationSafe({ brandId: id }, 'the brand');
                }
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
