const purchaseService = require('../services/purchase.service')
const providerService = require('../services/provider.service')
const Pin = require('../models/Pin')
const Service = require('../models/Service')
const Transaction = require('../models/Transaction')
const { verifyMeterWithProvider } = require('../utils/vtuService')
const { sendResponse } = require('../utils/response')
const pricingService = require('../services/pricing.service')
const procurementService = require('../services/procurement.service')
const mongoose = require('mongoose')
const { decryptFulfillment } = require('../utils/fulfillment')
const { decryptSecret, isEncrypted } = require('../utils/crypto')
const ServiceIdentity = require('../models/ServiceIdentity')
const broadbandReadiness = require('../services/broadbandReadiness.service')

const getSelectedProviderAdapter = selection => providerService.getAdapterInstance(
    selection.provider,
    {
        providerId: selection.providerId,
        adapterType: selection.providerAdapterType,
        configSnapshot: selection.providerConfigSnapshot,
        credentialSnapshot: selection.providerCredentialSnapshot,
    }
)

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
            category: 'airtime',
            status: true
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
                service = await Service.findOne({ identityId: identity._id, category: 'airtime', status: true })
                    .populate('identityId');
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
            providerPreflight: getSelectedProviderAdapter,
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
            code: { $regex: new RegExp(`^${variation_code}$`, 'i') },
            category: 'data',
            status: true
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
            providerPreflight: getSelectedProviderAdapter,
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

        if (broadbandReadiness.isBroadbandType(typeDoc)) {
            const readyIdentities = [];
            for (const identity of identities) {
                const identityCheck = await broadbandReadiness.inspectIdentity(identity);
                if (!identityCheck.ready) continue;
                const services = await Service.find({
                    identityId: identity._id,
                    category: 'broadband',
                    status: true
                });
                if (services.length === 0
                    || (identity.purchaseMode === 'amount' && services.length !== 1)) continue;
                const serviceChecks = await Promise.all(
                    services.map(service => broadbandReadiness.inspectService(identity, service))
                );
                if (serviceChecks.some(check => !check.ready)) continue;

                const policyObject = value => value?.toObject ? value.toObject() : value || null;
                const safeReference = value => value ? {
                    id: value._id || value,
                    ...(value.name ? { name: value.name } : {}),
                    ...(value.slug ? { slug: value.slug } : {}),
                    ...(value.logoUrl ? { logoUrl: value.logoUrl } : {})
                } : null;
                readyIdentities.push({
                    serviceIdentityId: identity._id,
                    name: identity.name,
                    slug: identity.slug,
                    purchaseMode: identity.purchaseMode,
                    identifierPolicy: policyObject(identity.identifierPolicy),
                    verificationPolicy: policyObject(identity.verificationPolicy),
                    amountPolicy: policyObject(identity.amountPolicy),
                    brand: safeReference(identity.brandId),
                    type: safeReference(identity.typeId)
                });
            }
            return sendResponse(res, { success: true, data: readyIdentities });
        }

        return sendResponse(res, { success: true, data: identities });
    } catch (err) {
        return sendResponse(res, {
            status: 503,
            success: false,
            message: 'Service catalogue is temporarily unavailable'
        });
    }
}




