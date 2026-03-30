const purchaseService = require('../services/purchase.service')
const providerService = require('../services/provider.service')
const Wallet = require('../models/Wallet')
const Pin = require('../models/Pin')
const Transaction = require('../models/Transaction')
const request_id = require('../utils/generateID')
const { fetchPlans, verifyMeterWithProvider } = require('../utils/vtuService')
const { sendResponse } = require('../utils/response')

const purchaseAirtime = async (req, res) => {
    console.log('[Controller: purchaseAirtime] -> START | Body:', req.body);
    const { network, serviceID, phone, billersCode, amount, pin } = req.body
    const finalNetwork = network || serviceID;
    const finalPhone = phone || billersCode;
    const userId = req.user.id

    console.log('[Controller: purchaseAirtime] -> Parsed finalNetwork:', finalNetwork, 'finalPhone:', finalPhone, 'userId:', userId);

    if (!finalNetwork || !finalPhone || !amount || !pin) {
        console.log('[Controller: purchaseAirtime] -> Missing required fields');
        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        console.log('[Controller: purchaseAirtime] -> Calling purchaseService.processPurchase');
        const result = await purchaseService.processPurchase(userId, {
            type: 'airtime',
            serviceId: finalNetwork,
            amount,
            pin,
            details: { phone: finalPhone, network: finalNetwork, roles: req.user.roles },
            providerCall: (refId) => {
                console.log('[Controller: purchaseAirtime] -> Inside providerCall callback with refId:', refId);
                return providerService.purchaseAirtime({ request_id: refId, serviceID: finalNetwork, phone: finalPhone, amount })
            }
        })

        console.log('[Controller: purchaseAirtime] -> purchaseService returned result:', JSON.stringify(result));

        if (!result.success) {
            console.log('[Controller: purchaseAirtime] -> Service returned false success');
            return sendResponse(res, { status: 400, success: false, message: result.message, error: result.error })
        }
        
        console.log('[Controller: purchaseAirtime] -> Sending final success response');
        return sendResponse(res, { message: 'Airtime sent successfully', data: result.data })
    } catch (err) {
        console.error('[Controller: purchaseAirtime] -> CATCH BLOCK HIT ERROR:', err);
        console.error('[Controller: purchaseAirtime] -> STACK:', err?.stack);
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
        pin 
    } = req.body
    
    // Support both formats (mobile vs older backend)
    const finalServiceID = serviceID || network;
    const finalBillersCode = billersCode || phone;
    const finalPhone = phone || billersCode;
    const amount = reqAmount; // Must be passed from frontend now

    const userId = req.user.id

    if (!finalServiceID || !finalBillersCode || !variation_code || !finalPhone || !amount || !pin) {
        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        const result = await purchaseService.processPurchase(userId, {
            type: 'data',
            serviceId: finalServiceID,
            amount,
            pin,
            details: { phone: finalPhone, serviceID: finalServiceID, variation_code, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseData({ request_id: refId, serviceID: finalServiceID, billersCode: finalBillersCode, variation_code, phone: finalPhone, amount })
        })

        if (!result.success) {
            return sendResponse(res, { status: 502, success: false, message: result.message, error: result.error })
        }
        return sendResponse(res, { message: 'Data purchase successful', data: result.data })
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message || 'Server error', error: err })
    }
}

const getPlans = async (req, res) => {
    try {
        const { network } = req.params;
        if (!network) return sendResponse(res, { status: 400, success: false, message: 'Network parameter required' });
        const plans = await fetchPlans(network);
        return sendResponse(res, { data: plans });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: 'Error fetching plans', error: err });
    }
}

const verifyMeter = async (req, res) => {
    try {
        const { billersCode, serviceID, type } = req.body;
        const result = await verifyMeterWithProvider({ billersCode, serviceID, type });
        return sendResponse(res, { data: result });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: 'Meter verification failed', error: err });
    }
}

const payElectricityBill = async (req, res) => {
    const { serviceID, network, meter_number, billersCode, meter_type, variation_code, amount, phone, pin } = req.body
    const finalServiceID = serviceID || network;
    const finalMeterNumber = meter_number || billersCode;
    const finalMeterType = meter_type || variation_code;
    const finalPhone = phone || finalMeterNumber;

    const userId = req.user.id

    if (!finalServiceID || !finalMeterNumber || !finalMeterType || !amount || !finalPhone || !pin) {
        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        const result = await purchaseService.processPurchase(userId, {
            type: 'electricity',
            serviceId: finalServiceID,
            amount,
            pin,
            details: { meter_number: finalMeterNumber, meter_type: finalMeterType, phone: finalPhone, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseElectricity({ request_id: refId, serviceID: finalServiceID, billersCode: finalMeterNumber, variation_code: finalMeterType, amount, phone: finalPhone })
        })

        if (!result.success) {
            return sendResponse(res, { status: 502, success: false, message: result.message, error: result.error })
        }
        return sendResponse(res, { message: 'Electricity bill paid successfully', data: result.data })
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message || 'Server error', error: err })
    }
}

const rechargeCable = async (req, res) => {
    const { serviceID, network, billersCode, phone, variation_code, amount, pin } = req.body
    const finalServiceID = serviceID || network;
    const finalBillersCode = billersCode || phone;
    const finalPhone = phone || finalBillersCode;

    const userId = req.user.id

    if (!finalServiceID || !finalBillersCode || !variation_code || !amount || !pin) {
        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        const result = await purchaseService.processPurchase(userId, {
            type: 'cable',
            serviceId: finalServiceID,
            amount,
            pin,
            details: { serviceID: finalServiceID, billersCode: finalBillersCode, variation_code, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseCable({ request_id: refId, serviceID: finalServiceID, billersCode: finalBillersCode, variation_code, amount, phone: finalPhone })
        })

        if (!result.success) {
            return sendResponse(res, { status: 502, success: false, message: result.message, error: result.error })
        }
        return sendResponse(res, { message: 'Cable subscription successful', data: result.data })
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message || 'Server error', error: err })
    }
}

const purchaseExamPin = async (req, res) => {
    const { variation_code, amount, quantity, phone, pin } = req.body
    const userId = req.user.id

    if (!pin) {
        return sendResponse(res, { status: 400, success: false, message: 'PIN is required' })
    }

    try {
        const result = await purchaseService.processPurchase(userId, {
            type: 'pin',
            serviceId: variation_code,
            amount,
            pin,
            details: { variation_code, quantity, phone, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseExamPin({ request_id: refId, variation_code, amount, quantity, phone })
        })

        if (!result.success) {
            return sendResponse(res, { status: 502, success: false, message: result.message, error: result.error })
        }

        // Special handling for PIN storage
        await Pin.create({
            userId,
            service: variation_code,
            code: result.data.token,
            refId: result.data.transactionId,
            status: 'delivered'
        })

        return sendResponse(res, { message: 'PIN purchased successfully', data: { pin: result.data.token } })
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
    getPlans,
    payElectricityBill,
    verifyMeter,
    checkTransaction,
    rechargeCable,
    purchaseExamPin,
    getPurchasedPins
}