const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Service = require('../models/Service');
const ProviderOffer = require('../models/ProviderOffer');

async function search() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        const query = "mtn_100mb_1d";

        // Search in Service model (Internal SKU)
        const services = await Service.find({ code: query }).populate('identityId');
        if (services.length > 0) {
            console.log("\n--- FOUND IN SERVICES (Internal SKU) ---");
            services.forEach(s => {
                console.log(`ID: ${s._id}`);
                console.log(`Name: ${s.name}`);
                console.log(`Internal Code: ${s.code}`);
                console.log(`Identity: ${s.identityId?.name || 'Unknown'}`);
            });
        }

        // Search in ProviderOffer model (Provider SKU Mapping)
        const offers = await ProviderOffer.find({ providerCode: query }).populate('serviceId');
        if (offers.length > 0) {
            console.log("\n--- FOUND IN PROVIDER OFFERS (Mapping) ---");
            offers.forEach(o => {
                console.log(`ID: ${o._id}`);
                console.log(`Internal Plan: ${o.serviceId?.name} (${o.serviceId?.code})`);
                console.log(`Provider Code: ${o.providerCode}`);
            });
        }

        if (services.length === 0 && offers.length === 0) {
            console.log("\nNo results found for " + query);
        }

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

search();
