const Wallet = require('../models/Wallet')

const { logTransaction } = require('../utils/transaction')
// We can use a simple timestamp ref or import generator if available
const generateRef = () => 'MAN-' + Date.now() + Math.floor(Math.random() * 1000)

const walletService = require('../services/wallet.service')

const getWallet = async (req, res) => {
    const wallet = await Wallet.findOne({ userId: req.user.id })
    res.json(wallet)
}

const debitWallet = async (req, res) => {
    try {
        const userId = req.user.id
        const amount = Number(req.body.amount)
        const refId = 'MAN-' + Date.now()
        
        await walletService.debit(userId, amount, refId, 'admin_debit')

        res.json({ message: 'Wallet debited successfully', refId })
    } catch (err) {
        res.status(400).json({ error: err.message })
    }
}

const creditWallet = async (req, res) => {
    try {
        const userId = req.user.id
        const amount = Number(req.body.amount)
        const refId = 'MAN-' + Date.now()

        await walletService.credit(userId, amount, refId, 'admin_credit')

        res.json({ message: 'Wallet credited successfully', refId })
    } catch (err) {
        res.status(400).json({ error: err.message })
    }
}

const freezeWallet = async (req, res) => {
    res.json("Wallet Freeze")
}

const unfreezeWallet = async (req, res) => {
    res.json("Wallet UnFreeze")
}


module.exports = {
    getWallet,
    debitWallet,
    creditWallet,
    freezeWallet,
    unfreezeWallet
}