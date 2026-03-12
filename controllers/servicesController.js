const purchaseService = require('../services/purchase.service')
const providerService = require('../services/provider.service')
const Wallet = require('../models/Wallet')
const Pin = require('../models/Pin')
const request_id = require('../utils/generateID')
const { fetchPlans, verifyMeterWithProvider } = require('../utils/vtuService')

const purchaseAirtime = async (req, res) => {
    const { network, phone, amount } = req.body
    const userId = req.user.id

    if (!network || !phone || !amount) {
        return res.status(400).json({ message: 'Missing required fields' })
    }

    try {
        const result = await purchaseService.processPurchase(userId, {
            type: 'airtime',
            serviceId: network,
            amount,
            details: { phone, network, request_id, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseAirtime({ request_id: refId, serviceID: network, phone, amount })
        })

        if (!result.success) return res.status(500).json({ message: result.message, error: result.error })
        res.status(200).json({ message: 'Airtime sent successfully', data: result.data })
    } catch (err) {
        res.status(500).json({ message: 'Server error', error: err.message })
    }
}

const purchaseData = async (req, res) => {
    const { serviceID, billersCode, variation_code, phone, amount } = req.body
    const userId = req.user.id

    if (!serviceID || !billersCode || !variation_code || !phone || !amount) {
        return res.status(400).json({ message: 'Missing required fields' })
    }

    try {
        const result = await purchaseService.processPurchase(userId, {
            type: 'data',
            serviceId: serviceID,
            amount,
            details: { phone, serviceID, variation_code, request_id, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseData({ request_id: refId, serviceID, billersCode, variation_code, phone })
        })

        if (!result.success) return res.status(502).json({ message: result.message, error: result.error })
        res.status(200).json({ message: 'Data purchase successful', data: result.data })
    } catch (err) {
        res.status(500).json({ message: 'Server error', error: err.message })
    }
}

const getPlans = async (req, res) => {
    try {
        const { network } = req.query;
        if (!network) return res.status(400).json({ message: 'Network query required' });
        const plans = await fetchPlans(network);
        res.status(200).json(plans);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching plans', error: err.message });
    }
}

const verifyMeter = async (req, res) => {
    try {
        const { billersCode, serviceID, type } = req.body;
        const result = await verifyMeterWithProvider({ billersCode, serviceID, type });
        res.status(200).json(result);
    } catch (err) {
        res.status(500).json({ message: 'Meter verification failed', error: err.message });
    }
}

const payElectricityBill = async (req, res) => {
    const { serviceID, meter_number, meter_type, amount, phone } = req.body
    const userId = req.user.id

    if (!serviceID || !meter_number || !meter_type || !amount || !phone) {
        return res.status(400).json({ message: 'Missing required fields' })
    }

    try {
        const result = await purchaseService.processPurchase(userId, {
            type: 'electricity',
            serviceId: serviceID,
            amount,
            details: { meter_number, meter_type, phone, request_id, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseElectricity({ request_id: refId, serviceID, billersCode: meter_number, variation_code: meter_type, amount, phone })
        })

        if (!result.success) return res.status(502).json({ message: result.message, error: result.error })
        res.status(200).json({ message: 'Electricity bill paid successfully', data: result.data })
    } catch (err) {
        res.status(500).json({ message: 'Server error', error: err.message })
    }
}

const rechargeCable = async (req, res) => {
    const { serviceID, billersCode, variation_code, amount } = req.body
    const userId = req.user.id

    if (!serviceID || !billersCode || !variation_code || !amount) {
        return res.status(400).json({ message: 'Missing required fields' })
    }

    try {
        const result = await purchaseService.processPurchase(userId, {
            type: 'cable',
            serviceId: serviceID,
            amount,
            details: { serviceID, billersCode, variation_code, request_id, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseCable({ request_id: refId, serviceID, billersCode, variation_code, amount })
        })

        if (!result.success) return res.status(502).json({ message: result.message, error: result.error })
        res.status(200).json({ message: 'Cable subscription successful', data: result.data })
    } catch (err) {
        res.status(500).json({ message: 'Server error', error: err.message })
    }
}

const purchaseExamPin = async (req, res) => {
    const { variation_code, amount, quantity, phone } = req.body
    const userId = req.user.id

    try {
        const result = await purchaseService.processPurchase(userId, {
            type: 'pin',
            serviceId: variation_code,
            amount,
            details: { variation_code, quantity, phone, request_id, roles: req.user.roles },
            providerCall: (refId) => providerService.purchaseExamPin({ request_id: refId, variation_code, amount, quantity, phone })
        })

        if (!result.success) return res.status(502).json({ message: result.message, error: result.error })

        // Special handling for PIN storage
        await Pin.create({
            userId,
            service: variation_code,
            code: result.data.pin,
            refId: result.data.ref,
            status: 'delivered'
        })

        res.status(200).json({ message: 'PIN purchased successfully', pin: result.data.pin })
    } catch (err) {
        res.status(500).json({ message: 'Server error', error: err.message })
    }
}

const getPurchasedPins = async (req, res) => {
    const pins = await Pin.find({ userId: req.user._id }).sort({ createdAt: -1 })
    res.json({ pins })
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