const purchaseService = require('../services/purchase.service')
const providerService = require('../services/provider.service')
const Wallet = require('../models/Wallet')
const Pin = require('../models/Pin')
const Transaction = require('../models/Transaction')
const request_id = require('../utils/generateID')
const { fetchPlans, verifyMeterWithProvider } = require('../utils/vtuService')
const { sendResponse } = require('../utils/response')

const purchaseAirtime = async (req, res) => {
    const { network, serviceID, phone, billersCode, amount, pin } = req.body
    const finalNetwork = network || serviceID;
    const finalPhone = phone || billersCode;
    const userId = req.user.id

    if (!finalNetwork || !finalPhone || !amount || !pin) {
        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' })
    }

    try {
        const result = await purchaseService.processPurchase(userId, {
            type: 'airtime',
            serviceId: network,
            amount,
            pin,
            details: { phone, network, request_id: request_id.requestId, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseAirtime({ request_id: refId, serviceID: network, phone, amount })
        })

        if (!result.success) {
            return sendResponse(res, { status: 500, success: false, message: result.message, error: result.error })
        }
        return sendResponse(res, { message: 'Airtime sent successfully', data: result.data })
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message || 'Server error', error: err })
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
            serviceId: serviceID,
            amount,
            pin,
            details: { phone, serviceID, variation_code, request_id: request_id.requestId, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseData({ request_id: refId, serviceID, billersCode, variation_code, phone })
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
            serviceId: serviceID,
            amount,
            pin,
            details: { meter_number, meter_type, phone, request_id: request_id.requestId, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseElectricity({ request_id: refId, serviceID, billersCode: meter_number, variation_code: meter_type, amount, phone })
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
            serviceId: serviceID,
            amount,
            pin,
            details: { serviceID, billersCode, variation_code, request_id: request_id.requestId, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseCable({ request_id: refId, serviceID, billersCode, variation_code, amount })
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
            details: { variation_code, quantity, phone, request_id: request_id.requestId, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseExamPin({ request_id: refId, variation_code, amount, quantity, phone })
        })

        if (!result.success) {
            return sendResponse(res, { status: 502, success: false, message: result.message, error: result.error })
        }

        // Special handling for PIN storage
        await Pin.create({
            userId,
            service: variation_code,
            code: result.data.pin,
            refId: result.data.ref,
            status: 'delivered'
        })

        return sendResponse(res, { message: 'PIN purchased successfully', data: { pin: result.data.pin } })
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