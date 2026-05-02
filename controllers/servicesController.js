const purchaseService = require('../services/purchase.service')
const providerService = require('../services/provider.service')
const Wallet = require('../models/Wallet')
const Pin = require('../models/Pin')
const Service = require('../models/Service')
const Transaction = require('../models/Transaction')
const { generateVTPassRequestId } = require('../utils/generateID')
const { fetchPlans, verifyMeterWithProvider } = require('../utils/vtuService')
const { sendResponse } = require('../utils/response')
const notificationService = require('../services/notification.service')
const pricingService = require('../services/pricing.service')
const mongoose = require('mongoose')

const purchaseAirtime = async (req, res) => {

    const { network, serviceID, phone, billersCode, amount, pin, expectedPrice } = req.body
    const finalNetwork = network || serviceID;
    const finalPhone = phone || billersCode;
    const userId = req.user._id || req.user.id

    if (!finalNetwork || !finalPhone || !amount || !pin) {

        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        const ProviderOffer = require('../models/ProviderOffer');
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

        let vendorCode = finalNetwork;
        if (service) {
            // Find active fulfillment mapping
            const activeMapping = await ProviderOffer.findOne({ 
                serviceId: service._id, 
                status: true 
            }).sort({ priority: 1 });

            vendorCode = activeMapping?.providerCode || service.identityId?.providerCode || service.providerCode || finalNetwork;
        }

        const provider = service?.provider || 'VTPass';

        const result = await purchaseService.processPurchase(userId, {
            type: 'airtime',
            serviceId: finalNetwork,
            amount,
            pin,
            provider,
            details: { phone: finalPhone, network: finalNetwork, roles: req.user.roles },
            expectedPrice,
            providerCall: (refId) => {
                return providerService.purchaseAirtime({ request_id: refId, serviceID: vendorCode, phone: finalPhone, amount }, provider)
            }
        })

        if (!result.success) {

            return sendResponse(res, { status: 400, success: false, message: result.message, error: result.error })
        }

        await notificationService.sendInApp(userId, {
            title: 'Airtime Purchase Successful',
            message: `You successfully purchased ₦${amount} Airtime for ${finalPhone}.`,
            type: 'transaction',
            metadata: { type: 'airtime', network: finalNetwork, amount }
        });

        return sendResponse(res, { message: 'Airtime sent successfully', data: result.data })
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
        const ProviderOffer = require('../models/ProviderOffer');
        const service = await Service.findOne({ 
            code: { $regex: new RegExp(`^${variation_code}$`, 'i') } 
        }).populate('identityId');

        let variationProviderCode = variation_code;

        if (service) {
            // Find the active fulfillment mapping for this service
            const activeMapping = await ProviderOffer.findOne({ 
                serviceId: service._id, 
                status: true 
            }).sort({ priority: 1 });

            // Use mapped provider code, or fallback to service's own providerCode, or finally the variation_code
            variationProviderCode = activeMapping?.providerCode || service.providerCode || variation_code;
        }

        const provider = service?.provider || 'VTPass';
        const vendorServiceID = service?.identityId?.providerCode || finalServiceID;

        const result = await purchaseService.processPurchase(userId, {
            type: 'data',
            serviceId: variation_code,
            amount,
            pin,
            provider,
            expectedPrice,
            details: { phone: finalPhone, serviceID: finalServiceID, variation_code, roles: req.user.roles },
            providerCall: (refId, resolvedCost) => providerService.purchaseData({
                request_id: refId,
                serviceID: vendorServiceID,
                billersCode: finalBillersCode,
                variation_code: variationProviderCode,
                phone: finalPhone,
                amount: resolvedCost || service?.costPrice || service?.price || amount
            }, provider)
        })

        if (!result.success) {
            return sendResponse(res, { status: 400, success: false, message: result.message || 'Service provider currently unavailable', error: result.error })
        }
        await notificationService.sendInApp(userId, {
            title: 'Data Purchase Successful',
            message: `Your data purchase for ${finalPhone} was successful.`,
            type: 'transaction',
            metadata: { type: 'data', amount, variation_code }
        });

        return sendResponse(res, { message: 'Data purchase successful', data: result.data })
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

        const provider = service?.provider || 'VTPass';
        const vendorServiceID = service?.identityId?.providerCode || service?.providerCode || serviceID;

        const result = await verifyMeterWithProvider({ billersCode, serviceID: vendorServiceID, type }, provider);
        return sendResponse(res, { data: result });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: 'Meter verification failed', error: err });
    }
}

const verifySmartcard = async (req, res) => {
    try {
        const { billersCode, serviceID, type } = req.body;
        let service = await Service.findOne({ code: serviceID });

        // Fallback
        if (!service) {
            const ServiceIdentity = require('../models/ServiceIdentity');
            const identity = await ServiceIdentity.findOne({ slug: String(serviceID).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id }).populate('identityId');
            }
        }

        const provider = service?.provider || 'VTPass';
        const vendorServiceID = service?.identityId?.providerCode || service?.providerCode || serviceID;

        const result = await verifyMeterWithProvider({ billersCode, serviceID: vendorServiceID, type }, provider);
        return sendResponse(res, { data: result });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: 'Smartcard verification failed', error: err });
    }
}

