const mongoose = require('mongoose')

const serviceSchema = new mongoose.Schema({
    name: String,
    code: String, // Zantara Universal Code (e.g., MTN_DATA_1GB)
    providerCode: String, // Vendor-specific Code (e.g., mtn-100mb)
    category: { type: String, enum: ['airtime', 'data', 'tv', 'electricity', 'pin'] },
    price: Number, // Selling price
    resellerPrice: Number,
    costPrice: Number, // Cost from the provider
    provider: { type: String, default: 'VTPass' },
    status: { type: Boolean, default: true }
})

const serviceModel = mongoose.model('Service', serviceSchema)

module.exports = serviceModel
