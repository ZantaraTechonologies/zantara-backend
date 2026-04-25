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
const mongoose = require('mongoose')

const purchaseAirtime = async (req, res) => {

    const { network, serviceID, phone, billersCode, amount, pin, expectedPrice } = req.body
    const finalNetwork = network || serviceID;
    const finalPhone = phone || billersCode;
    const userId = req.user.id

    if (!finalNetwork || !finalPhone || !amount || !pin) {

        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        let service = await Service.findOne({ code: finalNetwork, category: 'airtime' }).populate('identityId');
        
        // Fallback: If not found by code, check if finalNetwork is a ServiceIdentity slug
        if (!service) {
            const ServiceIdentity = require('../models/ServiceIdentity');
            const identity = await ServiceIdentity.findOne({ slug: String(finalNetwork).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id }).populate('identityId');
            }
        }

        const provider = service?.provider || 'VTPass';
        const vendorCode = service?.identityId?.providerCode || service?.providerCode || finalNetwork;

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

    const userId = req.user.id

    if (!finalServiceID || !variation_code || !finalPhone || amount === undefined || !pin) {
        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        // Lookup the service to get provider and providerCode
        const service = await Service.findOne({ code: variation_code, category: 'data' }).populate('identityId');
        const provider = service?.provider || 'VTPass';
        
        // vendorServiceID should be the network code (e.g. mtn-data), variation_code should be the plan code (e.g. mtn-100mb-1000)
        const vendorServiceID = service?.identityId?.providerCode || finalServiceID; 
        const variationProviderCode = service?.providerCode || variation_code;

        const result = await purchaseService.processPurchase(userId, {
            type: 'data',
            serviceId: variation_code,
            amount,
            pin,
            provider,
            expectedPrice,
            details: { phone: finalPhone, serviceID: finalServiceID, variation_code, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseData({ 
                request_id: refId, 
                serviceID: vendorServiceID, 
                billersCode: finalBillersCode, 
                variation_code: variationProviderCode, 
                phone: finalPhone, 
                amount 
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
        // ServiceIdentity is linked to ServiceType via typeId
        const typeDoc = await ServiceType.findOne({ slug: category.toLowerCase(), status: true });
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
            let displayPrice = p.price;
            
            // If price is 0, try to find a provider offer cost as fallback
            if (displayPrice === 0) {
                const bestOffer = await ProviderOffer.findOne({ serviceId: p._id, status: true }).sort({ priority: -1 });
                if (bestOffer) {
                    displayPrice = bestOffer.costPrice;
                }
            }

            return {
                variation_code: p.code,
                name: p.name,
                variation_amount: displayPrice || 0,
                fixedPrice: displayPrice > 0 ? "Yes" : "No"
            };
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
        // Lookup service to identify provider
        let service = await Service.findOne({ code: serviceID });
        
        // Fallback: Check if serviceID is an identity slug
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

    const userId = req.user.id

    if (!finalServiceID || !finalMeterNumber || !finalMeterType || !amount || !finalPhone || !pin) {
        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        // Lookup the service to get provider and providerCode
        let service = await Service.findOne({ code: finalServiceID, category: 'electricity' }).populate('identityId');

        // Fallback
        if (!service) {
            const ServiceIdentity = require('../models/ServiceIdentity');
            const identity = await ServiceIdentity.findOne({ slug: String(finalServiceID).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id }).populate('identityId');
            }
        }

        const provider = service?.provider || 'VTPass';
        const vendorServiceID = service?.identityId?.providerCode || service?.providerCode || finalServiceID;

        const result = await purchaseService.processPurchase(userId, {
            type: 'electricity',
            serviceId: finalServiceID,
            amount,
            pin,
            provider,
            expectedPrice,
            details: { request_id: generateVTPassRequestId(), meter_number: finalMeterNumber, meter_type: finalMeterType, phone: finalPhone, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseElectricity({ 
                request_id: refId, 
                serviceID: vendorServiceID, 
                billersCode: finalMeterNumber, 
                variation_code: finalMeterType, 
                amount, 
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

    const userId = req.user.id

    if (!finalServiceID || !finalBillersCode || !variation_code || !amount || !pin) {
        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        // Lookup the service to get provider and providerCode using the variation_code (package code)
        let service = await Service.findOne({ code: variation_code, category: 'tv' }).populate('identityId');

        // Fallback
        if (!service) {
            const ServiceIdentity = require('../models/ServiceIdentity');
            const identity = await ServiceIdentity.findOne({ slug: String(finalServiceID).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id }).populate('identityId');
            }
        }

        const provider = service?.provider || 'VTPass';
        const vendorServiceID = service?.identityId?.providerCode || finalServiceID;
        const variationProviderCode = service?.providerCode || variation_code;

        const result = await purchaseService.processPurchase(userId, {
            type: 'cable',
            serviceId: variation_code, // Use the package code for exact pricing lookup
            amount,
            pin,
            provider,
            expectedPrice,
            details: { request_id: generateVTPassRequestId(), serviceID: finalServiceID, billersCode: finalBillersCode, variation_code, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseCable({ 
                request_id: refId, 
                serviceID: vendorServiceID, 
                billersCode: finalBillersCode, 
                variation_code: variationProviderCode, 
                amount, 
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
    const userId = req.user.id

    if (!pin) {
        return sendResponse(res, { status: 400, success: false, message: 'PIN is required' })
    }

    try {
        // Lookup the service to get provider and providerCode
        let service = await Service.findOne({ code: variation_code || serviceID, category: 'pin' }).populate('identityId');

        // Fallback
        if (!service) {
            const ServiceIdentity = require('../models/ServiceIdentity');
            const identity = await ServiceIdentity.findOne({ slug: String(serviceID || variation_code).toLowerCase() });
            if (identity) {
                service = await Service.findOne({ identityId: identity._id }).populate('identityId');
            }
        }

        const provider = service?.provider || 'VTPass';
        const vendorServiceID = service?.identityId?.providerCode || service?.providerCode || serviceID;

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
            providerCall: (refId) => providerService.purchaseExamPin({ 
                request_id: refId, 
                serviceID: vendorServiceID, 
                variation_code: service?.providerCode || variation_code, 
                amount: totalAmount, 
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