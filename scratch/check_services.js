const mongoose = require('mongoose');
const Service = require('../models/Service');
require('dotenv').config();

async function checkServices() {
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/vtu-app');
        console.log('Connected to MongoDB');

        const services = await Service.find({ category: 'pin' });
        console.log(`Found ${services.length} pin services:`);
        
        services.forEach(s => {
            console.log(`- Name: ${s.name}`);
            console.log(`  Code: ${s.code}`);
            console.log(`  ProviderCode: ${s.providerCode}`);
            console.log(`  ServiceID: ${s.identityId}`); // This might be an ID
            console.log('---');
        });

        await mongoose.disconnect();
    } catch (err) {
        console.error('Error:', err);
    }
}

checkServices();
