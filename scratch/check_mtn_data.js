const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');

async function search() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        // Find the identity for MTN Data first
        const identity = await ServiceIdentity.findOne({ name: /MTN/i, name: /Data/i });
        if (!identity) {
            console.log("Could not find MTN Data identity");
            return;
        }
        console.log(`\nFound Identity: ${identity.name} (${identity._id})`);

        // Find all plans for this identity
        const plans = await Service.find({ identityId: identity._id });
        console.log(`\n--- ALL PLANS UNDER ${identity.name} ---`);
        plans.forEach(p => {
            console.log(`- Name: ${p.name}`);
            console.log(`  Internal Code: ${p.code}`);
            console.log(`  Provider Code: ${p.providerCode || 'NOT SET'}`);
            console.log('-------------------');
        });

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

search();
