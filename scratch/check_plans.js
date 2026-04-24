const mongoose = require('mongoose');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
require('dotenv').config();

async function checkPlans() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const plans = await Service.find().populate('identityId');
        plans.forEach(p => {
            console.log(`Plan: ${p.name}, Code: ${p.code}, Price: ${p.price}, Identity: ${p.identityId?.name}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkPlans();
