const mongoose = require('mongoose');
const ServiceIdentity = require('../models/ServiceIdentity');
require('dotenv').config();

async function checkAllIdentities() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const ids = await ServiceIdentity.find({});
        console.log('Service Identities:');
        ids.forEach(i => {
            console.log(`- Name: ${i.name}, Slug: ${i.slug}, TypeID: ${i.typeId}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkAllIdentities();
