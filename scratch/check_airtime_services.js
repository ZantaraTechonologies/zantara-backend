const mongoose = require('mongoose');
const Service = require('../models/Service');
require('dotenv').config();

async function checkAirtimeServices() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const services = await Service.find({ category: 'airtime' });
        console.log('Airtime Services:');
        services.forEach(s => {
            console.log(`- Name: ${s.name}, Code: ${s.code}, IdentityId: ${s.identityId}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkAirtimeServices();