const getPlans = async (req, res) => {
    try {
        const { network } = req.params; // network is the identityId or identity slug
        if (!network) return sendResponse(res, { status: 400, success: false, message: 'Identity identifier required' });

        const identity = mongoose.Types.ObjectId.isValid(network)
            ? await ServiceIdentity.findById(network)
            : await ServiceIdentity.findOne({ slug: network });
        if (!identity) return sendResponse(res, { status: 404, success: false, message: 'Service family not found' });
        if (await broadbandReadiness.isBroadbandIdentity(identity)) {
            return sendResponse(res, {
                status: 409,
                success: false,
                message: 'Broadband plans are available through the canonical identity plan endpoint',
                data: { serviceIdentityId: identity._id }
            });
        }
        const identityId = identity._id;

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
            code: { $regex: new RegExp(`^${serviceID}$`, 'i') },
            category: 'electricity',
            status: true
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
                service = await Service.findOne({ identityId: identity._id, category: 'electricity', status: true })
                    .populate('identityId');
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
        let service = await Service.findOne({ code: serviceID, category: 'tv', status: true }).populate('identityId');

        // Fallback
        if (!service) {
            const ServiceIdentity = require('../models/ServiceIdentity');
            const identity = await ServiceIdentity.findOne({ slug: String(serviceID).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id, category: 'tv', status: true })
                    .populate('identityId');
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
        let service = await Service.findOne({ code: serviceID, category: 'pin', status: true }).populate('identityId');

        // Fallback
        if (!service) {
            const ServiceIdentity = require('../models/ServiceIdentity');
            const identity = await ServiceIdentity.findOne({ slug: String(serviceID).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id, category: 'pin', status: true })
                    .populate('identityId');
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
            category: 'electricity',
            status: true
        }).populate('identityId');

        // Fallback
        if (!service) {
            const identity = await ServiceIdentity.findOne({ slug: String(finalServiceID).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id, category: 'electricity', status: true })
                    .populate('identityId');
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
            details: { meter_number: finalMeterNumber, meter_type: finalMeterType, phone: finalPhone, roles: req.user.roles },
            providerPreflight: getSelectedProviderAdapter,
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
            category: 'tv',
            status: true
        }).populate('identityId');

        // Fallback to serviceID (identity)
        if (!service) {
            const identity = await ServiceIdentity.findOne({ slug: String(finalServiceID).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id, category: 'tv', status: true })
                    .populate('identityId');
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
            details: { serviceID: finalServiceID, billersCode: finalBillersCode, variation_code, roles: req.user.roles },
            providerPreflight: getSelectedProviderAdapter,
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
            category: 'pin',
            status: true
        }).populate('identityId');

        // Fallback
        if (!service) {
            const identity = await ServiceIdentity.findOne({ slug: String(serviceID || variation_code).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id, category: 'pin', status: true })
                    .populate('identityId');
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
            details: { serviceID, variation_code, quantity: purchasedQuantity, phone, billersCode, roles: req.user.roles },
            providerPreflight: getSelectedProviderAdapter,
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

        const fulfillment = result.data.fulfillment || { items: [] };

        return sendResponse(res, {
            message: 'PIN purchased successfully',
            data: {
                pin: fulfillment.items[0]?.code || result.data.token,
                pins: fulfillment.items.map(item => ({ code: item.code, serial: item.serial || null })),
                fulfillment,
                reference: result.data.transactionId
            }
        })
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message || 'Server error', error: err })
    }
}

const getPurchasedPins = async (req, res) => {
    const userId = req.user._id || req.user.id;
    const transactions = await Transaction.find({
        userId,
        type: 'pin',
        status: 'success',
        'fulfillment.complete': true,
    }).sort({ createdAt: -1 });
    const authoritativePins = transactions.flatMap(transaction => {
        const fulfillment = decryptFulfillment(transaction.fulfillment);
        if (!fulfillment.complete) return [];
        return fulfillment.items.map((item, index) => ({
            _id: index === 0 ? transaction._id : `${transaction._id}:${index}`,
            userId: transaction.userId,
            service: transaction.details?.variation_code || transaction.service,
            code: item.code,
            serial: item.serial || null,
            refId: transaction.transactionId,
            status: 'delivered',
            createdAt: transaction.createdAt,
            updatedAt: transaction.updatedAt,
        }));
    });

    const legacyDocuments = await Pin.find({ userId }).sort({ createdAt: -1 });
    const authoritativeRefs = new Set(transactions.flatMap(transaction => [
        String(transaction.refId),
        String(transaction.transactionId),
    ]));
    const legacyPins = legacyDocuments
        .map(document => typeof document.toObject === 'function' ? document.toObject() : document)
        .filter(document => !authoritativeRefs.has(String(document.refId)))
        .map(document => {
            const code = decryptSecret(document.code);
            const serial = decryptSecret(document.serial);
            if (!code || isEncrypted(code)) return null;
            return {
                ...document,
                code,
                serial: serial && !isEncrypted(serial) ? serial : null,
            };
        })
        .filter(Boolean);

    return sendResponse(res, { data: { pins: [...authoritativePins, ...legacyPins] } })
}

