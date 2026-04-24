const mongoose = require('mongoose');
const Service = require('../models/Service');
require('dotenv').config();

async function checkAirtimeServiceDetails() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const service = await Service.findOne({ code: 'MTN-AIRTIME' });
        if (service) {
            console.log('Service Details:');
            console.log(JSON.stringify(service, null, 2));
        } else {
            console.log('Service not found');
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkAirtimeServiceDetails();
