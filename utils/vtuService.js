const axios = require('axios')

const sendAirtimeRequest = async ({ request_id, serviceID, phone, amount }) => {
    const VTU_URL = `${process.env.VTU_API_URI}/pay`

    try {
        const res = await axios.post(VTU_URL, {
            auth: {
                username: process.env.VTU_USERNAME,
                password: process.env.VTU_PASSWORD
            }
        },
            {
                request_id,
                serviceID,
                phone,
                amount
            })

        return res.data
    } catch (err) {
        return { status: 'failed', error: err.message }
    }
}

const sendDataPurchase = async ({ request_id, serviceID, billersCode, variation_code, phone }) => {
    const VTU_URL = `${process.env.VTU_API_URI}/pay`

    try {
        const res = await axios.post(VTU_URL, {
            auth: {
                username: process.env.VTU_USERNAME,
                password: process.env.VTU_PASSWORD
            }
        },
            {
                request_id,
                serviceID,
                billersCode,
                variation_code,
                phone
            })

        return res.data
    } catch (err) {
        return { status: 'failed', error: err.message }
    }
}

const fetchPlans = async (network) => {
    const VTU_URL = `${process.env.VTU_API_URI}/service-variations?serviceID=${network}`

    try {
        const res = await axios.get(VTU_URL, {
            auth: {
                username: process.env.VTU_USERNAME,
                password: process.env.VTU_PASSWORD
            }
        })
        return res.data
    } catch (err) {
        return { status: 'failed', error: err.message }
    }
}

const verifyMeterWithProvider = async ({ billersCode, serviceID, type }) => {
    const URL = `${process.env.VTU_API_URI}/merchant-verify`

    try {
        const res = await axios.post(URL, {
            auth: {
                username: process.env.VTU_USERNAME,
                password: process.env.VTU_PASSWORD
            }
        },
            {
                billersCode,
                serviceID,
                type
            })

        return res.data
    } catch (err) {
        return { status: 'failed', error: err.message }
    }
}

const payBillToProvider = async ({ request_id, serviceID, billersCode, variation_code, amount, phone }) => {
    const URL = `${process.env.VTU_API_URI}/pay`

    try {
        const res = await axios.post(URL, {
            auth: {
                username: process.env.VTU_USERNAME,
                password: process.env.VTU_PASSWORD
            }
        },
            {
                request_id,
                serviceID,
                billersCode,
                variation_code,
                amount,
                phone
            })

        return res.data
    } catch (err) {
        return { status: 'failed', error: err.message }
    }
}

const queryTransaction = async request_id => {
    const URL = `${process.env.VTU_API_URI}/requery`

    try {
        const res = await axios.post(URL, {
            auth: {
                username: process.env.VTU_USERNAME,
                password: process.env.VTU_PASSWORD
            }
        },
            { request_id })

        return res.data
    } catch (err) {
        return { status: 'failed', error: err.message }
    }

}

const sendCableRecharge = async ({ request_id, serviceID, billersCode, variation_code, amount }) => {
    const URL = `${process.env.VTU_API_URI}/pay`
    console.log(request_id)

    try {
        const res = await axios.post(URL, {
            auth: {
                username: process.env.VTU_USERNAME,
                password: process.env.VTU_PASSWORD
            }
        },
            {
                request_id,
                serviceID,
                billersCode,
                variation_code,
                amount
            })

        return res.data
    } catch (err) {
        return { status: 'failed', error: err.message }
    }
}

const fetchExamPin = async ({ request_id, variation_code, amount, quantity, phone }) => {

    try {
        const res = await axios.post(`${process.env.VTU_API_URI}/pay`, {
            auth: {
                username: process.env.VTU_USERNAME,
                password: process.env.VTU_PASSWORD
            }
        },
            {
                request_id,
                variation_code,
                amount,
                quantity,
                phone
            })

        return res.data
    } catch (err) {
        return { status: 'failed', error: err.message }
    }
}

const Log = require('../models/Log');

exports.sendAirtimeRequest = async ({ network, phone, amount }) => {
    try {
        const res = await axios.post(API_URL, { network, phone, amount })
        return res.data
    } catch (err) {
        await Log.create({
            level: 'error',
            message: 'Airtime request failed',
            context: { network, phone, amount },
            stackTrace: err.stack,
        })

        // Save failed transaction for retry
        await TransactionStatus.create({
            refId: `airtime-${Date.now()}`,
            type: 'airtime',
            status: 'failed',
            retries: 0,
            errorMessage: err.message,
        })

        return { status: 'failed', error: err.message }
    }
}

module.exports = {
    sendAirtimeRequest,
    sendDataPurchase,
    fetchPlans,
    verifyMeterWithProvider,
    payBillToProvider,
    queryTransaction,
    sendCableRecharge,
    fetchExamPin
}