const getPlansByIdentityId = async (req, res) => {
    try {
        const { serviceIdentityId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(serviceIdentityId)) {
            return sendResponse(res, { status: 400, success: false, message: 'Valid identity ID required' });
        }

        const identity = await ServiceIdentity.findOne({ _id: serviceIdentityId, status: true })
            .populate('brandId', 'name logoUrl')
            .populate('typeId', 'name slug aliases');

        if (!identity) {
            return sendResponse(res, { status: 404, success: false, message: 'Service identity not found' });
        }

        const isBroadband = await broadbandReadiness.isBroadbandIdentity(identity);
        let broadbandIdentityCheck = null;
        if (isBroadband) {
            broadbandIdentityCheck = await broadbandReadiness.inspectIdentity(identity);
            if (!broadbandIdentityCheck.ready) {
                return sendResponse(res, {
                    status: 409,
                    success: false,
                    message: 'Broadband service identity is not ready'
                });
            }
        }

        const services = await Service.find({ identityId: identity._id, status: true })
            .sort({ price: 1, name: 1, _id: 1 });

        if (isBroadband && identity.purchaseMode === 'amount') {
            const amountServices = services.filter(service => service.category === 'broadband');
            if (amountServices.length !== 1) {
                return sendResponse(res, {
                    status: 409,
                    success: false,
                    message: 'Broadband AMOUNT identity is not ready'
                });
            }
            const readiness = await broadbandReadiness.inspectService(identity, amountServices[0]);
            if (!readiness.ready) {
                return sendResponse(res, {
                    status: 409,
                    success: false,
                    message: 'Broadband AMOUNT identity is not ready'
                });
            }
        }

        const plans = (await Promise.all(services.map(async service => {
            if (service.status === false) return null;
            if (isBroadband) {
                if (identity.purchaseMode !== 'plan' || service.category !== 'broadband') return null;
                const hierarchyErrors = broadbandReadiness.hierarchyErrors({
                    identity,
                    service,
                    ...broadbandIdentityCheck
                });
                if (hierarchyErrors.length) return null;
            }
            if (service.category === 'broadband'
                && (!identity.purchaseMode || !identity.identifierPolicy || !identity.verificationPolicy)) {
                return null;
            }
            const requiredOperations = service.category === 'broadband'
                ? broadbandReadiness.requiredOperationsForIdentity(identity)
                : [];
            const offer = await procurementService.selectBestOffer(service._id, {
                requiredOperations,
                offerValidator: candidate => service.category !== 'broadband'
                    || broadbandReadiness.offerErrors({ identity, service, offer: candidate }).length === 0
            });
            if (!offer) return null;
            if (service.category === 'broadband'
                && (!String(offer.providerCode || '').trim()
                    || !String(offer.providerServiceCode || '').trim()
                    || (offer.currency || 'NGN') !== 'NGN'
                    || (identity.purchaseMode === 'amount' && offer.costMode !== 'dynamic')
                    || (identity.purchaseMode === 'plan' && offer.costMode !== 'fixed'))) {
                return null;
            }

            const isAmountMode = identity.purchaseMode === 'amount';
            const pricing = isAmountMode
                ? null
                : await pricingService.resolvePricing(req.user || { role: 'all' }, service, offer);

            return {
                ...(isBroadband
                    ? { planId: service._id, serviceIdentityId: identity._id }
                    : { id: service._id, identityId: identity._id }),
                code: service.code,
                name: service.name,
                category: service.category,
                categoryId: service.categoryId,
                typeId: service.typeId,
                brandId: service.brandId,
                inputSchema: service.inputSchema || {},
                fulfillmentMode: service.fulfillmentMode,
                price: {
                    mode: identity.purchaseMode || null,
                    currency: identity.amountPolicy?.currency || offer.currency || 'NGN',
                    salePrice: pricing?.salePrice ?? null,
                    referencePrice: pricing?.retailPrice ?? service.suggestedRetailPrice ?? null,
                    savings: pricing?.savings ?? null,
                    fixed: identity.purchaseMode === 'plan'
                }
            };
        }))).filter(Boolean);

        const policyObject = value => value?.toObject ? value.toObject() : value || null;
        const populatedReference = reference => {
            if (!reference) return null;
            if (!reference.name) return { id: reference };
            return {
                id: reference._id,
                name: reference.name,
                ...(reference.slug ? { slug: reference.slug } : {}),
                ...(reference.logoUrl ? { logoUrl: reference.logoUrl } : {})
            };
        };

        return sendResponse(res, {
            success: true,
            data: {
                identity: {
                    ...(isBroadband
                        ? { serviceIdentityId: identity._id }
                        : { id: identity._id }),
                    name: identity.name,
                    slug: identity.slug,
                    purchaseMode: identity.purchaseMode || null,
                    identifierPolicy: policyObject(identity.identifierPolicy),
                    verificationPolicy: policyObject(identity.verificationPolicy),
                    amountPolicy: policyObject(identity.amountPolicy),
                    brand: populatedReference(identity.brandId),
                    type: populatedReference(identity.typeId)
                },
                plans
            }
        });
    } catch (err) {
        return sendResponse(res, {
            status: 503,
            success: false,
            message: 'Service catalogue is temporarily unavailable'
        });
    }
}

