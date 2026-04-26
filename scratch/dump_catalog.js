const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');

async function search() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        const identities = await ServiceIdentity.find();
        
        for (const identity of identities) {
            console.log(`\n==========================================`);
            console.log(`Identity: ${identity.name} (${identity._id})`);
            console.log(`Provider Service ID: ${identity.providerCode || 'NONE'}`);
            
            const plans = await Service.find({ identityId: identity._id });
            if (plans.length === 0) {
                console.log(`  (No plans found)`);
            } else {
                plans.forEach(p => {
                    console.log(`  - ${p.name}`);
                    console.log(`    SKU: ${p.code}`);
                    console.log(`    Provider Mapping: ${p.providerCode || 'MISSING'}`);
                });
            }
        }

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

search();
