const mongoose = require('mongoose');
const ProviderOffer = require('../models/ProviderOffer');
const Service = require('../models/Service');
const Provider = require('../models/Provider');
require('dotenv').config();

async function checkOffers() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const offers = await ProviderOffer.find().populate('serviceId');
        offers.forEach(o => {
            console.log(`Offer for: ${o.serviceId?.name}, Cost: ${o.costPrice}, Provider: ${o.providerId}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkOffers();
