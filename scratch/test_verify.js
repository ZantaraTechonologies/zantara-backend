const mongoose = require('mongoose');
const providerService = require('../services/provider.service');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
require('dotenv').config();

async function testVerification() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        // Mock data for Ikeja Electric
        const billersCode = '1010101010101'; // Common test meter number
        const serviceID = 'ikeja-electric';
        
        console.log('--- Testing Prepaid Verification ---');
        const resPrepaid = await providerService.verifyMerchant({ billersCode, serviceID, type: 'prepaid' }, 'VTPass');
        console.log('Prepaid Result:', JSON.stringify(resPrepaid, null, 2));

        console.log('\n--- Testing Postpaid Verification ---');
        const resPostpaid = await providerService.verifyMerchant({ billersCode, serviceID, type: 'postpaid' }, 'VTPass');
        console.log('Postpaid Result:', JSON.stringify(resPostpaid, null, 2));

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

testVerification();
