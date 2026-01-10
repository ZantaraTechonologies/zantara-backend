const Wallet = require('../models/Wallet')
const Pin = require('../models/Pin')
const { logTransaction } = require('../utils/transaction')
const request_id = require('../utils/generateID')
const {
    sendAirtimeRequest,
    sendDataPurchase,
    fetchPlans,
    verifyMeterWithProvider,
    payBillToProvider,
    queryTransaction,
    sendCableRecharge,
    fetchExamPin
} = require('../utils/vtuService')
const { processReferralBonus } = require('../utils/referral')
const { calculateServicePrice } = require('../utils/pricing')

const purchaseAirtime = async (req, res) => {
    const { network, phone, amount } = req.body
    const userId = req.user.id

    if (!network || !phone || !amount) {
        return res.status(400).json({ message: 'Missing required fields' })
    }

    try {
        const wallet = await Wallet.findOne({ userId })
        const finalAmount = await calculateServicePrice(req.user.roles, amount);

        if (!wallet || wallet.balance < finalAmount) {
            return res.status(400).json({ message: 'Insufficient wallet balance' })
        }

        // 1. Call VTU API provider
        const vtuResponse = await sendAirtimeRequest({ request_id, network, phone, amount })

        if (vtuResponse.status !== 'success') {
            await logTransaction({
                userId, refId: request_id, type: 'airtime', service: network, amount, status: 'failed', response: vtuResponse
            })
            return res.status(500).json({ message: 'VTU provider failed', error: vtuResponse })
        }

        // 2. Debit wallet
        wallet.balance -= finalAmount
        await wallet.save()

        // 3. Log transaction
        await logTransaction({
            userId,
            refId: vtuResponse.ref || vtuResponse.reference || vtuResponse.requestId || request_id,
            type: 'airtime',
            service: network,
            amount,
            status: 'success',
            response: vtuResponse
        })


        // 4. Referral Bonus
        processReferralBonus(userId, amount, vtuResponse.ref || vtuResponse.reference || vtuResponse.requestId || request_id)

        res.status(200).json({ message: 'Airtime sent successfully', data: vtuResponse })

    } catch (err) {
        console.error(err)
        await logTransaction({
            userId, refId: 'ERR-' + Date.now(), type: 'airtime', service: network, amount, status: 'failed', response: { error: err.message }
        })
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
        const wallet = await Wallet.findOne({ userId })
        const finalAmount = await calculateServicePrice(req.user.roles, amount);

        if (!wallet || wallet.balance < finalAmount) {
            return res.status(400).json({ message: 'Insufficient wallet balance' })
        }

        // VTU API call
        const vtuResponse = await sendDataPurchase({ request_id, serviceID, billersCode, variation_code, phone })

        if (vtuResponse.status !== 'success') {
            await logTransaction({
                userId, refId: request_id, type: 'data', service: serviceID, amount, status: 'failed', response: vtuResponse
            })
            return res.status(502).json({ message: 'VTU provider failed', error: vtuResponse })
        }

        wallet.balance -= finalAmount;
        await wallet.save();

        await logTransaction({
            userId,
            refId: vtuResponse.ref || vtuResponse.reference || 'N/A',
            type: 'data',
            service: serviceID,
            amount,
            status: 'success',
            response: vtuResponse
        })

        processReferralBonus(userId, amount, vtuResponse.ref || vtuResponse.reference || 'N/A')

        res.status(200).json({ message: 'Data purchase successful', data: vtuResponse })
    } catch (err) {
        console.error('Data purchase error:', err)
        await logTransaction({
            userId, refId: 'ERR-' + Date.now(), type: 'data', service: serviceID, amount, status: 'failed', response: { error: err.message }
        })
        res.status(500).json({ message: 'Server error', error: err.message })
    }
}

const getPlans = async (req, res) => {
    const { network } = req.params

    try {
        const plans = await fetchPlans(network)
        res.status(200).json({ success: true, plans })
    } catch (err) {
        res.status(500).json({ message: 'Error fetching plans', error: err.message })
    }
}

const verifyMeter = async (req, res) => {
    const { meter_number, serviceID, meter_type } = req.body

    try {
        const result = await verifyMeterWithProvider({ meter_number, serviceID, meter_type })
        res.status(200).json({ success: true, data: result })
    } catch (err) {
        res.status(500).json({ success: false, message: 'Verification failed', error: err.message })
    }
}

