const crypto = require('crypto')
const axios = require('axios')
const TransactionStatus = require('../models/TransactionStatus')
const Transaction = require('../models/Transaction')
const Wallet = require('../models/Wallet')
const { logTransaction } = require('../utils/transaction')
const { initializePayment } = require('../utils/paystack')

const payment = async (req, res) => {
    try {
        const { amount } = req.body
        const payment = await initializePayment(req.user.email, amount, { userId: req.user.id })
        res.json({ authorization_url: payment.data.authorization_url })
    } catch (err) {
        res.status(500).json({ error: 'Paystack error: ' + err.message })
    }
}

const webhook = async (req, res) => {
    // 1) Signature check (raw body!)
    const secret = process.env.PAYSTACK_SECRET_KEY
    const signature = req.headers['x-paystack-signature']
    const hash = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex')
    if (hash !== signature) return res.status(401).send('Unauthorized')

    // 2) Parse event
    const event = JSON.parse(req.rawBody)
    if (event.event !== 'charge.success') return res.sendStatus(200)

    const refId = event.data.reference
    const meta = event.data.metadata || {}
    const userId = meta.userId

    // 3) Idempotency: read our status row
    const txs = await TransactionStatus.findOne({ refId })
    if (!txs || txs.status === 'success') return res.sendStatus(200)

    // 4) Defensive verify with Paystack
    const verify = await axios.get(`${process.env.PAYSTACK_BASE_URL}/transaction/verify/${refId}`, {
        headers: { Authorization: `Bearer ${secret}` }
    })

    if (verify.data?.data?.status === 'success') {
        // 5) Mark success then credit wallet (once)
        await TransactionStatus.updateOne({ refId, status: 'pending' }, { $set: { status: 'success' } })

        // credit: amount is kobo
        const amountNaira = verify.data.data.amount / 100
        await Wallet.updateOne({ userId }, { $inc: { balance: amountNaira } })

        // 6) Persist visible transaction history (type MUST be 'funding')
        await logTransaction({
            userId,
            refId,
            type: 'funding',             // matches your enum
            service: 'Paystack',
            amount: amountNaira,
            status: 'success',
            response: verify.data.data
        }) // uses your helper to write into Transaction collection :contentReference[oaicite:13]{index=13}
    } else {
        await TransactionStatus.updateOne(
            { refId },
            { $set: { status: 'failed', errorMessage: 'Paystack verify returned non-success' } }
        )
    }

    res.sendStatus(200)
}

module.exports = {
    payment,
    webhook
}