const mongoose = require('mongoose');
const providerService = require('../services/provider.service');
const { generateVTPassRequestId } = require('../utils/generateID');
require('dotenv').config();

async function testPurchase() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const request_id = generateVTPassRequestId();
        const billersCode = '1010101010101';
        const serviceID = 'ikeja-electric';
        const phone = '08012345678';
        const amount = 500;

        console.log('--- Testing Postpaid Purchase ---');
        const res = await providerService.purchaseElectricity({
            request_id,
            serviceID,
            billersCode,
            variation_code: 'postpaid',
            amount,
            phone
        }, 'VTPass');
        
        console.log('Purchase Result:', JSON.stringify(res, null, 2));

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

testPurchase();
