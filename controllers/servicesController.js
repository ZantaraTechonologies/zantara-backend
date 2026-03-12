const walletService = require('../services/wallet.service')
const refundService = require('../services/refund.service')
const Transaction = require('../models/Transaction')
const Wallet = require('../models/Wallet')
const Pin = require('../models/Pin')
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

    let transaction;
    try {
        const wallet = await Wallet.findOne({ userId })
        const finalAmount = await calculateServicePrice(req.user.roles, amount);

        if (!wallet || wallet.balance < finalAmount) {
            return res.status(400).json({ message: 'Insufficient wallet balance' })
        }

        // 1. Create PENDING Transaction Record
        transaction = await Transaction.create({
            userId,
            refId: request_id,
            type: 'airtime',
            service: network,
            amount: finalAmount,
            status: 'pending',
            details: { phone, network, originalAmount: amount }
        })

        // 2. Debit Wallet FIRST (with Ledger entry)
        await walletService.debit(userId, finalAmount, request_id, 'airtime_purchase', transaction._id)

        // 3. Call VTU API provider
        const vtuResponse = await sendAirtimeRequest({ request_id, network, phone, amount })

        if (vtuResponse.status !== 'success') {
            // 4. Automated Refund if provider fails
            await refundService.processRefund(transaction._id, vtuResponse.message || 'VTU provider failed')
            return res.status(500).json({ message: 'VTU provider failed', error: vtuResponse })
        }

        // 5. Finalize transaction on success
        transaction.status = 'success'
        transaction.response = vtuResponse
        await transaction.save()

        // 6. Referral Bonus
        processReferralBonus(userId, amount, transaction.refId)

        res.status(200).json({ message: 'Airtime sent successfully', data: vtuResponse })

    } catch (err) {
        console.error('Airtime purchase error:', err)
        if (transaction && transaction.status === 'pending') {
            // Attempt refund if we debited but didn't finish
            try {
                await refundService.processRefund(transaction._id, err.message)
            } catch (refundErr) {
                console.error('CRITICAL: Refund failed after error:', refundErr.message)
            }
        }
        res.status(500).json({ message: 'Server error', error: err.message })
    }
}

