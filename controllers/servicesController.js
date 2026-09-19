const purchaseService = require('../services/purchase.service')
const providerService = require('../services/provider.service')
const Pin = require('../models/Pin')
const Service = require('../models/Service')
const Transaction = require('../models/Transaction')
const { generateVTPassRequestId } = require('../utils/generateID')
const { verifyMeterWithProvider } = require('../utils/vtuService')
const { sendResponse } = require('../utils/response')
const pricingService = require('../services/pricing.service')
const procurementService = require('../services/procurement.service')
const mongoose = require('mongoose')

const sendPurchaseOutcome = (res, result, successMessage, failureMessage) => {
    if (result.status === 'pending') {
        return sendResponse(res, {
            status: 202,
            success: false,
            message: result.message || 'Transaction is awaiting provider confirmation.',
            data: result.data || {
                status: 'pending',
                providerOutcome: result.providerOutcome,
                reference: result.reference,
                transactionId: result.transactionId,
            },
        });
    }
    if (!result.success) {
        return sendResponse(res, {
            status: 400,
            success: false,
            message: result.message || failureMessage,
            error: result.error,
            data: result.data,
        });
    }
    return sendResponse(res, { message: successMessage, data: result.data });
};

const purchaseAirtime = async (req, res) => {

    const { network, serviceID, phone, billersCode, amount, pin, expectedPrice } = req.body
    const finalNetwork = network || serviceID;
    const finalPhone = phone || billersCode;
    const userId = req.user._id || req.user.id

    if (!finalNetwork || !finalPhone || !amount || !pin) {

        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        const ServiceIdentity = require('../models/ServiceIdentity');

        // Find the service/identity by code (case-insensitive)
        let service = await Service.findOne({ 
            code: { $regex: new RegExp(`^${finalNetwork}$`, 'i') }, 
            category: 'airtime' 
        }).populate('identityId');

        // Fallback: If not found by code, check if finalNetwork is a ServiceIdentity slug
        if (!service) {
            const identity = await ServiceIdentity.findOne({ 
                $or: [
                    { slug: String(finalNetwork).toLowerCase() },
                    { aliases: String(finalNetwork).toLowerCase() }
                ]
            });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id }).populate('identityId');
            }
        }
        if (!service) throw new Error('Service provider configuration not found');

        const result = await purchaseService.processPurchase(userId, {
            type: 'airtime',
            serviceId: finalNetwork,
            canonicalService: service,
            amount,
            pin,
            details: { phone: finalPhone, network: finalNetwork, roles: req.user.roles },
            expectedPrice,
            providerPreflight: selection => providerService.getAdapterInstance(selection.provider),
            providerCall: (refId, resolvedCost, selection) => {
                return selection.adapter.purchaseAirtime({
                    request_id: refId,
                    serviceID: selection.providerServiceCode,
                    phone: finalPhone,
                    amount: resolvedCost || amount,
                })
            }
        })

        return sendPurchaseOutcome(res, result, 'Airtime sent successfully', 'Service provider currently unavailable')
    } catch (err) {

        return sendResponse(res, { status: 500, success: false, message: err?.message || 'Server error', error: err })
    }
}

const purchaseData = async (req, res) => {
    const {
        serviceID,
        network,
        billersCode,
        phone,
        variation_code,
        amount: reqAmount,
        pin,
        expectedPrice
    } = req.body

    // Support both formats (mobile vs older backend)
    const finalServiceID = serviceID || network;
    const finalBillersCode = billersCode || phone;
    const finalPhone = phone || billersCode;
    const amount = reqAmount; // Must be passed from frontend now

    const userId = req.user._id || req.user.id

    if (!finalServiceID || !variation_code || !finalPhone || amount === undefined || !pin) {
        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        // Find the service variant by its internal code (SKU) - Case-insensitive lookup
        const service = await Service.findOne({ 
            code: { $regex: new RegExp(`^${variation_code}$`, 'i') } 
        }).populate('identityId');
        if (!service) throw new Error('Service provider configuration not found');

        const result = await purchaseService.processPurchase(userId, {
            type: 'data',
            serviceId: variation_code,
            canonicalService: service,
            amount,
            pin,
            expectedPrice,
            details: { phone: finalPhone, serviceID: finalServiceID, variation_code, roles: req.user.roles },
            providerPreflight: selection => providerService.getAdapterInstance(selection.provider),
            providerCall: (refId, resolvedCost, selection) => selection.adapter.purchaseData({
                request_id: refId,
                serviceID: selection.providerServiceCode,
                billersCode: finalBillersCode,
                variation_code: selection.providerCode,
                phone: finalPhone,
                amount: resolvedCost || service?.costPrice || service?.price || amount
            })
        })

        return sendPurchaseOutcome(res, result, 'Data purchase successful', 'Service provider currently unavailable')
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message || 'Server error', error: err })
    }
}

