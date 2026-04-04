const mongoose = require('mongoose')

const serviceSchema = new mongoose.Schema({
    name: String,
    code: String,
    category: { type: String, enum: ['airtime', 'data', 'tv', 'electricity', 'pin'] },
    price: Number,
    resellerPrice: Number,
    costPrice: Number,
    provider: String,
    status: { type: Boolean, default: true }
})

const serviceModel = mongoose.model('Service', serviceSchema)

module.exports = serviceModel
