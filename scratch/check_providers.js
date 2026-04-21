const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Provider = require('../models/Provider');

async function check() {
    await mongoose.connect(process.env.MONGO_URI);
    const providers = await Provider.find();
    console.log(JSON.stringify(providers, null, 2));
    process.exit(0);
}

check();