const getIdentitiesByCategory = async (req, res) => {
    try {
        const { category } = req.query;
        if (!category) return sendResponse(res, { status: 400, success: false, message: 'Category required' });

        const ServiceIdentity = require('../models/ServiceIdentity');
        const ServiceType = require('../models/ServiceType');

        // 'category' here is actually a service TYPE slug (e.g., 'data', 'airtime', 'tv', 'electricity', 'pin')
        const searchSlug = category.toLowerCase();
        
        // Find the ServiceType using the slug OR looking inside the aliases array
        const typeDoc = await ServiceType.findOne({ 
            $or: [
                { slug: searchSlug },
                { aliases: searchSlug }
            ],
            status: true 
        });

        if (!typeDoc) {
            return sendResponse(res, { status: 404, success: false, message: `Service type '${category}' not found` });
        }

        // Find all active identities for this service type
        const identities = await ServiceIdentity.find({
            status: true,
            typeId: typeDoc._id
        })
            .populate('brandId', 'name logoUrl')
            .populate('typeId', 'name slug')
            .sort({ name: 1 });

        return sendResponse(res, { success: true, data: identities });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: 'Error fetching service identities', error: err.message });
    }
}




const getPlans = async (req, res) => {
    try {
        const { network } = req.params; // network is the identityId or identity slug
        if (!network) return sendResponse(res, { status: 400, success: false, message: 'Identity identifier required' });

        // Find by identityId or identity slug
        const query = mongoose.Types.ObjectId.isValid(network)
            ? { identityId: network, status: true }
            : { status: true }; // If slug, we might need a more complex lookup

        // For now, let's look up the identity first if it's a slug
        let identityId = network;
        if (!mongoose.Types.ObjectId.isValid(network)) {
            const ServiceIdentity = require('../models/ServiceIdentity');
            const identity = await ServiceIdentity.findOne({ slug: network });
            if (!identity) return sendResponse(res, { status: 404, success: false, message: 'Service family not found' });
            identityId = identity._id;
        }

        const plans = await Service.find({
            identityId,
            status: true
        }).sort({ price: 1 });

        // Map to format expected by existing frontend (VTPass variation format)
        const ProviderOffer = require('../models/ProviderOffer');

        const variations = await Promise.all(plans.map(async (p) => {
            try {
                const bestOffer = await ProviderOffer.findOne({ serviceId: p._id, status: true }).sort({ priority: -1 });
                
                let displayPrice = p.price;
                let isPricingPending = false;

                if (bestOffer) {
                    // Apply our layered pricing logic with safety guard
                    const pricing = await pricingService.resolvePricing(req.user || { role: 'all' }, p, bestOffer).catch(() => null);
                    
                    if (pricing) {
                        displayPrice = pricing.salePrice;
                    } else {
                        // Fallback: If engine fails or no rule, add a safe system default (1.5%) to the cost
                        displayPrice = Math.round((bestOffer.costPrice || p.price || 0) * 1.015);
                    }
                } else if (p.price === 0) {
                    isPricingPending = true;
                }

                return {
                    variation_code: p.code,
                    name: isPricingPending ? `${p.name} (Contact Admin)` : p.name,
                    variation_amount: displayPrice || 0,
                    fixedPrice: displayPrice > 0 ? "Yes" : "No"
                };
            } catch (err) {
                console.error(`[getPlans] Error processing plan ${p.code}:`, err);
                return {
                    variation_code: p.code,
                    name: p.name,
                    variation_amount: p.price || 0,
                    fixedPrice: p.price > 0 ? "Yes" : "No"
                };
            }
        }));

        return sendResponse(res, {
            success: true,
            data: { variations }
        });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: 'Error fetching plans', error: err.message });
    }
}

