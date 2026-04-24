const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');

const backendPath = 'c:\\Users\\dahir\\Documents\\data_selling_app\\vtu-backend';
dotenv.config({ path: path.join(backendPath, '.env') });

const Service = require(path.join(backendPath, 'models', 'Service'));
const ServiceIdentity = require(path.join(backendPath, 'models', 'ServiceIdentity'));
const PricingRule = require(path.join(backendPath, 'models', 'PricingRule'));
const ProviderOffer = require(path.join(backendPath, 'models', 'ProviderOffer'));

async function debugJambPricing() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const service = await Service.findOne({ code: 'jambpinvending' }).populate('identityId');
        if (!service) {
            console.log('Service "jambpinvending" not found');
            return;
        }

        console.log('\n--- Service: jambpinvending ---');
        console.log(JSON.stringify({
            id: service._id,
            name: service.name,
            code: service.code,
            identity: service.identityId ? {
                name: service.identityId.name,
                slug: service.identityId.slug,
                category: service.identityId.category
            } : 'None'
        }, null, 2));

        const offers = await ProviderOffer.find({ serviceId: service._id }).populate('providerId');
        console.log(`\n--- Provider Offers (${offers.length}) ---`);
        offers.forEach(o => {
            console.log(JSON.stringify({
                provider: o.providerId.name,
                costPrice: o.costPrice,
                status: o.status
            }, null, 2));
        });

        // Check Pricing Rules
        const rules = await PricingRule.find({
            $or: [
                { targetType: 'service', targetId: service._id },
                { targetType: 'identity', targetId: service.identityId ? service.identityId._id : null },
                { targetType: 'global' }
            ],
            status: true
        });

        console.log(`\n--- Applicable Pricing Rules (${rules.length}) ---`);
        rules.forEach(r => {
            console.log(JSON.stringify({
                targetType: r.targetType,
                userRole: r.userRole,
                markupType: r.markupType,
                markupValue: r.markupValue,
                priority: r.priority
            }, null, 2));
        });

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}

debugJambPricing();
