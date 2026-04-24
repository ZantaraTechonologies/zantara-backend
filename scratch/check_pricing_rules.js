const mongoose = require('mongoose');
const PricingRule = require('../models/PricingRule');
require('dotenv').config();

async function checkPricingRules() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const rules = await PricingRule.find({});
        console.log('Pricing Rules:');
        rules.forEach(r => {
            console.log(`- Target: ${r.targetType}, ID: ${r.targetId}, Role: ${r.userRole}, Markup: ${r.markupValue}${r.markupType}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkPricingRules();
