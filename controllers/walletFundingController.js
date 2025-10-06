// controllers/walletFundingController.js (new)
const { initializePayment } = require('../utils/paystack')
const TransactionStatus = require('../models/TransactionStatus')

const fundWallet = async (req, res) => {
    try {
        const { amount, channels } = req.body
        const userId = req.user.id
        const reference = `WALLET_${userId}_${Date.now()}`

        // Record "pending" for idempotency & polling
        await TransactionStatus.create({ refId: reference, type: 'funding', status: 'pending' }) // unique refId
        // (model has unique refId + status enum) :contentReference[oaicite:9]{index=9}

        const init = await initializePayment(req.user.email, amount, { userId, refId: reference }, reference, channels)
        res.json({ authorization_url: init.data.authorization_url, reference: reference })
    } catch (err) {
        res.status(500).json({ error: 'Paystack init failed: ' + err.message })
    }
}

// controllers/walletFundingController.js (append)
const verifyFunding = async (req, res) => {
    const { reference } = req.query
    const row = await TransactionStatus.findOne({ refId: reference })
    res.json({ status: row?.status || 'not_found' })
}


module.exports = {
    fundWallet,
    verifyFunding
}
