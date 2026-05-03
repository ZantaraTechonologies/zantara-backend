const mongoose = require('mongoose')

const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    transactionId: { type: String, unique: true }, // Added for professional FT... IDs
    refId: { type: String },
    type: { type: String, enum: ['funding', 'airtime', 'data', 'tv', 'cable', 'electricity', 'pin', 'withdrawal', 'transfer_out', 'transfer_in', 'referral_redeem', 'referral_bonus', 'settlement', 'expense', 'share_purchase', 'share_exit', 'dividend_credit', 'dividend_reinvest', 'dividend_redeem', 'dividend_withdrawal'] },
    service: { type: String }, // e.g., MTN, GOTV, NEPA
    status: { type: String, enum: ['pending', 'success', 'failed', 'reversed'] },
    amount: { type: Number },
    costPrice: { type: Number, default: 0 }, // Authoritative cost (estimated before success, actual after)
    estimatedCostPrice: { type: Number, default: 0 },
    actualCostPrice: { type: Number, default: 0 },
    salePrice: { type: Number, default: 0 },
    profit: { type: Number, default: 0 }, // Authoritative profit (estimated before success, actual after)
    estimatedProfit: { type: Number, default: 0 },
    actualProfit: { type: Number, default: 0 },
    vendorCommission: { type: Number, default: 0 },
    providerUnitPrice: { type: Number, default: 0 },
    convenienceFee: { type: Number, default: 0 },
    accountingSource: { type: String, enum: ['estimated', 'actual'], default: 'estimated' },
    provider: { type: String },
    providerRef: { type: String },
    isLoss: { type: Boolean, default: false },
    details: { type: Object },
    response: { type: Object },
    commission: { type: Number }, // Referral commission paid out
    agentPrice: { type: Number },
    userRole: { type: String },
    netProfitAfterCommission: { type: Number, default: 0 },
    pricingSnapshot: {
        serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
        providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider' },
        providerOfferId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProviderOffer' },
        baseCostPrice: Number,
        rawSalePrice: Number, // Pre-rounded
        salePrice: Number,    // Final rounded
        retailPrice: Number,  // Reference/standard price for comparison
        savings: Number,      // retailPrice - salePrice (agent discount benefit)
        profit: Number,
        appliedPricingRuleId: { type: mongoose.Schema.Types.ObjectId, ref: 'PricingRule' },
        markupType: String,
        markupValue: Number,
        userRole: String
    },
    commissionVersion: { type: String, default: 'v1' }
}, { timestamps: true })

const transactionModel = mongoose.model('Transaction', transactionSchema)

module.exports = transactionModel