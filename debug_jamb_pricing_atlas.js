require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
    try {
        const uri = process.env.MONGO_URI;
        console.log('Connecting to Atlas...');
        await mongoose.connect(uri);
        console.log('Connected to MongoDB');

        const ServiceIdentity = mongoose.model('ServiceIdentity', new mongoose.Schema({}, { strict: false }), 'serviceidentities');
        const Service = mongoose.model('Service', new mongoose.Schema({}, { strict: false }), 'services');
        const ProviderOffer = mongoose.model('ProviderOffer', new mongoose.Schema({}, { strict: false }), 'provideroffers');
        const PricingRule = mongoose.model('PricingRule', new mongoose.Schema({}, { strict: false }), 'pricingrules');

        const identity = await ServiceIdentity.findOne({ slug: 'jambpinvending' });
        console.log('Identity:', JSON.stringify(identity, null, 2));

        const service = await Service.findOne({ 
            $or: [
                { code: 'jambpinvending' }, 
                { identityId: identity?._id },
                { code: 'jamb' }
            ] 
        });
        console.log('Service:', JSON.stringify(service, null, 2));

        if (service) {
            const offers = await ProviderOffer.find({ serviceId: service._id });
            console.log('Offers:', JSON.stringify(offers, null, 2));

            const rules = await PricingRule.find({ 
                $or: [
                    { targetId: service._id },
                    { targetId: service.identityId },
                    { targetType: 'global' }
                ]
            });
            console.log('Rules:', JSON.stringify(rules, null, 2));
        } else {
            console.log('No service found for jambpinvending or jamb');
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error('Error:', err);
    }
}

run();