const payElectricityBill = async (req, res) => {
    const { serviceID, meter_number, meter_type, amount, phone } = req.body
    const userId = req.user.id

    if (!serviceID || !meter_number || !meter_type || !amount || !phone) {
        return res.status(400).json({ message: 'Missing required fields' })
    }

    try {
        const wallet = await Wallet.findOne({ userId })
        const finalAmount = await calculateServicePrice(req.user.roles, amount);

        if (!wallet || wallet.balance < finalAmount) {
            return res.status(400).json({ message: 'Insufficient wallet balance' })
        }

        const vtuResponse = await payBillToProvider({ request_id, serviceID, meter_number, meter_type, amount, phone })

        if (vtuResponse.status !== 'success') {
            await logTransaction({
                userId, refId: request_id, type: 'electricity', service: serviceID, amount, status: 'failed', response: vtuResponse
            })
            return res.status(502).json({ message: 'VTU provider failed', error: vtuResponse })
        }

        wallet.balance -= finalAmount;
        await wallet.save();

        await logTransaction({
            userId,
            refId: vtuResponse.ref || vtuResponse.reference || 'N/A',
            type: 'electricity',
            service: serviceID,
            amount,
            status: 'success',
            response: vtuResponse
        })

        processReferralBonus(userId, amount, vtuResponse.ref || vtuResponse.reference || 'N/A')

        res.status(200).json({ message: 'Electricity bill paid successfully', data: vtuResponse })

    } catch (err) {
        res.status(500).json({ message: 'Server error', error: err.message })
    }
}

const checkTransaction = async (req, res) => {
    const { request_id } = req.body

    if (!request_id) {
        return res.status(400).json({ message: 'Missing required fields' })
    }

    try {
        const response = await queryTransaction(request_id)

        res.status(200).json({ success: true, data: response })
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
        const wallet = await Wallet.findOne({ userId })
        const finalAmount = await calculateServicePrice(req.user.roles, amount);

        if (!wallet || wallet.balance < finalAmount) {
            return res.status(400).json({ message: 'Insufficient wallet balance' })
        }

        const response = await sendCableRecharge({ request_id, serviceID, billersCode, variation_code, amount })

        if (response.status !== 'success') {
            await logTransaction({
                userId, refId: request_id, type: 'cable', service: serviceID, amount, status: 'failed', response
            })
            return res.status(502).json({ message: 'Recharge failed', error: response })
        }

        wallet.balance -= finalAmount
        await wallet.save()

        await logTransaction({
            userId,
            refId: response.ref || response.reference || 'N/A',
            type: 'cable',
            service: serviceID,
            amount,
            status: 'success',
            response
        })

        processReferralBonus(userId, amount, response.ref || response.reference || 'N/A')

        res.status(200).json({ message: 'Cable subscription successful', data: response })

    } catch (err) {
        res.status(500).json({ message: 'Server error', error: err.message })
    }
}

const purchaseExamPin = async (req, res) => {
    const { variation_code, amount, quantity, phone } = req.body
    const service = variation_code // For logging purposes
    const userId = req.user.id

    try {
        const wallet = await Wallet.findOne({ userId })
        const finalAmount = await calculateServicePrice(req.user.roles, amount);

        if (!wallet || wallet.balance < finalAmount) {
            return res.status(400).json({ message: 'Insufficient balance' })
        }

        const response = await fetchExamPin({ request_id, variation_code, amount, quantity, phone })

        if (!response.success || !response.pin) {
            await logTransaction({
                userId, refId: request_id, type: 'pin', service, amount, status: 'failed', response
            })
            return res.status(502).json({ message: 'PIN purchase failed', error: response })
        }

        wallet.balance -= finalAmount
        await wallet.save()

        await Pin.create({
            userId,
            service,
            code: response.pin,
            refId: response.ref,
            status: 'delivered'
        })

        await logTransaction({
            userId,
            refId: response.ref,
            type: 'pin',
            service,
            amount,
            status: 'success',
            response
        })

        processReferralBonus(userId, amount, response.ref)

        res.status(200).json({
            message: 'PIN purchased successfully',
            pin: response.pin
        })

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