const verifyMeter = async (req, res) => {
    try {
        const { billersCode, serviceID, type } = req.body;
        // Lookup service (case-insensitive)
        let service = await Service.findOne({ 
            code: { $regex: new RegExp(`^${serviceID}$`, 'i') } 
        }).populate('identityId');

        // Fallback: Check if serviceID is an identity slug
        if (!service) {
            const ServiceIdentity = require('../models/ServiceIdentity');
            const identity = await ServiceIdentity.findOne({ 
                $or: [
                    { slug: String(serviceID).toLowerCase() },
                    { aliases: String(serviceID).toLowerCase() }
                ]
            });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id }).populate('identityId');
            }
        }

        if (!service) throw new Error('Service provider configuration not found');
        const offer = await procurementService.selectBestOffer(service._id);
        if (!offer?.providerId?.name) throw new Error('No active provider offer is configured for this service');
        const provider = offer.providerId.name;
        const vendorServiceID = procurementService.resolveProviderServiceCode(service, offer);

        const result = await verifyMeterWithProvider({ billersCode, serviceID: vendorServiceID, type }, provider);
        return sendResponse(res, { data: result });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: 'Meter verification failed', error: err });
    }
}

const verifySmartcard = async (req, res) => {
    try {
        const { billersCode, serviceID, type } = req.body;
        let service = await Service.findOne({ code: serviceID }).populate('identityId');

        // Fallback
        if (!service) {
            const ServiceIdentity = require('../models/ServiceIdentity');
            const identity = await ServiceIdentity.findOne({ slug: String(serviceID).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id }).populate('identityId');
            }
        }

        if (!service) throw new Error('Service provider configuration not found');
        const offer = await procurementService.selectBestOffer(service._id);
        if (!offer?.providerId?.name) throw new Error('No active provider offer is configured for this service');
        const provider = offer.providerId.name;
        const vendorServiceID = procurementService.resolveProviderServiceCode(service, offer);

        const result = await verifyMeterWithProvider({ billersCode, serviceID: vendorServiceID, type }, provider);
        return sendResponse(res, { data: result });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: 'Smartcard verification failed', error: err });
    }
}

const verifyExamProfile = async (req, res) => {
    try {
        const { billersCode, serviceID, type } = req.body;
        let service = await Service.findOne({ code: serviceID }).populate('identityId');

        // Fallback
        if (!service) {
            const ServiceIdentity = require('../models/ServiceIdentity');
            const identity = await ServiceIdentity.findOne({ slug: String(serviceID).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id }).populate('identityId');
            }
        }

        if (!service) throw new Error('Service provider configuration not found');
        const offer = await procurementService.selectBestOffer(service._id);
        if (!offer?.providerId?.name) throw new Error('No active provider offer is configured for this service');
        const provider = offer.providerId.name;
        const vendorServiceID = procurementService.resolveProviderServiceCode(service, offer);

        const result = await verifyMeterWithProvider({ billersCode, serviceID: vendorServiceID, type }, provider);
        return sendResponse(res, { data: result });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: 'Profile verification failed', error: err });
    }
}

const payElectricityBill = async (req, res) => {
    const { serviceID, network, meter_number, billersCode, meter_type, variation_code, amount, phone, pin, expectedPrice } = req.body
    const finalServiceID = serviceID || network;
    const finalMeterNumber = meter_number || billersCode;
    const finalMeterType = meter_type || variation_code;
    const finalPhone = phone || finalMeterNumber;

    const userId = req.user._id || req.user.id

    if (!finalServiceID || !finalMeterNumber || !finalMeterType || !amount || !finalPhone || !pin) {
        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        const ServiceIdentity = require('../models/ServiceIdentity');

        // Lookup the service (case-insensitive)
        let service = await Service.findOne({ 
            code: { $regex: new RegExp(`^${finalServiceID}$`, 'i') }, 
            category: 'electricity' 
        }).populate('identityId');

        // Fallback
        if (!service) {
            const identity = await ServiceIdentity.findOne({ slug: String(finalServiceID).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id }).populate('identityId');
            }
        }
        if (!service) throw new Error('Service provider configuration not found');

        const result = await purchaseService.processPurchase(userId, {
            type: 'electricity',
            serviceId: finalServiceID,
            canonicalService: service,
            amount,
            pin,
            expectedPrice,
            details: { request_id: generateVTPassRequestId(), meter_number: finalMeterNumber, meter_type: finalMeterType, phone: finalPhone, roles: req.user.roles },
            providerPreflight: selection => providerService.getAdapterInstance(selection.provider),
            providerCall: (refId, resolvedCost, selection) => selection.adapter.purchaseElectricity({
                request_id: refId,
                serviceID: selection.providerServiceCode,
                billersCode: finalMeterNumber,
                variation_code: finalMeterType,
                amount: resolvedCost || amount,
                phone: finalPhone
            })
        })

        return sendPurchaseOutcome(res, result, 'Electricity bill paid successfully', 'Service provider currently unavailable')
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message || 'Server error', error: err })
    }
}