const verifyExamProfile = async (req, res) => {
    try {
        const { billersCode, serviceID, type } = req.body;
        let service = await Service.findOne({ code: serviceID });

        // Fallback
        if (!service) {
            const ServiceIdentity = require('../models/ServiceIdentity');
            const identity = await ServiceIdentity.findOne({ slug: String(serviceID).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id }).populate('identityId');
            }
        }

        const provider = service?.provider || 'VTPass';
        const vendorServiceID = service?.identityId?.providerCode || service?.providerCode || serviceID;

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
        const ProviderOffer = require('../models/ProviderOffer');
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

        let vendorServiceID = finalServiceID;
        if (service) {
            // Find mapping
            const activeMapping = await ProviderOffer.findOne({ serviceId: service._id, status: true }).sort({ priority: 1 });
            vendorServiceID = activeMapping?.providerCode || service.identityId?.providerCode || service.providerCode || finalServiceID;
        }

        const provider = service?.provider || 'VTPass';

        const result = await purchaseService.processPurchase(userId, {
            type: 'electricity',
            serviceId: finalServiceID,
            amount,
            pin,
            provider,
            expectedPrice,
            details: { request_id: generateVTPassRequestId(), meter_number: finalMeterNumber, meter_type: finalMeterType, phone: finalPhone, roles: req.user.roles },
            providerCall: (refId, resolvedCost) => providerService.purchaseElectricity({
                request_id: refId,
                serviceID: vendorServiceID,
                billersCode: finalMeterNumber,
                variation_code: finalMeterType,
                amount: resolvedCost || amount,
                phone: finalPhone
            }, provider)
        })

        if (!result.success) {
            return sendResponse(res, { status: 400, success: false, message: result.message || 'Service provider currently unavailable', error: result.error })
        }
        const token = result.data?.token || result.data?.mainToken || '';

        await notificationService.sendInApp(userId, {
            title: 'Electricity Bill Paid',
            message: `Electricity payment of ₦${amount} for ${finalMeterNumber} successful. ${token ? 'Token: ' + token : ''}`,
            type: 'transaction',
            metadata: { type: 'electricity', amount, token, meter: finalMeterNumber }
        });

        return sendResponse(res, { message: 'Electricity bill paid successfully', data: result.data })
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
        const ProviderOffer = require('../models/ProviderOffer');
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

        let vendorServiceID = finalServiceID;
        let variationProviderCode = variation_code;

        if (service) {
            // Check mapping
            const activeMapping = await ProviderOffer.findOne({ serviceId: service._id, status: true }).sort({ priority: 1 });
            variationProviderCode = activeMapping?.providerCode || service.providerCode || variation_code;
            vendorServiceID = service.identityId?.providerCode || finalServiceID;
        }

        const provider = service?.provider || 'VTPass';

        const result = await purchaseService.processPurchase(userId, {
            type: 'cable',
            serviceId: variation_code, // Use the package code for exact pricing lookup
            amount,
            pin,
            provider,
            expectedPrice,
            details: { request_id: generateVTPassRequestId(), serviceID: finalServiceID, billersCode: finalBillersCode, variation_code, roles: req.user.roles },
            providerCall: (refId, resolvedCost) => providerService.purchaseCable({
                request_id: refId,
                serviceID: vendorServiceID,
                billersCode: finalBillersCode,
                variation_code: variationProviderCode,
                amount: resolvedCost || service?.costPrice || service?.price || amount,
                phone: finalPhone
            }, provider)
        })

        if (!result.success) {
            return sendResponse(res, { status: 400, success: false, message: result.message || 'Service provider currently unavailable', error: result.error })
        }
        await notificationService.sendInApp(userId, {
            title: 'Cable Update',
            message: `Cable TV subscription of ₦${amount} for ${finalBillersCode} successful.`,
            type: 'transaction',
            metadata: { type: 'cable', amount, decoder: finalBillersCode }
        });

        return sendResponse(res, { message: 'Cable subscription successful', data: result.data })
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
        const ProviderOffer = require('../models/ProviderOffer');
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

        let vendorServiceID = serviceID;
        let variationProviderCode = variation_code;

        if (service) {
            const activeMapping = await ProviderOffer.findOne({ serviceId: service._id, status: true }).sort({ priority: 1 });
            variationProviderCode = activeMapping?.providerCode || service.providerCode || variation_code;
            vendorServiceID = service.identityId?.providerCode || serviceID;
        }

        const provider = service?.provider || 'VTPass';

        const parsedQuantity = quantity ? Number(quantity) : 1;
        const totalAmount = amount * parsedQuantity;

        const result = await purchaseService.processPurchase(userId, {
            type: 'pin',
            serviceId: variation_code || serviceID,
            amount: totalAmount,
            pin,
            provider,
            expectedPrice,
            details: { request_id: generateVTPassRequestId(), serviceID, variation_code, quantity, phone, billersCode, roles: req.user.roles },
            providerCall: (refId, resolvedCost) => providerService.purchaseExamPin({
                request_id: refId,
                serviceID: vendorServiceID,
                variation_code: service?.providerCode || variation_code,
                amount: resolvedCost || (service?.costPrice || service?.price || amount) * parsedQuantity,
                quantity,
                phone,
                billersCode
            }, provider)
        })

        if (!result.success) {
            return sendResponse(res, { status: 400, success: false, message: result.message || 'Service provider currently unavailable', error: result.error })
        }

        // Special handling for PIN storage
        await Pin.create({
            userId,
            service: variation_code,
            code: result.data.token,
            refId: result.data.transactionId,
            status: 'delivered'
        })

        await notificationService.sendInApp(userId, {
            title: 'Exam PIN Purchased',
            message: `Verification PIN for ${variation_code} purchased successfully. PIN: ${result.data.token}`,
            type: 'transaction',
            metadata: { type: 'pin', service: variation_code, token: result.data.token }
        });

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

        const result = await providerService.queryTransaction(localTx.refId || refId)
        return sendResponse(res, { success: true, data: result })
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