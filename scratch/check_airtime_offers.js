const mongoose = require('mongoose');
const ProviderOffer = require('../models/ProviderOffer');
const Service = require('../models/Service');
require('dotenv').config();

async function checkAirtimeOffers() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const airtimeService = await Service.findOne({ category: 'airtime' });
        if (!airtimeService) {
            console.log('Airtime service not found');
            return;
        }

        const offers = await ProviderOffer.find({ serviceId: airtimeService._id });
        console.log('Airtime Offers:');
        offers.forEach(o => {
            console.log(`- Provider: ${o.provider}, CostPrice: ${o.costPrice}, ProviderCode: ${o.providerCode}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkAirtimeOffers();
