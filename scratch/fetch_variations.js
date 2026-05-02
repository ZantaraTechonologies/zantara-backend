const mongoose = require('mongoose');
const providerService = require('../services/provider.service');
require('dotenv').config();

async function run() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const servicesToCheck = ['waec-registration', 'jamb', 'waec'];
        
        for (const sId of servicesToCheck) {
            console.log(`\nVariations for ${sId}:`);
            const res = await providerService.fetchVariations(sId, 'vtpass');
            if (res.success) {
                res.variations.forEach(v => {
                    console.log(`- ${v.name}: ${v.variationCode} (₦${v.amount})`);
                });
            } else {
                console.log(`Error: ${res.message}`);
            }
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error('Error:', err);
    }
}

run();