const checkTransaction = async (req, res) => {
    const { refId } = req.body
    if (!refId) {
        return sendResponse(res, { status: 400, success: false, message: 'Reference ID is required' })
    }

    try {
        // Verification: Ensure the transaction exists and belongs to the user
        const localTxQuery = Transaction.findOne({
            $or: [{ refId: refId }, { transactionId: refId }],
            userId: req.user.id
        })
        const localTx = typeof localTxQuery?.select === 'function'
            ? await localTxQuery.select('+providerCredentialSnapshot')
            : await localTxQuery

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
            providerResult = await providerService.queryTransaction(
                localTx.providerRequestId || localTx.refId,
                localTx.provider,
                {
                    providerId: localTx.providerId || localTx.pricingSnapshot?.providerId,
                    adapterType: localTx.providerAdapterType,
                    configSnapshot: localTx.providerConfigSnapshot,
                    credentialSnapshot: localTx.providerCredentialSnapshot,
                }
            )
        } catch (error) {
            providerResult = {
                success: false,
                status: 'unknown',
                outcome: 'unknown',
                message: 'Provider requery is currently unavailable',
                raw: {},
            };
        }

        let result;
        try {
            result = await purchaseService.resolveExistingTransaction(localTx._id, providerResult, { isRequery: true });
        } catch (error) {
            if (localTx.type !== 'broadband') throw error;
            result = await purchaseService._postDispatchFailureResult(localTx, error, {
                preserveDispatchState: true,
                knownResponse: providerResult
            });
        }
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
        return sendResponse(res, {
            status: 503,
            success: false,
            message: 'We could not refresh this transaction status right now'
        })
    }
}

module.exports = {
    purchaseAirtime,
    purchaseData,
    getIdentitiesByCategory,
    getPlans,
    getPlansByIdentityId,
    payElectricityBill,
    verifyMeter,
    verifySmartcard,
    verifyExamProfile,
    checkTransaction,
    rechargeCable,
    purchaseExamPin,
    getPurchasedPins
}
