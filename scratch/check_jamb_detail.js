const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/vtu-app';

async function check() {
    try {
        await mongoose.connect(MONGO_URI);
        
        const ServiceIdentity = mongoose.model('ServiceIdentity', new mongoose.Schema({}, { strict: false }));
        const identity = await ServiceIdentity.findOne({ slug: 'jambpinvending' });
        if (!identity) {
             console.log('JAMB identity not found by slug "jambpinvending"');
             const all = await ServiceIdentity.find({});
             console.log('Available slugs:', all.map(i => i.get('slug')));
             return;
        }
        console.log('JAMB Identity ID:', identity._id);

        const Service = mongoose.model('Service', new mongoose.Schema({}, { strict: false }));
        const service = await Service.findOne({ identityId: identity._id });
        if (!service) {
            console.log('No service found for this identity');
            return;
        }
        console.log('Service ID:', service._id);

        const ProviderOffer = mongoose.model('ProviderOffer', new mongoose.Schema({}, { strict: false }));
        const offer = await ProviderOffer.findOne({ serviceId: service._id, status: true });
        console.log('Active Offer Cost:', offer ? offer.get('costPrice') : 'NONE');

        const PricingRule = mongoose.model('PricingRule', new mongoose.Schema({}, { strict: false }));
        const rules = await PricingRule.find({
            $or: [
                { targetId: identity._id },
                { targetId: service._id },
                { targetType: 'global' }
            ]
        });
        console.log('\n--- Relevant Pricing Rules ---');
        rules.forEach(r => {
            console.log(JSON.stringify(r, null, 2));
        });

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}
check();
