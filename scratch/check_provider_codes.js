const mongoose = require('mongoose');
const ProviderOffer = require('../models/ProviderOffer');
const Service = require('../models/Service');
require('dotenv').config();

async function checkOffers() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const offers = await ProviderOffer.find().populate('serviceId');
        offers.forEach(o => {
            console.log(`Plan: ${o.serviceId?.name}, ServiceCode: ${o.serviceId?.code}, ProviderCode: ${o.providerCode}, Cost: ${o.costPrice}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkOffers();
