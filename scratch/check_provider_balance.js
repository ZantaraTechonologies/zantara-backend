const mongoose = require('mongoose');
const providerService = require('../services/provider.service');
require('dotenv').config();

async function checkBalance() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const res = await providerService.getAdapterInstance('VTPass');
        const balance = await res.checkBalance();
        console.log('VTPass Balance:', JSON.stringify(balance, null, 2));

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkBalance();