const purchaseData = async (req, res) => {
    const { serviceID, billersCode, variation_code, phone, amount } = req.body
    const userId = req.user.id

    if (!serviceID || !billersCode || !variation_code || !phone || !amount) {
        return res.status(400).json({ message: 'Missing required fields' })
    }

    let transaction;
    try {
        const wallet = await Wallet.findOne({ userId })
        const finalAmount = await calculateServicePrice(req.user.roles, amount);

        if (!wallet || wallet.balance < finalAmount) {
            return res.status(400).json({ message: 'Insufficient wallet balance' })
        }

        // 1. Create PENDING Transaction Record
        transaction = await Transaction.create({
            userId,
            refId: request_id,
            type: 'data',
            service: serviceID,
            amount: finalAmount,
            status: 'pending',
            details: { phone, serviceID, variation_code, originalAmount: amount }
        })

        // 2. Debit Wallet FIRST (with Ledger entry)
        await walletService.debit(userId, finalAmount, request_id, 'data_purchase', transaction._id)

        // 3. VTU API call
        const vtuResponse = await sendDataPurchase({ request_id, serviceID, billersCode, variation_code, phone })

        if (vtuResponse.status !== 'success') {
            // 4. Automated Refund if provider fails
            await refundService.processRefund(transaction._id, vtuResponse.message || 'VTU provider failed')
            return res.status(502).json({ message: 'VTU provider failed', error: vtuResponse })
        }

        // 5. Finalize transaction on success
        transaction.status = 'success'
        transaction.response = vtuResponse
        await transaction.save()

        // 6. Referral Bonus
        processReferralBonus(userId, amount, transaction.refId)

        res.status(200).json({ message: 'Data purchase successful', data: vtuResponse })
    } catch (err) {
        console.error('Data purchase error:', err)
        if (transaction && transaction.status === 'pending') {
            try {
                await refundService.processRefund(transaction._id, err.message)
            } catch (refundErr) {
                console.error('CRITICAL: Refund failed after error:', refundErr.message)
            }
        }
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

    let transaction;
    try {
        const wallet = await Wallet.findOne({ userId })
        const finalAmount = await calculateServicePrice(req.user.roles, amount);

        if (!wallet || wallet.balance < finalAmount) {
            return res.status(400).json({ message: 'Insufficient wallet balance' })
        }

        // 1. Create PENDING Transaction Record
        transaction = await Transaction.create({
            userId,
            refId: request_id,
            type: 'electricity',
            service: serviceID,
            amount: finalAmount,
            status: 'pending',
            details: { meter_number, meter_type, phone, originalAmount: amount }
        })

        // 2. Debit Wallet FIRST (with Ledger entry)
        await walletService.debit(userId, finalAmount, request_id, 'electricity_purchase', transaction._id)

        // 3. VTU Provider Call
        const vtuResponse = await payBillToProvider({ request_id, serviceID, meter_number, meter_type, amount, phone })

        if (vtuResponse.status !== 'success') {
            // 4. Automated Refund if provider fails
            await refundService.processRefund(transaction._id, vtuResponse.message || 'VTU provider failed')
            return res.status(502).json({ message: 'VTU provider failed', error: vtuResponse })
        }

        // 5. Finalize transaction on success
        transaction.status = 'success'
        transaction.response = vtuResponse
        await transaction.save()

        // 6. Referral Bonus
        processReferralBonus(userId, amount, transaction.refId)

        res.status(200).json({ message: 'Electricity bill paid successfully', data: vtuResponse })

    } catch (err) {
        console.error('Electricity bill error:', err)
        if (transaction && transaction.status === 'pending') {
            try {
                await refundService.processRefund(transaction._id, err.message)
            } catch (refundErr) {
                console.error('CRITICAL: Refund failed after error:', refundErr.message)
            }
        }
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

    let transaction;
    try {
        const wallet = await Wallet.findOne({ userId })
        const finalAmount = await calculateServicePrice(req.user.roles, amount);

        if (!wallet || wallet.balance < finalAmount) {
            return res.status(400).json({ message: 'Insufficient wallet balance' })
        }

        // 1. Create PENDING Transaction Record
        transaction = await Transaction.create({
            userId,
            refId: request_id,
            type: 'cable',
            service: serviceID,
            amount: finalAmount,
            status: 'pending',
            details: { serviceID, billersCode, variation_code, originalAmount: amount }
        })

        // 2. Debit Wallet FIRST (with Ledger entry)
        await walletService.debit(userId, finalAmount, request_id, 'cable_subscription', transaction._id)

        // 3. VTU Provider Call
        const response = await sendCableRecharge({ request_id, serviceID, billersCode, variation_code, amount })

        if (response.status !== 'success') {
            // 4. Automated Refund if provider fails
            await refundService.processRefund(transaction._id, response.message || 'VTU provider failed')
            return res.status(502).json({ message: 'Recharge failed', error: response })
        }

        // 5. Finalize transaction on success
        transaction.status = 'success'
        transaction.response = response
        await transaction.save()

        // 6. Referral Bonus
        processReferralBonus(userId, amount, transaction.refId)

        res.status(200).json({ message: 'Cable subscription successful', data: response })

    } catch (err) {
        console.error('Cable recharge error:', err)
        if (transaction && transaction.status === 'pending') {
            try {
                await refundService.processRefund(transaction._id, err.message)
            } catch (refundErr) {
                console.error('CRITICAL: Refund failed after error:', refundErr.message)
            }
        }
        res.status(500).json({ message: 'Server error', error: err.message })
    }
}

const purchaseExamPin = async (req, res) => {
    const { variation_code, amount, quantity, phone } = req.body
    const service = variation_code // For logging purposes
    const userId = req.user.id

    let transaction;
    try {
        const wallet = await Wallet.findOne({ userId })
        const finalAmount = await calculateServicePrice(req.user.roles, amount);

        if (!wallet || wallet.balance < finalAmount) {
            return res.status(400).json({ message: 'Insufficient balance' })
        }

        // 1. Create PENDING Transaction Record
        transaction = await Transaction.create({
            userId,
            refId: request_id,
            type: 'pin',
            service,
            amount: finalAmount,
            status: 'pending',
            details: { variation_code, quantity, phone, originalAmount: amount }
        })

        // 2. Debit Wallet FIRST (with Ledger entry)
        await walletService.debit(userId, finalAmount, request_id, 'pin_purchase', transaction._id)

        // 3. VTU Provider Call
        const response = await fetchExamPin({ request_id, variation_code, amount, quantity, phone })

        if (!response.success || !response.pin) {
            // 4. Automated Refund if provider fails
            await refundService.processRefund(transaction._id, response.message || 'PIN purchase failed')
            return res.status(502).json({ message: 'PIN purchase failed', error: response })
        }

        // 5. Finalize transaction on success
        transaction.status = 'success'
        transaction.response = response
        await transaction.save()

        // 6. Create PIN record
        await Pin.create({
            userId,
            service,
            code: response.pin,
            refId: response.ref,
            status: 'delivered'
        })

        // 7. Referral Bonus
        processReferralBonus(userId, amount, transaction.refId)

        res.status(200).json({
            message: 'PIN purchased successfully',
            pin: response.pin
        })

    } catch (err) {
        console.error('Exam PIN purchase error:', err)
        if (transaction && transaction.status === 'pending') {
            try {
                await refundService.processRefund(transaction._id, err.message)
            } catch (refundErr) {
                console.error('CRITICAL: Refund failed after error:', refundErr.message)
            }
        }
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