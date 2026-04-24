const mongoose = require('mongoose');

async function run() {
    try {
        await mongoose.connect('mongodb://localhost:27017/vtu-app');
        console.log('Connected to MongoDB');

        const ServiceIdentity = mongoose.model('ServiceIdentity', new mongoose.Schema({}, { strict: false }), 'serviceidentities');
        
        const allIdentities = await ServiceIdentity.find({});
        console.log('All Identities Slugs:', allIdentities.map(i => i.slug));

        const jambIdentity = allIdentities.find(i => i.slug?.includes('jamb'));
        console.log('JAMB Identity:', JSON.stringify(jambIdentity, null, 2));

        await mongoose.disconnect();
    } catch (err) {
        console.error('Error:', err);
    }
}

run();
