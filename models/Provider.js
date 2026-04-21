const mongoose = require('mongoose');

const providerSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true, 
        unique: true,
        trim: true
    },
    adapterType: {
        type: String,
        enum: ['vtpass', 'vas2nets', 'universal'],
        default: 'vtpass'
    },
    baseUrl: { 
        type: String, 
        required: true 
    },
    apiKey: { 
        type: String, 
        required: true 
    },
    secretKey: { 
        type: String 
    },
    publicKey: { 
        type: String 
    },
    status: { 
        type: String, 
        enum: ['active', 'inactive', 'maintenance'], 
        default: 'active' 
    },
    balance: { 
        type: Number, 
        default: 0 
    },
    lastBalanceCheck: { 
        type: Date 
    },
    metadata: {
        type: Map,
        of: String
    }
}, { timestamps: true });

module.exports = mongoose.model('Provider', providerSchema);
