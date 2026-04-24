const mongoose = require('mongoose');
require('dotenv').config();

const purchaseService = require('../services/purchase.service');
const User = require('../models/User');

async function testFallback() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB.');

        // 1. Pick a user
        const user = await User.findOne({ role: 'user' });
        if (!user) throw new Error('User not found');

        // 2. Mock a purchase call with a service code that does NOT exist in the Service model
        // We won't actually call the provider, we just want to see if it passes the pricing stage
        const type = 'airtime';
        const serviceId = 'NON_EXISTENT_SERVICE_CODE';
        const amount = 100;
        const pin = '111111'; // Assuming this is set for test user

        console.log(`\n--- Test: Legacy Fallback for service "${serviceId}" ---`);
        
        // We'll wrap the call to see where it fails (it should fail at wallet check or PIN check, but it should at least pass the pricing engine without throwing)
        try {
            await purchaseService.processPurchase(user._id, {
                type,
                serviceId,
                amount,
                details: {},
                providerCall: () => ({ success: true }),
                pin
            });
        } catch (err) {
            console.log('Processed Result:', err.message);
            if (err.message.includes('Cost: 98, Sale: 100') || err.message.includes('PIN')) {
                console.log('✅ Fallback logic active (calculated cost/sale via legacy utils)');
            } else {
                console.log('Result message:', err.message);
            }
        }

        process.exit(0);
    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

testFallback();
