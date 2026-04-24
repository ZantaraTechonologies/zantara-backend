const mongoose = require('mongoose');
const ServiceType = require('../models/ServiceType');
require('dotenv').config();

async function checkServiceTypes() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const types = await ServiceType.find({});
        console.log('Service Types:');
        types.forEach(t => {
            console.log(`- Name: ${t.name}, Slug: ${t.slug}, Status: ${t.status}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkServiceTypes();
