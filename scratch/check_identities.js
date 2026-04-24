const mongoose = require('mongoose');
const ServiceIdentity = require('../models/ServiceIdentity');
const ServiceType = require('../models/ServiceType');
require('dotenv').config();

async function checkIdentities() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const identities = await ServiceIdentity.find().populate('typeId');
        identities.forEach(i => {
            console.log(`Identity: ${i.name}, Type: ${i.typeId?.name || 'MISSING'}, TypeSlug: ${i.typeId?.slug || 'MISSING'}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkIdentities();
