const mongoose = require('mongoose')

const serviceSchema = new mongoose.Schema({
    name: String,
    code: String, // Zantara Universal Code (e.g., MTN_DATA_1GB)
    providerCode: String, // Vendor-specific Code (e.g., mtn-100mb)
    category: { type: String, enum: ['airtime', 'data', 'tv', 'electricity', 'pin'] },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCategory', default: null },
    typeId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceType', default: null },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', default: null },
    identityId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceIdentity', default: null },
    inputSchema: { type: Object, default: {} },
    fulfillmentMode: { type: String, enum: ['sync', 'async', 'manual'], default: 'sync' },
    price: Number, // Selling price
    resellerPrice: Number,
    costPrice: Number, // Cost from the provider
    suggestedRetailPrice: Number, // Reference price for marketing (Market Price)
    provider: { type: String, default: 'VTPass' },
    status: { type: Boolean, default: true }
})

const serviceModel = mongoose.model('Service', serviceSchema)

module.exports = serviceModel
