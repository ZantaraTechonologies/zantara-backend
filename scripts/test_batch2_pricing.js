const mongoose = require('mongoose');
require('dotenv').config();

const Service = require('../models/Service');
const PricingRule = require('../models/PricingRule');
const ProviderOffer = require('../models/ProviderOffer');
const pricingEngine = require('../services/pricing.service');

async function testPricing() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB.');

        // 1. Pick a sample service
        const service = await Service.findOne({ code: 'MTN_DATA_1GB' });
        if (!service) throw new Error('Test service not found');
        console.log(`Testing Service: ${service.name} (${service.code})`);

        // 2. Get provider offer
        const offer = await ProviderOffer.findOne({ serviceId: service._id });
        if (!offer) throw new Error('Provider offer not found');
        console.log(`Provider Cost: ${offer.costPrice}`);

        // 3. Create a Custom Rule for this Service (Percentage markup)
        // Cleanup existing test rules
        await PricingRule.deleteMany({ targetId: service._id });
        
        console.log('\n--- Test 1: Percentage Markup (5.5%) with Whole Naira Rounding ---');
        const rulePercent = await PricingRule.create({
            targetType: 'service',
            targetId: service._id,
            userRole: 'all',
            markupType: 'percent',
            markupValue: 5.5, // 260 * 1.055 = 274.3 -> Should round to 274
            status: true,
            priority: 10
        });

        const result1 = await pricingEngine.resolvePricing({ role: 'user' }, service, offer, 300);
        console.log('Result:', result1);
        if (result1.salePrice === 274) {
            console.log('✅ Success: 274.3 rounded to 274');
        } else {
            console.error('❌ Failed: Expected 274');
        }

        console.log('\n--- Test 2: Fixed Markup (N50.7) with Whole Naira Rounding ---');
        await PricingRule.deleteMany({ targetId: service._id });
        const ruleFixed = await PricingRule.create({
            targetType: 'service',
            targetId: service._id,
            userRole: 'all',
            markupType: 'fixed',
            markupValue: 50.7, // 260 + 50.7 = 310.7 -> Should round to 311
            status: true,
            priority: 10
        });

        const result2 = await pricingEngine.resolvePricing({ role: 'user' }, service, offer, 300);
        console.log('Result:', result2);
        if (result2.salePrice === 311) {
            console.log('✅ Success: 310.7 rounded to 311');
        } else {
            console.error('❌ Failed: Expected 311');
        }

        console.log('\n--- Test 3: Profit Safety (Markup resulting in <= 0 profit) ---');
        await PricingRule.deleteMany({ targetId: service._id });
        // Use a very low markup or negative
        const ruleSafe = await PricingRule.create({
            targetType: 'service',
            targetId: service._id,
            userRole: 'all',
            markupType: 'fixed',
            markupValue: -5, // 260 - 5 = 255. Profit = -5.
            status: true,
            priority: 10
        });

        const result3 = await pricingEngine.resolvePricing({ role: 'user' }, service, offer, 300);
        console.log('Engine Result:', result3);
        const profit = result3.salePrice - offer.costPrice;
        if (profit <= 0) {
            console.log('✅ Engine correctly returned profit <= 0');
        }

        // Cleanup
        await PricingRule.deleteMany({ targetId: service._id });
        
        console.log('\nAll tests completed.');
        process.exit(0);
    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

testPricing();
