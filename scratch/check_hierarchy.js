const mongoose = require('mongoose');
const ServiceType = require('../models/ServiceType');
const ServiceCategory = require('../models/ServiceCategory');
require('dotenv').config();

async function checkHierarchy() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        console.log('\n--- Service Types ---');
        const types = await ServiceType.find();
        types.forEach(t => {
            console.log(`Name: ${t.name}, Slug: ${t.slug}, Status: ${t.status}`);
        });

        console.log('\n--- Service Categories ---');
        const cats = await ServiceCategory.find();
        cats.forEach(c => {
            console.log(`Name: ${c.name}, Slug: ${c.slug}, Status: ${c.status}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkHierarchy();
