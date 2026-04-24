const mongoose = require('mongoose');
const ServiceCategory = require('../models/ServiceCategory');
require('dotenv').config();

async function checkCategories() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const cats = await ServiceCategory.find({});
        console.log('Service Categories:');
        cats.forEach(c => {
            console.log(`- Name: ${c.name}, Slug: ${c.slug}, Status: ${c.status}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkCategories();
