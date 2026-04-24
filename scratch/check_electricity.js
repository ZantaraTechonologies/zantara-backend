const mongoose = require('mongoose');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
require('dotenv').config();

async function checkElectricityServices() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const services = await Service.find({ category: 'electricity' }).populate('identityId');
        console.log('Electricity Services:');
        services.forEach(s => {
            console.log(`- Name: ${s.name}, Code: ${s.code}, Identity: ${s.identityId?.name}, IdentityCode: ${s.identityId?.providerCode}, ProviderCode: ${s.providerCode}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkElectricityServices();
