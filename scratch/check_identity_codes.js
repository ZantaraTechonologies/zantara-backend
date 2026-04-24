const mongoose = require('mongoose');
const ServiceIdentity = require('../models/ServiceIdentity');
require('dotenv').config();

async function checkIdentityCodes() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const identities = await ServiceIdentity.find();
        identities.forEach(i => {
            console.log(`Identity: ${i.name}, InternalCode: ${i.internalCode}, Slug: ${i.slug}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkIdentityCodes();
