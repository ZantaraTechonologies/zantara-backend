const pricingService = require('../../services/pricing.service');
const procurementService = require('../../services/procurement.service');
const Service = require('../../models/Service');
const { sendResponse } = require('../../utils/response');
const { logPreviewFailure } = require('../../utils/pricingLogger');

/**
 * Controller for pricing calculation and previews.
 * Keeps pricing authority on the backend.
 */
class PricingController {
    /**
     * POST /api/v1/pricing/calculate
     * Body: { serviceId, serviceCode, amount, quantity }
     * Returns a non-authoritative preview price.
     */
    async calculatePrice(req, res) {
        const { serviceId, serviceCode, amount, quantity } = req.body;
        const user = req.user; // From verifyJWT middleware
        const userId = user?._id || user?.id;

        try {
            if (!serviceId && !serviceCode) {
                logPreviewFailure({
                    userId,
                    serviceId,
                    serviceCode,
                    amount,
                    quantity,
                    errorReason: 'Missing serviceId and serviceCode in request',
                    source: 'pricingController/calculatePrice',
                    clientType: req.headers['x-client-type'] || 'unknown',
                });
                return sendResponse(res, { status: 400, success: false, message: 'Service ID or Service Code is required' });
            }

            // 1. Fetch normalized service
            let query = serviceId ? { _id: serviceId } : { code: serviceCode };
            let service = await Service.findOne(query);

            // 1.1 Fallback: If not found by code, check if serviceCode is a ServiceIdentity slug
            if (!service && serviceCode) {
                const ServiceIdentity = require('../../models/ServiceIdentity');
                const identity = await ServiceIdentity.findOne({ slug: serviceCode.toLowerCase() });
                if (identity) {
                    // Find the primary service for this identity (e.g. for airtime)
                    service = await Service.findOne({ identityId: identity._id });
                }
            }

            if (!service) {
                logPreviewFailure({
                    userId,
                    serviceId,
                    serviceCode,
                    amount,
                    quantity,
                    errorReason: `Service not found: ${serviceId || serviceCode}`,
                    source: 'pricingController/calculatePrice',
                    clientType: req.headers['x-client-type'] || 'unknown',
                });
                return sendResponse(res, { status: 404, success: false, message: 'Service not found or is a legacy service' });
            }

            // 2. Select best provider offer (manual_priority)
            const offer = await procurementService.selectBestOffer(service._id);
            if (!offer) {
                logPreviewFailure({
                    userId,
                    serviceId: String(service._id),
                    serviceCode: service.code,
                    amount,
                    quantity,
                    errorReason: `No active provider offer for service: ${service.name}`,
                    source: 'pricingController/calculatePrice',
                    clientType: req.headers['x-client-type'] || 'unknown',
                });
                return sendResponse(res, { status: 503, success: false, message: 'No active provider available for this service' });
            }

            // 3. Resolve pricing using the engine
            const parsedQuantity = quantity ? Number(quantity) : 1;
            const requestedAmount = (amount || service.suggestedRetailPrice || 0) * parsedQuantity;
            const pricing = await pricingService.resolvePricing(user, service, offer, requestedAmount);

            if (!pricing) {
                logPreviewFailure({
                    userId,
                    serviceId: String(service._id),
                    serviceCode: service.code,
                    amount: requestedAmount,
                    quantity: parsedQuantity,
                    errorReason: 'Pricing engine returned null — no matching pricing rule',
                    source: 'pricingController/calculatePrice',
                    clientType: req.headers['x-client-type'] || 'unknown',
                });
                return sendResponse(res, { status: 400, success: false, message: 'Pricing could not be resolved for this service' });
            }

            return sendResponse(res, {
                success: true,
                data: {
                    serviceId: service._id,
                    serviceName: service.name,
                    baseCostPrice: pricing.baseCostPrice,
                    salePrice: pricing.salePrice, // This is what the user pays
                    fee: pricing.salePrice - requestedAmount > 0 ? pricing.salePrice - requestedAmount : 0,
                    currency: 'NGN',
                    isPreview: true,
                    note: 'This is a preview price and may vary slightly at the time of final purchase.'
                }
            });

        } catch (error) {
            // Log unexpected errors through the structured logger too
            logPreviewFailure({
                userId,
                serviceId,
                serviceCode,
                amount,
                quantity,
                errorReason: error.message || 'Unexpected server error',
                source: 'pricingController/calculatePrice',
                clientType: req.headers['x-client-type'] || 'unknown',
            });
            console.error('[PricingController] Error calculating price:', error);
            return sendResponse(res, {
                status: 500,
                success: false,
                message: 'Internal error during price calculation',
                error: error.message
            });
        }
    }
}

module.exports = new PricingController();
