const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/vtu-app';

async function check() {
    try {
        await mongoose.connect(MONGO_URI);
        
        const ServiceIdentity = mongoose.model('ServiceIdentity', new mongoose.Schema({}, { strict: false }));
        const Service = mongoose.model('Service', new mongoose.Schema({}, { strict: false }));
        const ProviderOffer = mongoose.model('ProviderOffer', new mongoose.Schema({}, { strict: false }));

        const identities = await ServiceIdentity.find({ slug: /jamb/i });
        console.log('--- JAMB Identities ---');
        for (const id of identities) {
            console.log(`Name: ${id.get('name')}, Slug: ${id.get('slug')}, ID: ${id._id}`);
            const services = await Service.find({ identityId: id._id });
            for (const s of services) {
                console.log(`  Service Name: ${s.get('name')}, ID: ${s._id}`);
                const offers = await ProviderOffer.find({ serviceId: s._id, status: true });
                for (const o of offers) {
                    console.log(`    Offer Cost: ${o.get('costPrice')}`);
                }
            }
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}
check();
