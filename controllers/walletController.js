const Wallet = require('../models/Wallet')

const { logTransaction } = require('../utils/transaction')
// We can use a simple timestamp ref or import generator if available
const generateRef = () => 'MAN-' + Date.now() + Math.floor(Math.random() * 1000)

const getWallet = async (req, res) => {
    const wallet = await Wallet.findOne({ userId: req.user.id })
    res.json(wallet)
}

const debitWallet = async (req, res) => {
    try {
        const wallet = await Wallet.findOne({ userId: req.user.id })
        const amount = Number(req.body.amount)
        await wallet.debit(amount)

        await logTransaction({
            userId: req.user.id,
            refId: generateRef(),
            type: 'withdrawal', // Admin debit treated as withdrawal
            service: 'admin_debit',
            amount: amount,
            status: 'success',
            response: { message: 'Admin debit' }
        })

        res.json({ message: 'Wallet debited', balance: wallet.balance })
    } catch (err) {
        res.status(400).json({ error: err.message })
    }
}

const creditWallet = async (req, res) => {
    const wallet = await Wallet.findOne({ userId: req.user.id })
    const amount = Number(req.body.amount)
    await wallet.credit(amount)

    await logTransaction({
        userId: req.user.id,
        refId: generateRef(),
        type: 'funding', // Admin credit treated as funding
        service: 'admin_credit',
        amount: amount,
        status: 'success',
        response: { message: 'Admin credit' }
    })

    res.json({ message: 'Wallet credited', balance: wallet.balance })
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