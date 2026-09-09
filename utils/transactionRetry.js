const axios = require('axios')
const Transaction = require('../models/Transaction')
const TransactionStatus = require('../models/TransactionStatus')
const { sendAirtimeRequest, sendDataPurchase, sendCableRecharge } = require('./vtuService')
const Wallet = require('../models/Wallet')

const retryTransaction = async refId => {
    const transactionStatus = await TransactionStatus.findOne({ refId })

    if (!transactionStatus || transactionStatus.status !== 'failed') {
        return { message: 'No failed transaction found or already processed.' }
    }

    if (transactionStatus.retries >= 5) {
        return { message: 'Max retries reached. Transaction failed permanently.' }
    }

    const { type, refId, retries } = transactionStatus

    // Retrieve original Transaction to obtain the fulfilling provider
    const originalTx = await Transaction.findOne({
        $or: [{ refId }, { transactionId: refId }]
    });
    const provider = originalTx?.provider || (transactionStatus.provider !== 'paystack' ? transactionStatus.provider : undefined);

    let response

    // Retry logic based on transaction type with fulfilling provider
    if (type === 'airtime') {
        response = await sendAirtimeRequest({ refId }, provider)
    } else if (type === 'data') {
        response = await sendDataPurchase({ refId }, provider)
    } else if (type === 'cable') {
        response = await sendCableRecharge({ refId }, provider)
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

async function retryFunding(refId) {
    const secret = process.env.PAYSTACK_SECRET_KEY
    const base = process.env.PAYSTACK_BASE_URL
    const txs = await TransactionStatus.findOne({ refId })
    if (!txs || txs.status !== 'failed') return

    const verify = await axios.get(`${base}/transaction/verify/${refId}`, {
        headers: { Authorization: `Bearer ${secret}` }
    })

    if (verify.data?.data?.status === 'success') {
        await TransactionStatus.updateOne({ refId }, { $set: { status: 'success' }, $inc: { retries: 1 } })
        const userId = verify.data.data.metadata?.userId
        if (userId) {
            const amount = verify.data.data.amount / 100
            const walletService = require('../services/wallet.service')
            await walletService.credit(userId, amount, refId, 'funding_retry')
        }
    } else {
        await TransactionStatus.updateOne({ refId }, { $set: { status: 'failed' }, $inc: { retries: 1 } })
    }
}

module.exports = { retryTransaction, retryFunding }