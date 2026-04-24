const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/vtu-app';

async function check() {
    try {
        await mongoose.connect(MONGO_URI);
        
        const Service = mongoose.model('Service', new mongoose.Schema({}, { strict: false }));
        const services = await Service.find({ name: /UTME/i });
        console.log('--- JAMB Services ---');
        services.forEach(s => {
            console.log(`Name: ${s.get('name')}, Code: ${s.get('code')}, ProviderCode: ${s.get('providerCode')}, ID: ${s._id}`);
        });

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}
check();
