const mongoose = require('mongoose');
const ServiceIdentity = require('../models/ServiceIdentity');
const ServiceType = require('../models/ServiceType');
require('dotenv').config();

async function checkAirtimeIdentities() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const airtimeType = await ServiceType.findOne({ slug: 'airtime' });
        if (!airtimeType) {
            console.log('Airtime type not found');
            return;
        }

        const identities = await ServiceIdentity.find({ typeId: airtimeType._id });
        console.log('Airtime Identities:');
        identities.forEach(i => {
            console.log(`- Name: ${i.name}, Slug: ${i.slug}, ProviderCode: ${i.providerCode}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkAirtimeIdentities();
