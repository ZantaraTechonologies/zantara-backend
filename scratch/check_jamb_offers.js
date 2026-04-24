const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/vtu-app';

async function check() {
    try {
        await mongoose.connect(MONGO_URI);
        
        const Provider = mongoose.model('Provider', new mongoose.Schema({}, { strict: false }));
        const ServiceIdentity = mongoose.model('ServiceIdentity', new mongoose.Schema({}, { strict: false }));
        const Service = mongoose.model('Service', new mongoose.Schema({}, { strict: false }));
        const ProviderOffer = mongoose.model('ProviderOffer', new mongoose.Schema({}, { strict: false }));

        const identity = await ServiceIdentity.findOne({ slug: 'jambpinvending' });
        if (!identity) {
             console.log('JAMB identity not found');
             return;
        }

        const service = await Service.findOne({ identityId: identity._id });
        if (!service) {
            console.log('Service not found');
            return;
        }
        
        const offers = await ProviderOffer.find({ serviceId: service._id }).populate('providerId');
        
        console.log('--- Provider Offers for JAMB ---');
        offers.forEach(o => {
            console.log(`Provider: ${o.providerId ? o.providerId.name : 'Unknown'}, Cost: ${o.costPrice}, Status: ${o.status}`);
        });

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}
check();
