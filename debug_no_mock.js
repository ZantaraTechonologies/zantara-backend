require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const Service = mongoose.model('Service', new mongoose.Schema({}, { strict: false }), 'services');
        const ProviderOffer = mongoose.model('ProviderOffer', new mongoose.Schema({}, { strict: false }), 'provideroffers');
        const PricingRule = mongoose.model('PricingRule', new mongoose.Schema({}, { strict: false }), 'pricingrules');

        const service = await Service.findOne({ code: 'UTME-NO-MOCK' });
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
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}

run();