const rechargeCable = async (req, res) => {
    const { serviceID, network, billersCode, phone, variation_code, amount, pin, expectedPrice } = req.body
    const finalServiceID = serviceID || network;
    const finalBillersCode = billersCode || phone;
    const finalPhone = phone || finalBillersCode;

    const userId = req.user._id || req.user.id

    if (!finalServiceID || !finalBillersCode || !variation_code || !amount || !pin) {
        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        const ServiceIdentity = require('../models/ServiceIdentity');

        // Lookup the package (variation_code) case-insensitively
        let service = await Service.findOne({ 
            code: { $regex: new RegExp(`^${variation_code}$`, 'i') }, 
            category: 'tv' 
        }).populate('identityId');

        // Fallback to serviceID (identity)
        if (!service) {
            const identity = await ServiceIdentity.findOne({ slug: String(finalServiceID).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id }).populate('identityId');
            }
        }
        if (!service) throw new Error('Service provider configuration not found');

        const result = await purchaseService.processPurchase(userId, {
            type: 'cable',
            serviceId: variation_code, // Use the package code for exact pricing lookup
            canonicalService: service,
            amount,
            pin,
            expectedPrice,
            details: { request_id: generateVTPassRequestId(), serviceID: finalServiceID, billersCode: finalBillersCode, variation_code, roles: req.user.roles },
            providerPreflight: selection => providerService.getAdapterInstance(selection.provider),
            providerCall: (refId, resolvedCost, selection) => selection.adapter.purchaseCable({
                request_id: refId,
                serviceID: selection.providerServiceCode,
                billersCode: finalBillersCode,
                variation_code: selection.providerCode,
                amount: resolvedCost || service?.costPrice || service?.price || amount,
                phone: finalPhone
            })
        })

        return sendPurchaseOutcome(res, result, 'Cable subscription successful', 'Service provider currently unavailable')
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message || 'Server error', error: err })
    }
}

