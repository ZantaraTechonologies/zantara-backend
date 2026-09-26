const mongoose = require('mongoose')

const NEW_TRANSACTION_ID = /^ZNT-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;
const NEW_INTERNAL_REFERENCE = /^ZNT-R-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/;
const NEW_PROVIDER_REFERENCE = /^ZNT-P-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/;
const VTPASS_PROVIDER_REFERENCE = /^\d{12}[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;

const fulfillmentItemSchema = new mongoose.Schema({
    code: { type: String, required: true },
    serial: { type: String, default: null },
}, { _id: false });

const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    transactionId: {
        type: String,
        immutable: true,
        required() { return this.isNew; },
        validate: {
            validator(value) {
                return !this.isNew || !String(value || '').startsWith('ZNT-') || NEW_TRANSACTION_ID.test(value);
            },
            message: 'Invalid Zantara transaction identifier'
        }
    },
    refId: {
        type: String,
        immutable: true,
        validate: {
            validator(value) {
                return !this.isNew || !String(value || '').startsWith('ZNT-R-') || NEW_INTERNAL_REFERENCE.test(value);
            },
            message: 'Invalid Zantara internal reference'
        }
    },
    providerRequestId: {
        type: String,
        immutable: true,
        validate: {
            validator(value) {
                if (!this.isNew || value == null) return true;
                if (String(value).startsWith('ZNT-P-')) return NEW_PROVIDER_REFERENCE.test(value);
                return this.providerAdapterType !== 'vtpass' || VTPASS_PROVIDER_REFERENCE.test(value);
            },
            message: 'Invalid provider request identifier'
        }
    },
    providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider' },
    providerAdapterType: { type: String, enum: ['vtpass', 'vas2nets', 'universal'] },
    providerConfigSnapshot: {
        baseUrl: String,
        publicKey: String,
        metadata: mongoose.Schema.Types.Mixed,
    },
    // Values remain encrypted exactly as stored on Provider and are excluded
    // from normal query results.
    providerCredentialSnapshot: { type: mongoose.Schema.Types.Mixed, select: false },
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
    providerOfferId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProviderOffer' },
    providerOutcome: {
        type: String,
        enum: ['success', 'definitive_failure', 'pending', 'unknown'],
        default: 'unknown'
    },
    dispatchState: {
        type: String,
        enum: ['not_dispatched', 'dispatching', 'dispatched'],
        default: 'not_dispatched'
    },
    providerEvidence: { type: mongoose.Schema.Types.Mixed },
    fulfillment: {
        items: { type: [fulfillmentItemSchema], default: undefined },
        expectedQuantity: { type: Number, default: 0 },
        itemCount: { type: Number, default: 0 },
        complete: { type: Boolean, default: false },
    },
    lastProviderResponseAt: { type: Date },
    lastRequeryAt: { type: Date },
    resolutionState: {
        type: String,
        enum: ['unresolved', 'finalizing', 'resolved'],
        default: 'unresolved'
    },
    resolutionError: { type: String },
    resolvedAt: { type: Date },
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
}, { timestamps: true, autoIndex: false })

// Financial identity indexes are installed and verified by the explicit
// transaction-identifier migration, never implicitly during application startup.
transactionSchema.index({ transactionId: 1 }, { unique: true, name: 'transactionId_1' });
transactionSchema.index(
    { refId: 1 },
    {
        unique: true,
        // Historical transfer sides intentionally shared references. The new
        // namespace is disjoint and can be enforced without rewriting history.
        partialFilterExpression: { refId: { $gte: 'ZNT-R-', $lt: 'ZNT-R.' } },
        name: 'refId_1_unique_partial'
    }
);
transactionSchema.index(
    { providerRequestId: 1 },
    {
        unique: true,
        partialFilterExpression: { providerRequestId: { $type: 'string' } },
        name: 'providerRequestId_1_unique_partial'
    }
);

const transactionModel = mongoose.model('Transaction', transactionSchema)

module.exports = transactionModel
