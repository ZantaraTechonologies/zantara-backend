const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Service = require('../models/Service');

async function check() {
    await mongoose.connect(process.env.MONGO_URI);
    const services = await Service.find();
    console.log(`Found ${services.length} services.`);
    if (services.length > 0) {
        console.log(JSON.stringify(services.slice(0, 3), null, 2));
    }
    process.exit(0);
}

check();