const purchaseExamPin = async (req, res) => {
    const { serviceID, variation_code, amount, quantity, phone, pin, billersCode, expectedPrice } = req.body
    const userId = req.user._id || req.user.id

    if (!pin) {
        return sendResponse(res, { status: 400, success: false, message: 'PIN is required' })
    }

    try {
        const ServiceIdentity = require('../models/ServiceIdentity');

        // Lookup (case-insensitive)
        let service = await Service.findOne({ 
            code: { $regex: new RegExp(`^${variation_code || serviceID}$`, 'i') }, 
            category: 'pin' 
        }).populate('identityId');

        // Fallback
        if (!service) {
            const identity = await ServiceIdentity.findOne({ slug: String(serviceID || variation_code).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id }).populate('identityId');
            }
        }
        if (!service) throw new Error('Service provider configuration not found');

        const { validatePinQuantity } = require('../utils/pinQuantity');
        const quantityValidation = validatePinQuantity(quantity);
        if (!quantityValidation.ok) {
            return sendResponse(res, { status: 400, success: false, message: quantityValidation.message })
        }
        const purchasedQuantity = quantityValidation.quantity;

        const result = await purchaseService.processPurchase(userId, {
            type: 'pin',
            serviceId: variation_code || serviceID,
            canonicalService: service,
            amount, // UNIT face value per card; the engine scales pins by quantity
            pin,
            expectedPrice,
            details: { request_id: generateVTPassRequestId(), serviceID, variation_code, quantity: purchasedQuantity, phone, billersCode, roles: req.user.roles },
            providerPreflight: selection => providerService.getAdapterInstance(selection.provider),
            providerCall: (refId, resolvedCost, selection) => selection.adapter.purchaseExamPin({
                request_id: refId,
                serviceID: selection.providerServiceCode,
                variation_code: selection.providerCode,
                amount: resolvedCost || (service?.costPrice || service?.price || amount) * purchasedQuantity,
                quantity: purchasedQuantity,
                phone,
                billersCode
            })
        })

        if (!result.success) return sendPurchaseOutcome(res, result, '', 'Service provider currently unavailable')

        // Special handling for PIN storage
        try {
            await Pin.create({
                userId,
                service: variation_code,
                code: result.data.token,
                refId: result.data.transactionId,
                status: 'delivered'
            })
        } catch (error) {
            await Transaction.updateOne(
                { _id: result.transactionId, status: 'success' },
                { $set: { resolutionError: 'PIN_INVENTORY_PERSISTENCE_FAILED' } }
            ).catch(() => {});
            return sendResponse(res, {
                status: 202,
                success: false,
                message: 'Provider confirmed the purchase; PIN delivery is pending reconciliation.',
                data: {
                    status: 'pending',
                    providerOutcome: 'success',
                    reference: result.reference,
                    transactionId: result.transactionId,
                },
            });
        }

        return sendResponse(res, {
            message: 'PIN purchased successfully',
            data: {
                pin: result.data.token,
                reference: result.data.transactionId
            }
        })
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message || 'Server error', error: err })
    }
}

const getPurchasedPins = async (req, res) => {
    const pins = await Pin.find({ userId: req.user._id }).sort({ createdAt: -1 })
    return sendResponse(res, { data: { pins } })
}

const checkTransaction = async (req, res) => {
    const { refId } = req.body
    if (!refId) {
        return sendResponse(res, { status: 400, success: false, message: 'Reference ID is required' })
    }

    try {
        // Verification: Ensure the transaction exists and belongs to the user
        const localTx = await Transaction.findOne({
            $or: [{ refId: refId }, { transactionId: refId }],
            userId: req.user.id
        })

        if (!localTx) {
            return sendResponse(res, { status: 404, success: false, message: 'Transaction record not found in local database' })
        }

        if (localTx.status === 'success' || localTx.status === 'failed' || localTx.isLoss) {
            const result = await purchaseService.resolveExistingTransaction(localTx._id, localTx.providerEvidence || {});
            return sendResponse(res, {
                success: result.success,
                message: result.message,
                data: result.data || {
                    status: result.status,
                    providerOutcome: result.providerOutcome,
                    reference: result.reference,
                    transactionId: result.transactionId,
                    refunded: result.refunded,
                },
            });
        }

        if (!localTx.provider) {
            return sendResponse(res, { 
                status: 400, 
                success: false, 
                message: 'Transaction has no associated provider and cannot be requeried' 
            });
        }

        let providerResult;
        try {
            providerResult = await providerService.queryTransaction(localTx.refId, localTx.provider)
        } catch (error) {
            providerResult = {
                success: false,
                status: 'unknown',
                outcome: 'unknown',
                message: 'Provider requery is currently unavailable',
                raw: {},
            };
        }

        const result = await purchaseService.resolveExistingTransaction(localTx._id, providerResult, { isRequery: true });
        if (result.status === 'pending') {
            return sendResponse(res, { status: 202, success: false, message: result.message, data: result.data });
        }
        return sendResponse(res, {
            success: result.success,
            message: result.message,
            data: result.data || {
                status: result.status,
                providerOutcome: result.providerOutcome,
                reference: result.reference,
                transactionId: result.transactionId,
                refunded: result.refunded,
            }
        })
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: 'Error checking transaction status', error: err.message })
    }
}

module.exports = {
    purchaseAirtime,
    purchaseData,
    getIdentitiesByCategory,
    getPlans,
    payElectricityBill,
    verifyMeter,
    verifySmartcard,
    verifyExamProfile,
    checkTransaction,
    rechargeCable,
    purchaseExamPin,
    getPurchasedPins
}
