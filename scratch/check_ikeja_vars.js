const mongoose = require('mongoose');
const providerService = require('../services/provider.service');
require('dotenv').config();

async function checkVariations() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const res = await providerService.fetchVariations('ikeja-electric', 'VTPass');
        console.log('Ikeja Electric Variations:', JSON.stringify(res, null, 2));

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkVariations();
