const TransactionStatus = require('../models/TransactionStatus')
const { sendAirtimeRequest, sendDataPurchase, sendCableRecharge } = require('./vtuService')

const retryTransaction = async refId => {
    const transactionStatus = await TransactionStatus.findOne({ refId })

    if (!transactionStatus || transactionStatus.status !== 'failed') {
        return { message: 'No failed transaction found or already processed.' }
    }

    if (transactionStatus.retries >= 5) {
        return { message: 'Max retries reached. Transaction failed permanently.' }
    }

    const { type, refId, retries } = transactionStatus

    let response

    // Retry logic based on transaction type
    if (type === 'airtime') {
        response = await sendAirtimeRequest({ refId })
    } else if (type === 'data') {
        response = await sendDataPurchase({ refId })
    } else if (type === 'cable') {
        response = await sendCableRecharge({ refId })
    }

    if (response.status === 'success') {
        transactionStatus.status = 'success'
        transactionStatus.retries = retries + 1
        transactionStatus.errorMessage = ''
    } else {
        transactionStatus.status = 'failed'
        transactionStatus.retries = retries + 1
        transactionStatus.errorMessage = response.error || 'Unknown error'
    }

    await transactionStatus.save()

    return response
}

module.exports = { retryTransaction }